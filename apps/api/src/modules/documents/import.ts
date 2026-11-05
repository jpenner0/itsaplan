import { randomUUID } from 'node:crypto';
import { db, documentAsset, projectDocument } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import {
  assertAttachmentFileAllowed,
  assertAttachmentStorageCapacity,
  attachmentObjectKey,
  deleteAttachmentObject,
  lockAttachmentStorage,
  safeAttachmentFilename,
  storeAttachmentObject,
} from '#modules/attachments/storage';
import {
  MAX_IMPORT_DEPTH,
  MAX_PAGE_CHARS,
  readMarkdownZip,
  rewriteReferences,
  type ImportFile,
  type ImportPage,
} from './markdown-import';
import {
  assertValidMetadata,
  assertValidParent,
  documentAssetPath,
  DOCUMENT_TREE_LOCK_NAMESPACE,
  lockDocumentActor,
  nextPosition,
  summaryOf,
  type DocumentSummaryRow,
  type Executor,
} from './service';

export interface DocumentImportResult {
  pages: DocumentSummaryRow[];
  skipped: string[];
}

interface PlannedPage {
  id: number;
  parentId: number | null;
  depth: number;
  position: number;
  source: ImportPage;
}

interface PlannedAsset {
  documentId: number;
  publicId: string;
  s3Key: string;
  file: ImportFile;
  filename: string;
  contentType: string;
}

const POSITION_STEP = 1024;

// Creates the pages of a Markdown ZIP below `parentId`. The files are uploaded before
// the transaction, so it holds no lock during the uploads; a failure afterwards
// deletes them again. Imported text fans out no mentions: an import must not notify
// everyone a set of old notes names.
export async function importMarkdownZip(input: {
  project: { id: number; teamId: number; key: string };
  userId: string;
  parentId: number | null;
  data: Uint8Array;
}): Promise<DocumentImportResult> {
  const { project, userId, parentId } = input;
  const plan = await readMarkdownZip(input.data);
  if (plan.pages.length === 0) throw new HttpError(400, 'The ZIP file contains no Markdown files');

  const importDepth = treeDepth(plan.pages);
  await checkParent(db, project.id, parentId, userId, importDepth);

  // The ids are taken before the transaction so that the asset keys, the asset URLs
  // and the page links are known when the pages are inserted with their final content.
  const ids = await reserveDocumentIds(countPages(plan.pages));
  const pages = placePages(plan.pages, parentId, ids);

  const skipped = new Set(plan.skipped);
  const files = new Map<string, { file: ImportFile; filename: string; contentType: string }>();
  for (const file of plan.files) {
    const filename = safeAttachmentFilename(file.filename);
    const contentType = Bun.file(filename).type.split(';')[0]!;
    try {
      await assertAttachmentFileAllowed(file.bytes.byteLength, contentType);
      files.set(file.path, { file, filename, contentType });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      skipped.add(file.path);
    }
  }

  const pageUrls = new Map(
    pages.map((page) => [page.source.path, `/${project.teamId}/${project.key}/docs/${page.id}`]),
  );
  const assets: PlannedAsset[] = [];
  const rows = pages.map((page) => {
    const urls = new Map(pageUrls);
    for (const path of page.source.assetRefs) {
      const found = files.get(path);
      if (!found) continue;
      const publicId = randomUUID();
      assets.push({
        documentId: page.id,
        publicId,
        s3Key: attachmentObjectKey(project.id, 'documents', page.id, found.filename),
        ...found,
      });
      urls.set(path, `/protected-media${documentAssetPath(project, page.id, publicId)}`);
    }
    const content = rewriteReferences(page.source, urls);
    if (content.length > MAX_PAGE_CHARS) {
      throw new HttpError(
        400,
        `"${page.source.path}" exceeds the ${MAX_PAGE_CHARS.toLocaleString('en-US')} character limit after its links are rewritten`,
      );
    }
    const metadata =
      Object.keys(page.source.frontmatter).length > 0
        ? { frontmatter: page.source.frontmatter }
        : {};
    assertValidMetadata(metadata);
    // Postgres stores no NUL character in text or jsonb.
    if (hasNul([content, page.source.title, metadata])) {
      throw new HttpError(400, `"${page.source.path}" contains a NUL character`);
    }
    return { page, content, metadata };
  });

  const assetBytes = assets.reduce((sum, asset) => sum + asset.file.bytes.byteLength, 0);
  if (assets.length > 0) await assertAttachmentStorageCapacity(project.id, assetBytes);

  const uploaded: string[] = [];
  try {
    for (const asset of assets) {
      const { bytes } = asset.file;
      await storeAttachmentObject(
        asset.s3Key,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        asset.contentType,
      );
      uploaded.push(asset.s3Key);
    }
    const created = await db.transaction(async (tx) => {
      // The lock order is quota -> actor -> document tree, as in duplicateDocument.
      if (assets.length > 0) await lockAttachmentStorage(tx, project.id);
      await lockDocumentActor(tx, userId);
      await tx.execute(
        sql`select pg_advisory_xact_lock(${DOCUMENT_TREE_LOCK_NAMESPACE}, ${project.id})`,
      );
      const isPrivate = await checkParent(tx, project.id, parentId, userId, importDepth);
      if (assets.length > 0) await assertAttachmentStorageCapacity(project.id, assetBytes, 0, tx);
      const rootOffset = (await nextPosition(tx, project.id, parentId)) - POSITION_STEP;
      const inserted = await tx
        .insert(projectDocument)
        .values(
          rows.map(({ page, content, metadata }) => ({
            id: page.id,
            projectId: project.id,
            parentId: page.parentId,
            title: page.source.title,
            content,
            contentJson: null,
            icon: page.source.icon,
            metadata,
            isPrivate,
            position: page.depth === 1 ? rootOffset + page.position : page.position,
            ownerUserId: userId,
            createdByUserId: userId,
            updatedByUserId: userId,
          })),
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
            sizeBytes: asset.file.bytes.byteLength,
          })),
        );
      }
      return inserted;
    });
    const rootIds = new Set(pages.filter((page) => page.depth === 1).map((page) => page.id));
    return {
      pages: created
        .filter((row) => rootIds.has(row.id))
        .sort((a, b) => a.position - b.position)
        .map((row) => summaryOf(row)),
      skipped: [...skipped].sort(),
    };
  } catch (error) {
    await Promise.all(uploaded.map(deleteAttachmentObject));
    throw error;
  }
}

