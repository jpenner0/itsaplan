import { randomUUID } from 'node:crypto';
import { db, documentAsset, project, projectDocument, team } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import {
  assertAttachmentStorageCapacity,
  assertAttachmentUploadAllowed,
  attachmentObjectKey,
  deleteAttachmentObject,
  lockAttachmentStorage,
  safeAttachmentFilename,
  storeAttachmentObject,
} from '#modules/attachments/storage';
import { teamRef } from '#modules/teams/ref';
import {
  MARKDOWN_IMPORT_LIMITS,
  MARKDOWN_IMPORT_MAX_DEPTH,
  parseMarkdownZip,
  rewriteMarkdownReferences,
  type MarkdownImportPage,
} from './markdown-import';
import { documentMentionHandles, fanOutTextMentions } from './mentions';
import {
  assertActive,
  assertUnlocked,
  assertValidParent,
  DOCUMENT_TREE_LOCK_NAMESPACE,
  documentAssetPath,
  lockDocumentActor,
  MAX_DOCUMENT_METADATA_BYTES,
  nextPosition,
  selectDocument,
  summaryOf,
  type DocumentSummaryRow,
  type Executor,
} from './service';

interface PlannedPage {
  id: number;
  parentId: number | null;
  page: MarkdownImportPage;
  metadata: Record<string, unknown>;
}

