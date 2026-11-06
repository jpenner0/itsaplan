import { beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { db } from '@repo/db';
import { sql } from 'drizzle-orm';
import JSZip from 'jszip';
import { app, authedApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createRole } from '#tests/helpers/roles';
import { MAX_IMPORT_DEPTH, MAX_IMPORT_PAGES, MAX_PAGE_CHARS } from '../../markdown-import';

type Client = ReturnType<typeof authedApi>;

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function setupProject() {
  const owner = await signUpTestUser();
  const asOwner = authedApi(owner.cookie);
  const project = (await createProject(asOwner, { key: 'MKT', name: 'Marketing' })).data!;
  return { asOwner, owner, project };
}

async function addMember(owner: Client, permissions?: unknown) {
  const user = await signUpTestUser();
  const invite = await owner
    .projects({ projectKey: 'MKT' })
    .invites.post({ email: user.email, role: 'member' });
  const client = authedApi(user.cookie);
  await client.invites({ token: invite.data!.token }).accept.post();
  if (permissions) {
    const role = await createRole(owner, 'MKT', { name: `Role ${randomUUID()}`, permissions });
    await owner
      .projects({ projectKey: 'MKT' })
      .members({ userId: user.userId })
      .patch({ role: 'member', roleId: role.data!.id });
  }
  return client;
}

function documents(client: Client) {
  return client.projects({ projectKey: 'MKT' }).documents;
}

function importZip(client: Client, data: Uint8Array, parentId?: number) {
  return documents(client).import.post({
    file: new File([data], 'docs.zip', { type: 'application/zip' }),
    ...(parentId === undefined ? {} : { parentId }),
  });
}

async function tree(client: Client) {
  return (await documents(client).get({ query: {} })).data!;
}

async function contentOf(client: Client, documentId: number) {
  return (await documents(client)({ documentId }).get()).data!.content;
}

describe('POST /projects/:projectKey/documents/import', () => {
  beforeEach(resetDb);

  it('builds the page tree from folders, parent content and natural order', async () => {
    const { asOwner, owner } = await setupProject();
    const existing = (await documents(asOwner).post({ title: 'Existing' })).data!;
    const res = await importZip(
      asOwner,
      await zipOf({
        'Guide/index.md': 'Guide intro',
        'Guide/10-advanced.md': 'Advanced',
        'Guide/2-setup.md': 'Setup',
        'Guide/Sub/README.md': 'Sub intro',
        'Guide/Sub/page.md': 'Deep page',
        'Notes.md':
          '---\ntitle: Meeting notes\nicon: "📝"\ntags: [a, b]\n---\n# Meeting notes\n\nBody',
        'Notes/child.md': 'Child',
        'Empty/only.md': 'Only',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.data!.pages.map((page) => page.title)).toEqual(['Empty', 'Guide', 'Meeting notes']);
    expect(res.data!.skipped).toEqual([]);

    const pages = await tree(asOwner);
    expect(res.data!.createdCount).toBe(pages.length - 1);
    const byTitle = new Map(pages.map((page) => [page.title, page]));
    const childrenOf = (title: string) =>
      pages
        .filter((page) => page.parentId === byTitle.get(title)!.id)
        .sort((a, b) => a.position - b.position)
        .map((page) => page.title);

    expect(childrenOf('Guide')).toEqual(['2-setup', '10-advanced', 'Sub']);
    expect(childrenOf('Sub')).toEqual(['page']);
    expect(childrenOf('Meeting notes')).toEqual(['child']);
    expect(childrenOf('Empty')).toEqual(['only']);
    const roots = pages.filter((page) => page.parentId === null);
    expect(roots.sort((a, b) => a.position - b.position).map((page) => page.title)).toEqual([
      'Existing',
      'Empty',
      'Guide',
      'Meeting notes',
    ]);
    expect(byTitle.get('Existing')!.id).toBe(existing.id);

    expect(await contentOf(asOwner, byTitle.get('Guide')!.id)).toBe('Guide intro');
    expect(await contentOf(asOwner, byTitle.get('Sub')!.id)).toBe('Sub intro');
    expect(await contentOf(asOwner, byTitle.get('Empty')!.id)).toBe('');
    const notes = (await documents(asOwner)({ documentId: byTitle.get('Meeting notes')!.id }).get())
      .data!;
    expect(notes).toMatchObject({
      icon: '📝',
      content: 'Body',
      contentJson: null,
      metadata: { frontmatter: { tags: ['a', 'b'] } },
      isPrivate: false,
      ownerUserId: owner.userId,
      createdByUserId: owner.userId,
    });
    expect(byTitle.get('Guide')!.metadata).toEqual({});
  });

  it('uploads referenced files, rewrites references and lists what it skipped', async () => {
    const { asOwner, project } = await setupProject();
    const png = 'fake png bytes';
    const res = await importZip(
      asOwner,
      await zipOf({
        'a/page.md': [
          '![Diagram](img/pic.png)',
          '[Other](../b.md#section)',
          '[Tool](tool.exe)',
          '[Web](https://example.com/x.png)',
        ].join('\n'),
        'a/img/pic.png': png,
        'a/tool.exe': 'MZ',
        'b.md': '![Same](a/img/pic.png)',
        'unused.txt': 'nobody links me',
        '.git/config': '[core]',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.data!.skipped).toEqual(['.git/', 'a/tool.exe', 'unused.txt']);

    const pages = await tree(asOwner);
    const page = pages.find((p) => p.title === 'page')!;
    const other = pages.find((p) => p.title === 'b')!;
    const assets = (await documents(asOwner)({ documentId: page.id }).assets.get()).data!;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      filename: 'pic.png',
      contentType: 'image/png',
      sizeBytes: png.length,
    });
    const content = await contentOf(asOwner, page.id);
    expect(content).toBe(
      [
        `![Diagram](/protected-media/projects/${project.teamId}.MKT/documents/${page.id}/assets/${assets[0]!.id}/raw)`,
        `[Other](/${project.teamId}/MKT/docs/${other.id}#section)`,
        '[Tool](tool.exe)',
        '[Web](https://example.com/x.png)',
      ].join('\n'),
    );
    const raw = await documents(asOwner)({ documentId: page.id })
      .assets({ publicId: assets[0]!.id })
      .raw.get({ query: {} });
    expect(raw.status).toBe(200);
    expect(raw.data instanceof Blob ? await raw.data.text() : String(raw.data)).toBe(png);

    // A file referenced by two pages becomes an asset of each.
    const otherAssets = (await documents(asOwner)({ documentId: other.id }).assets.get()).data!;
    expect(otherAssets).toHaveLength(1);
    expect(await contentOf(asOwner, other.id)).toContain(
      `/documents/${other.id}/assets/${otherAssets[0]!.id}/raw`,
    );
  });

  it('refuses a ZIP over 50 MB with 413', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, new Uint8Array(50 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(await tree(asOwner)).toEqual([]);
  });

  it('refuses an upload by its declared length before it reads the body', async () => {
    const { owner, project } = await setupProject();
    const request = new Request(
      `http://localhost/projects/${project.teamId}.MKT/documents/import`,
      {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(60 * 1024 * 1024),
        },
        // The body never ends, so the route can only answer by refusing it unread.
        body: new ReadableStream({ pull: () => new Promise(() => {}) }),
        duplex: 'half',
      } as RequestInit,
    );
    const res = await Promise.race([app.handle(request), Bun.sleep(5000).then(() => null)]);
    expect(res?.status).toBe(413);
    expect(await res!.json()).toEqual({ error: 'The ZIP file exceeds the 50 MB limit' });
  });

  it('refuses an import whose page copies of one file exceed the unpack limit', async () => {
    const { asOwner } = await setupProject();
    // 9 copies of a 25 MB file (the default per-file limit) are 225 MB, while the ZIP
    // unpacks to about 25 MB.
    const files: Record<string, string | Uint8Array> = {
      'big.png': new Uint8Array(25 * 1024 * 1024),
    };
    for (let i = 0; i < 9; i++) files[`p${i}.md`] = '![big](big.png)';
    const res = await importZip(asOwner, await zipOf(files));
    expect(res.status).toBe(413);
    expect((res.error!.value as { error: string }).error).toBe(
      'The import would store 225 MB of files, the limit is 200 MB',
    );
    expect(await tree(asOwner)).toEqual([]);
  });

  it('refuses more pages than the limit', async () => {
    const { asOwner } = await setupProject();
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_IMPORT_PAGES; i++) files[`p${i}.md`] = 'x';
    const res = await importZip(asOwner, await zipOf(files));
    expect(res.status).toBe(400);
    expect((res.error!.value as { error: string }).error).toContain(`limit is ${MAX_IMPORT_PAGES}`);
    expect(await tree(asOwner)).toEqual([]);
  });

  it('refuses a page over the character limit, also after its links are rewritten', async () => {
    const { asOwner } = await setupProject();
    const tooLong = await importZip(
      asOwner,
      await zipOf({ 'long.md': 'x'.repeat(MAX_PAGE_CHARS + 1) }),
    );
    expect(tooLong.status).toBe(400);
    expect((tooLong.error!.value as { error: string }).error).toContain('long.md');

    const link = '[b](b.md)';
    const atLimit = await zipOf({
      'a.md': link + 'x'.repeat(MAX_PAGE_CHARS - link.length),
      'b.md': 'target',
    });
    const grown = await importZip(asOwner, atLimit);
    expect(grown.status).toBe(400);
    expect((grown.error!.value as { error: string }).error).toContain(
      '"a.md" exceeds the 250,000 character limit after its links are rewritten',
    );
    expect(await tree(asOwner)).toEqual([]);
  });

  it('adds the depth of the parent to the depth of the import', async () => {
    const { asOwner } = await setupProject();
    const parent = (await documents(asOwner).post({ title: 'Parent' })).data!;
    const path = Array.from({ length: MAX_IMPORT_DEPTH - 1 }, (_, i) => `l${i + 1}`).join('/');
    const deepest = await zipOf({ [`${path}/leaf.md`]: 'leaf' });

    const nested = await importZip(asOwner, deepest, parent.id);
    expect(nested.status).toBe(400);
    expect((nested.error!.value as { error: string }).error).toContain(
      `${MAX_IMPORT_DEPTH + 1} levels deep`,
    );
    expect(await tree(asOwner)).toHaveLength(1);

    const topLevel = await importZip(asOwner, deepest);
    expect(topLevel.status).toBe(201);
    expect(await tree(asOwner)).toHaveLength(1 + MAX_IMPORT_DEPTH);
  });

  it('names a file that is not valid UTF-8', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(
      asOwner,
      await zipOf({ 'dir/latin1.md': new Uint8Array([0x63, 0x61, 0xe9]) }),
    );
    expect(res.status).toBe(400);
    expect((res.error!.value as { error: string }).error).toContain('dir/latin1.md');
  });

  it('refuses a NUL character, which Postgres cannot store', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, await zipOf({ 'nul.md': 'a\0b' }));
    expect(res.status).toBe(400);
    expect((res.error!.value as { error: string }).error).toContain('"nul.md" contains a NUL');

    const inFrontmatter = await importZip(
      asOwner,
      await zipOf({ 'meta.md': '---\nnote: "a\\0b"\n---\nbody' }),
    );
    expect(inFrontmatter.status).toBe(400);
    expect((inFrontmatter.error!.value as { error: string }).error).toContain('"meta.md"');

    const escapeText = await importZip(asOwner, await zipOf({ 'escape.md': 'Write `\\u0000`.' }));
    expect(escapeText.status).toBe(201);
    expect(await contentOf(asOwner, escapeText.data!.pages[0]!.id)).toBe('Write `\\u0000`.');
  });

  it('refuses a ZIP without Markdown files', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, await zipOf({ 'image.png': 'png' }));
    expect(res.status).toBe(400);
    expect((res.error!.value as { error: string }).error).toBe(
      'The ZIP file contains no Markdown files',
    );
  });

  it('refuses a path that leaves the ZIP', async () => {
    const { asOwner } = await setupProject();
    const name = '../evil.md';
    const placeholder = 'x'.repeat(name.length - 3) + '.md';
    const data = Buffer.from(await zipOf({ [placeholder]: 'x' }))
      .toString('latin1')
      .replaceAll(placeholder, name);
    const res = await importZip(asOwner, new Uint8Array(Buffer.from(data, 'latin1')));
    expect(res.status).toBe(400);
    expect((res.error!.value as { error: string }).error).toContain('unsafe path');
  });

  it('creates nothing and deletes the uploaded objects when the transaction fails', async () => {
    const { asOwner, project } = await setupProject();
    const filename = `rollback-${randomUUID()}.png`;
    // A state no route can produce: the asset insert fails after every upload.
    await db.execute(sql`
      create or replace function test_fail_asset() returns trigger language plpgsql as $$
      begin raise exception 'forced asset failure'; end $$`);
    await db.execute(sql`
      create trigger test_fail_asset before insert on document_asset
      for each row execute function test_fail_asset()`);
    try {
      const res = await importZip(
        asOwner,
        await zipOf({
          'a.md': `![x](${filename})`,
          'b.md': `![x](${filename})`,
          [filename]: 'png',
        }),
      );
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql`drop trigger test_fail_asset on document_asset`);
      await db.execute(sql`drop function test_fail_asset()`);
    }
    expect(await tree(asOwner)).toEqual([]);
    expect(await objectKeys(`projects/${project.id}/documents/`, filename)).toEqual([]);
  });

  it('lets a docs editor import and refuses a reader and a non-member', async () => {
    const { asOwner } = await setupProject();
    const data = await zipOf({ 'page.md': 'x' });
    const editor = await addMember(asOwner, { documents: { read: true, edit: true } });
    const reader = await addMember(asOwner, { documents: { read: true } });
    const outsider = authedApi((await signUpTestUser()).cookie);

    expect((await importZip(editor, data)).status).toBe(201);
    expect((await importZip(reader, data)).status).toBe(403);
    expect([403, 404]).toContain((await importZip(outsider, data)).status);
    expect(await tree(asOwner)).toHaveLength(1);
  });

  it('makes pages below a private parent private', async () => {
    const { asOwner } = await setupProject();
    const editor = await addMember(asOwner, { documents: { read: true, edit: true } });
    const parent = (await documents(asOwner).post({ title: 'Private', isPrivate: true })).data!;
    await documents(asOwner).post({ title: 'Sibling', parentId: parent.id });

    const res = await importZip(
      asOwner,
      await zipOf({ 'Folder/index.md': 'a', 'Folder/child.md': 'b' }),
      parent.id,
    );
    expect(res.status).toBe(201);
    expect(res.data!.pages).toMatchObject([
      { title: 'Folder', parentId: parent.id, isPrivate: true },
    ]);
    const pages = await tree(asOwner);
    expect(pages.filter((page) => page.title !== 'Private' && page.title !== 'Sibling')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Folder', isPrivate: true }),
        expect.objectContaining({ title: 'child', isPrivate: true }),
      ]),
    );
    const sibling = pages.find((page) => page.title === 'Sibling')!;
    expect(res.data!.pages[0]!.position).toBeGreaterThan(sibling.position);

    expect((await tree(editor)).map((page) => page.title)).toEqual(['Sibling']);
    const refused = await importZip(editor, await zipOf({ 'x.md': 'x' }), parent.id);
    expect(refused.status).toBe(400);
  });

  it('moves the documents revision scope', async () => {
    const { asOwner, project } = await setupProject();
    const scope = `documents:${project.id}`;
    const rev = async () =>
      (await asOwner.sync.rev.get({ query: { scopes: scope } })).data!.revs[scope];
    const before = await rev();
    expect((await importZip(asOwner, await zipOf({ 'page.md': 'x' }))).status).toBe(201);
    expect(await rev()).not.toBe(before);
  });
});

async function objectKeys(prefix: string, suffix: string): Promise<string[]> {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  });
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, Prefix: prefix }),
  );
  return (listed.Contents ?? []).map((object) => object.Key!).filter((key) => key.endsWith(suffix));
}