// Validates the parent and the depth the import reaches below it. Returns whether
// the imported pages are private: they follow the parent.
async function checkParent(
  executor: Executor,
  projectId: number,
  parentId: number | null,
  userId: string,
  importDepth: number,
): Promise<boolean> {
  if (parentId === null) return false;
  await assertValidParent(executor, projectId, null, parentId, userId);
  let depth = 0;
  let isPrivate = false;
  for (let cursor: number | null = parentId; cursor !== null; depth++) {
    const [row] = await executor
      .select({ parentId: projectDocument.parentId, isPrivate: projectDocument.isPrivate })
      .from(projectDocument)
      .where(eq(projectDocument.id, cursor));
    if (cursor === parentId) isPrivate = row!.isPrivate;
    cursor = row?.parentId ?? null;
  }
  if (depth + importDepth > MAX_IMPORT_DEPTH) {
    throw new HttpError(
      400,
      `The import would nest pages ${depth + importDepth} levels deep, the limit is ${MAX_IMPORT_DEPTH}`,
    );
  }
  return isPrivate;
}

async function reserveDocumentIds(count: number): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(
    sql`select nextval(pg_get_serial_sequence('project_document', 'id'))::int as id from generate_series(1, ${count})`,
  );
  return rows.map((row) => row.id);
}

// Gives every page a reserved id. A root page's position is relative to the last
// existing child of the parent; the transaction adds that offset.
function placePages(roots: ImportPage[], parentId: number | null, ids: number[]): PlannedPage[] {
  const placed: PlannedPage[] = [];
  const walk = (pages: ImportPage[], parent: number | null, depth: number) => {
    pages.forEach((source, index) => {
      const page = {
        id: ids[placed.length]!,
        parentId: parent,
        depth,
        position: (index + 1) * POSITION_STEP,
        source,
      };
      placed.push(page);
      walk(source.children, page.id, depth + 1);
    });
  };
  walk(roots, parentId, 1);
  return placed;
}

function countPages(pages: ImportPage[]): number {
  return pages.reduce((sum, page) => sum + 1 + countPages(page.children), 0);
}

function treeDepth(pages: ImportPage[]): number {
  return pages.reduce((max, page) => Math.max(max, 1 + treeDepth(page.children)), 0);
}

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => hasNul(key) || hasNul(entry));
}