interface PlannedAsset {
  path: string;
  publicId: string;
  documentId: number;
  s3Key: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function importMarkdownZip(input: {
  projectId: number;
  userId: string;
  parentId: number | null;
  bytes: Uint8Array;
}): Promise<{ documents: DocumentSummaryRow[]; createdCount: number; skipped: string[] }> {
  const { projectId, userId, parentId } = input;
  const parent = await assertImportParent(db, projectId, parentId, userId);
  const maxDepth = MARKDOWN_IMPORT_MAX_DEPTH - parent.depth;
  if (maxDepth < 1) {
    throw new HttpError(400, 'The parent page is nested too deep to import pages below it.');
  }
  const plan = parseMarkdownZip(input.bytes, { maxDepth });
  if (plan.pages.length === 0) throw new HttpError(400, 'The ZIP file has no Markdown files.');

  const pages = await planPages(plan.pages, parentId);
  const assetsByPath = new Map(plan.assets.map((asset) => [asset.path, asset]));
  const assets: PlannedAsset[] = [];
  for (const { id, page } of pages) {
    for (const reference of page.references) {
      if (reference.kind !== 'asset') continue;
      const asset = assetsByPath.get(reference.path)!;
      const filename = safeAttachmentFilename(asset.filename);
      assets.push({
        path: asset.path,
        publicId: randomUUID(),
        documentId: id,
        s3Key: attachmentObjectKey(projectId, 'documents', id, filename),
        filename,
        contentType: Bun.file(filename).type,
        bytes: asset.bytes,
      });
    }
  }
  // A file is copied once per page that references it, so the copies are bounded as a whole.
  const totalBytes = assets.reduce((total, asset) => total + asset.bytes.length, 0);
  if (totalBytes > MARKDOWN_IMPORT_LIMITS.uncompressedBytes) {
    throw new HttpError(413, 'The files the pages reference are larger than 200 MB in total.');
  }
  const contents = await rewritePages(projectId, pages, assets);

  const uploaded: string[] = [];
  let roots: DocumentSummaryRow[];
  try {
    for (const asset of assets) {
      await assertAttachmentUploadAllowed(projectId, asset.bytes.length, asset.contentType).catch(
        (error: unknown) => {
          if (!(error instanceof HttpError)) throw error;
          throw new HttpError(error.status, `"${asset.path}": ${error.message}`);
        },
      );
      await storeAttachmentObject(asset.s3Key, Buffer.from(asset.bytes), asset.contentType);
      uploaded.push(asset.s3Key);
    }
    roots = await db.transaction(async (tx) => {
      await lockAttachmentStorage(tx, projectId);
      await lockDocumentActor(tx, userId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(${DOCUMENT_TREE_LOCK_NAMESPACE}, ${projectId})`,
      );
      const { depth, isPrivate } = await assertImportParent(tx, projectId, parentId, userId);
      if (depth !== parent.depth) {
        throw new HttpError(409, 'The parent page moved elsewhere. Start the import again.');
      }
      await assertAttachmentStorageCapacity(projectId, totalBytes, 0, tx);
      const firstPosition = await nextPosition(tx, projectId, parentId);
      const siblingIndex = new Map<number | null, number>();
      const rows = await tx
        .insert(projectDocument)
        .values(
          pages.map(({ id, parentId: pageParentId, page, metadata }, index) => {
            const position = siblingIndex.get(pageParentId) ?? 0;
            siblingIndex.set(pageParentId, position + 1);
            return {
              id,
              projectId,
              parentId: pageParentId,
              title: page.title,
              content: contents[index],
              contentJson: null,
              icon: page.icon,
              metadata,
              isPrivate,
              position: (pageParentId === parentId ? firstPosition : 1024) + position * 1024,
              ownerUserId: userId,
              createdByUserId: userId,
              updatedByUserId: userId,
            };
          }),
        )
        .returning();
      if (assets.length > 0) {
        await tx.insert(documentAsset).values(
          assets.map((asset) => ({
            publicId: asset.publicId,
            documentId: asset.documentId,
            uploadedByUserId: userId,
            s3Key: asset.s3Key,
            filename: asset.filename,
            contentType: asset.contentType,
            sizeBytes: asset.bytes.length,
          })),
        );
      }
      return rows.filter((row) => row.parentId === parentId).map((row) => summaryOf(row));
    });
  } catch (error) {
    await Promise.all(uploaded.map(deleteAttachmentObject));
    throw error;
  }
  // The pages are committed: a failed notification is logged, so a retry does not import them twice.
  for (const [index, { id }] of pages.entries()) {
    await fanOutTextMentions({
      projectId,
      documentId: id,
      before: [],
      after: documentMentionHandles({ content: contents[index], contentJson: null }),
      actorUserId: userId,
    }).catch((error: unknown) => {
      console.error(`[planner] mention notifications for imported document ${id} failed:`, error);
    });
  }
  return { documents: roots, createdCount: pages.length, skipped: plan.skipped };
}

// The parent must be a visible, active and unlocked page of the project.
async function assertImportParent(
  executor: Executor,
  projectId: number,
  parentId: number | null,
  userId: string,
): Promise<{ depth: number; isPrivate: boolean }> {
  if (parentId === null) return { depth: 0, isPrivate: false };
  const parent = await selectDocument(executor, projectId, parentId, userId);
  if (!parent) throw new HttpError(404, 'Parent document not found');
  assertActive(parent);
  assertUnlocked(parent);
  const depth = await assertValidParent(executor, projectId, null, parentId, userId);
  return { depth, isPrivate: parent.isPrivate };
}

// Flattens the tree depth-first, so a parent is inserted before its children. The ids are taken
// from the sequence first: the object keys and the rewritten links need them before the insert.
async function planPages(
  roots: MarkdownImportPage[],
  parentId: number | null,
): Promise<PlannedPage[]> {
  const flat: Array<{ page: MarkdownImportPage; parentIndex: number | null }> = [];
  const visit = (page: MarkdownImportPage, parentIndex: number | null) => {
    const index = flat.push({ page, parentIndex }) - 1;
    for (const child of page.children) visit(child, index);
  };
  for (const root of roots) visit(root, null);

  const ids = await db.execute<{ id: number }>(
    sql`select nextval(pg_get_serial_sequence('project_document', 'id'))::int as id from generate_series(1, ${flat.length})`,
  );
  return flat.map(({ page, parentIndex }, index) => ({
    id: ids[index].id,
    parentId: parentIndex === null ? parentId : ids[parentIndex].id,
    page,
    metadata: pageMetadata(page),
  }));
}

function pageMetadata(page: MarkdownImportPage): Record<string, unknown> {
  if (Object.keys(page.frontmatter).length === 0) return {};
  const metadata = { frontmatter: page.frontmatter };
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_DOCUMENT_METADATA_BYTES) {
    throw new HttpError(
      413,
      `The frontmatter of "${page.sourcePath}" is larger than ${MAX_DOCUMENT_METADATA_BYTES} bytes.`,
    );
  }
  return metadata;
}

// Rewrites each page's local references to the imported pages and to its own asset copies.
async function rewritePages(
  projectId: number,
  pages: PlannedPage[],
  assets: PlannedAsset[],
): Promise<string[]> {
  const [target] = await db
    .select({ teamId: team.id, teamSlug: team.slug, key: project.key })
    .from(project)
    .innerJoin(team, eq(team.id, project.teamId))
    .where(eq(project.id, projectId));
  // The same path the web app shows in the address bar for a page.
  const projectPath = `/${encodeURIComponent(teamRef({ id: target.teamId, slug: target.teamSlug }))}/${encodeURIComponent(target.key)}`;
  const pageUrls = new Map<string, string>();
  for (const { id, page } of pages) {
    if (page.sourcePath !== null) pageUrls.set(page.sourcePath, `${projectPath}/docs/${id}`);
  }

  return pages.map(({ id, page }) => {
    if (page.sourcePath === null) return page.content;
    const urls = new Map<string, string>();
    for (const reference of page.references) {
      if (reference.kind === 'page') urls.set(reference.path, pageUrls.get(reference.path)!);
    }
    for (const asset of assets) {
      if (asset.documentId !== id) continue;
      // The web serves a page's files through its own route.
      const url = documentAssetPath({ teamId: target.teamId, key: target.key }, id, asset.publicId);
      urls.set(asset.path, `/protected-media${url}`);
    }
    const content = rewriteMarkdownReferences(page.content, page.sourcePath, urls);
    if (content.length > MARKDOWN_IMPORT_LIMITS.pageChars) {
      throw new HttpError(
        413,
        `"${page.sourcePath}" has more than ${MARKDOWN_IMPORT_LIMITS.pageChars} characters after its links are rewritten.`,
      );
    }
    return content;
  });
}
