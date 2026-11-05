import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { zipSync, type Zippable } from 'fflate';
import { authedApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { clearLimits, setLimits } from '#tests/helpers/limits';
import { createRole } from '#tests/helpers/roles';
import { MARKDOWN_IMPORT_LIMITS, MARKDOWN_IMPORT_MAX_DEPTH } from '../../markdown-import';

type Client = ReturnType<typeof authedApi>;

const encoder = new TextEncoder();

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const input: Zippable = {};
  for (const [name, value] of Object.entries(files)) {
    input[name] = typeof value === 'string' ? encoder.encode(value) : value;
  }
  return zipSync(input);
}

async function setupProject() {
  await signUpTestUser();
  const owner = await signUpTestUser();
  const asOwner = authedApi(owner.cookie);
  const project = (await createProject(asOwner, { key: 'MKT', name: 'Marketing' })).data!;
  return { asOwner, owner, project };
}

async function addMember(owner: Client, roleId?: number) {
  const user = await signUpTestUser();
  const invite = await owner
    .projects({ projectKey: 'MKT' })
    .invites.post({ email: user.email, role: 'member' });
  const client = authedApi(user.cookie);
  await client.invites({ token: invite.data!.token }).accept.post();
  if (roleId != null) {
    await owner
      .projects({ projectKey: 'MKT' })
      .members({ userId: user.userId })
      .patch({ role: 'member', roleId });
  }
  return client;
}

function documents(client: Client, projectKey = 'MKT') {
  return client.projects({ projectKey }).documents;
}

function importZip(
  client: Client,
  files: Record<string, string | Uint8Array>,
  parentId?: number,
  projectKey = 'MKT',
) {
  return documents(client, projectKey).import.post({
    file: new File([zip(files)], 'docs.zip', { type: 'application/zip' }),
    ...(parentId === undefined ? {} : { parentId }),
  });
}

async function listPages(client: Client) {
  return (await documents(client).get({ query: {} })).data!;
}

async function getPage(client: Client, documentId: number) {
  return (await documents(client)({ documentId }).get()).data!;
}

async function countObjects(projectId: number): Promise<number> {
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
  });
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET,
      Prefix: `projects/${projectId}/documents/`,
    }),
  );
  return listed.KeyCount ?? 0;
}

describe('POST /projects/:projectKey/documents/import', () => {
  beforeEach(resetDb);
  afterEach(clearLimits);

  it('builds the page tree from folders with all three parent-content forms', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, {
      'guide/index.md': 'Guide intro',
      'guide/setup.md': 'Setup',
      'handbook/README.md': 'Handbook intro',
      'handbook/policy.md': 'Policy',
      'notes.md': 'Notes intro',
      'notes/today.md': 'Today',
      'plain/deep/leaf.md': 'Leaf',
    });
    expect(res.status).toBe(201);
    expect(res.data!.documents.map((page) => page.title)).toEqual([
      'guide',
      'handbook',
      'notes',
      'plain',
    ]);
    expect(res.data!.createdCount).toBe(9);

    const pages = await listPages(asOwner);
    expect(pages).toHaveLength(9);
    const byTitle = new Map(pages.map((page) => [page.title, page]));
    const childrenOf = (title: string) =>
      pages.filter((page) => page.parentId === byTitle.get(title)!.id).map((page) => page.title);
    expect(childrenOf('guide')).toEqual(['setup']);
    expect(childrenOf('handbook')).toEqual(['policy']);
    expect(childrenOf('notes')).toEqual(['today']);
    expect(childrenOf('plain')).toEqual(['deep']);
    expect(childrenOf('deep')).toEqual(['leaf']);

    expect(await getPage(asOwner, byTitle.get('guide')!.id)).toMatchObject({
      content: 'Guide intro',
      contentJson: null,
    });
    expect((await getPage(asOwner, byTitle.get('handbook')!.id)).content).toBe('Handbook intro');
    expect((await getPage(asOwner, byTitle.get('notes')!.id)).content).toBe('Notes intro');
    expect((await getPage(asOwner, byTitle.get('plain')!.id)).content).toBe('');
  });

  it('reads title and icon from frontmatter and keeps the rest in metadata', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, {
      'page.md': '---\ntitle: Launch plan\nicon: 🚀\ntags: [a, b]\n---\n# Launch plan\n\nBody',
    });
    expect(res.status).toBe(201);
    const [summary] = res.data!.documents;
    expect(summary).toMatchObject({
      title: 'Launch plan',
      icon: '🚀',
      metadata: { frontmatter: { title: 'Launch plan', tags: ['a', 'b'] } },
      isPrivate: false,
      parentId: null,
    });
    expect((await getPage(asOwner, summary.id)).content).toBe('Body');
  });

  it('rejects a frontmatter larger than the metadata limit, naming the file', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, {
      'big.md': `---\nnote: ${'x'.repeat(20_000)}\n---\nBody`,
    });
    expect(res.status).toBe(413);
    expect(res.error!.value).toMatchObject({ error: expect.stringContaining('big.md') });
    expect(await listPages(asOwner)).toHaveLength(0);
  });

  it('sorts siblings naturally', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, { '10-b.md': 'b', '2-a.md': 'a', '1-c.md': 'c' });
    expect(res.data!.documents.map((page) => page.title)).toEqual(['1-c', '2-a', '10-b']);
    expect((await listPages(asOwner)).map((page) => page.title)).toEqual(['1-c', '2-a', '10-b']);
  });

  it('uploads referenced files as page assets and rewrites the references', async () => {
    const { asOwner, project } = await setupProject();
    const objectsBefore = await countObjects(project.id);
    const res = await importZip(asOwner, {
      'a.md': '![Diagram](img/diagram.png) and [sheet](files/data.csv)',
      'b.md': '![Same](img/diagram.png)',
      'img/diagram.png': new Uint8Array([1, 2, 3, 4]),
      'files/data.csv': 'x,y',
    });
    expect(res.status).toBe(201);
    const [a, b] = res.data!.documents;

    const aAssets = (await documents(asOwner)({ documentId: a.id }).assets.get()).data!;
    expect(aAssets.map((asset) => [asset.filename, asset.contentType, asset.sizeBytes])).toEqual(
      expect.arrayContaining([
        ['diagram.png', 'image/png', 4],
        ['data.csv', expect.stringContaining('text/csv'), 3],
      ]),
    );
    const bAssets = (await documents(asOwner)({ documentId: b.id }).assets.get()).data!;
    expect(bAssets).toHaveLength(1);

    const png = aAssets.find((asset) => asset.filename === 'diagram.png')!;
    const csv = aAssets.find((asset) => asset.filename === 'data.csv')!;
    expect((await getPage(asOwner, a.id)).content).toBe(
      `![Diagram](${png.embedUrl}) and [sheet](${csv.embedUrl})`,
    );
    expect((await getPage(asOwner, b.id)).content).toBe(`![Same](${bAssets[0].embedUrl})`);
    expect(png.url).toBe(`/projects/${project.teamId}.MKT/documents/${a.id}/assets/${png.id}/raw`);
    expect(await countObjects(project.id)).toBe(objectsBefore + 3);
  });

  it('rewrites relative Markdown links to the imported pages and keeps external URLs', async () => {
    const { asOwner, project } = await setupProject();
    const res = await importZip(asOwner, {
      'docs/index.md': 'Folder page',
      'docs/a.md': '[Back](index.md) [B](../b.md#usage) [Web](https://example.com/x.md)',
      'b.md': 'B',
    });
    expect(res.status).toBe(201);
    const pages = await listPages(asOwner);
    const byTitle = new Map(pages.map((page) => [page.title, page]));
    const base = `/${project.ref.split('.')[0]}/MKT/docs`;
    expect((await getPage(asOwner, byTitle.get('a')!.id)).content).toBe(
      `[Back](${base}/${byTitle.get('docs')!.id}) [B](${base}/${byTitle.get('b')!.id}#usage) [Web](https://example.com/x.md)`,
    );
  });

  it('lists skipped files in the response', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, {
      'a.md': 'A',
      '.obsidian/app.json': '{}',
      'unused.png': new Uint8Array([1]),
    });
    expect(res.status).toBe(201);
    expect(res.data!.skipped).toEqual(['.obsidian/', 'unused.png']);
  });

  it('refuses an upload larger than 50 MB by its size before parsing it', async () => {
    const { owner } = await setupProject();
    const size = MARKDOWN_IMPORT_LIMITS.zipBytes + 128 * 1024;
    // An in-memory request carries no Content-Length; a client over HTTP sends one.
    const client = authedApi(owner.cookie, { 'content-length': String(size) });
    const res = await documents(client).import.post({
      file: new File([new Uint8Array(size)], 'docs.zip'),
    });
    expect(res.status).toBe(413);
    expect(res.error!.value).toMatchObject({ error: 'The upload is larger than 50 MB.' });
  });

  it('rejects an import with more pages than the limit', async () => {
    const { asOwner } = await setupProject();
    const files: Record<string, string> = {};
    for (let i = 0; i <= MARKDOWN_IMPORT_LIMITS.pages; i++) files[`p${i}.md`] = 'x';
    const res = await importZip(asOwner, files);
    expect(res.status).toBe(413);
    expect(await listPages(asOwner)).toHaveLength(0);
  });

  it('rejects an import whose file copies exceed the unpacked size limit before uploading', async () => {
    const { asOwner, project } = await setupProject();
    const objectsBefore = await countObjects(project.id);
    const files: Record<string, string | Uint8Array> = {
      'big.png': new Uint8Array(MARKDOWN_IMPORT_LIMITS.uncompressedBytes / 4),
    };
    for (let i = 0; i < 5; i++) files[`p${i}.md`] = '![big](big.png)';
    const res = await importZip(asOwner, files);
    expect(res.status).toBe(413);
    expect(await listPages(asOwner)).toHaveLength(0);
    expect(await countObjects(project.id)).toBe(objectsBefore);
  });

  it('rejects a file that is not valid UTF-8, naming it', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, { 'ok.md': 'fine', 'bad.md': new Uint8Array([0x80]) });
    expect(res.status).toBe(400);
    expect(res.error!.value).toMatchObject({ error: expect.stringContaining('bad.md') });
    expect(await listPages(asOwner)).toHaveLength(0);
  });

  it('rejects a path outside the folder', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, { '../evil.md': 'x' });
    expect(res.status).toBe(400);
    expect(res.error!.value).toMatchObject({ error: expect.stringContaining('../evil.md') });
  });

  it('rejects a ZIP without Markdown files', async () => {
    const { asOwner } = await setupProject();
    const res = await importZip(asOwner, { 'image.png': new Uint8Array([1]) });
    expect(res.status).toBe(400);
  });

  it('creates no pages and deletes the uploaded objects when the transaction fails', async () => {
    const { asOwner, project } = await setupProject();
    // Each file fits the quota on its own, both together do not: the check in the
    // transaction fails after both are uploaded.
    setLimits({ maxStorageBytes: 1_000 });
    const objectsBefore = await countObjects(project.id);
    const res = await importZip(asOwner, {
      'a.md': '![one](one.png) ![two](two.png)',
      'one.png': new Uint8Array(600),
      'two.png': new Uint8Array(600),
    });
    expect(res.status).toBe(413);
    expect(await listPages(asOwner)).toHaveLength(0);
    expect(await countObjects(project.id)).toBe(objectsBefore);
  });

  it('names a refused file type and deletes the files uploaded before it', async () => {
    const { asOwner, project } = await setupProject();
    const objectsBefore = await countObjects(project.id);
    const res = await importZip(asOwner, {
      'a.md': '![ok](a.png) [tool](z.exe)',
      'a.png': new Uint8Array([1]),
      'z.exe': new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    expect(res.error!.value).toMatchObject({ error: expect.stringContaining('"z.exe"') });
    expect(await listPages(asOwner)).toHaveLength(0);
    expect(await countObjects(project.id)).toBe(objectsBefore);
  });

  it('requires documents create and edit; the owner succeeds and a non-member gets 403', async () => {
    const { asOwner } = await setupProject();
    const creatorRole = await createRole(asOwner, 'MKT', {
      name: 'Creator',
      permissions: { documents: { read: true, create: true } },
    });
    const creator = await addMember(asOwner, creatorRole.data!.id);
    expect((await importZip(creator, { 'a.md': 'A' })).status).toBe(403);

    const editorRole = await createRole(asOwner, 'MKT', {
      name: 'Editor',
      permissions: { documents: { read: true, edit: true } },
    });
    const editor = await addMember(asOwner, editorRole.data!.id);
    expect((await importZip(editor, { 'a.md': 'A' })).status).toBe(403);

    const outsider = authedApi((await signUpTestUser()).cookie);
    expect((await importZip(outsider, { 'a.md': 'A' })).status).toBe(403);

    expect((await importZip(asOwner, { 'a.md': 'A' })).status).toBe(201);
    const member = await addMember(asOwner);
    expect((await importZip(member, { 'b.md': 'B' })).status).toBe(201);
  });

  it('makes the pages private under a private parent', async () => {
    const { asOwner } = await setupProject();
    const parent = (await documents(asOwner).post({ title: 'Secret', isPrivate: true })).data!;
    const res = await importZip(asOwner, { 'dir/a.md': 'A' }, parent.id);
    expect(res.status).toBe(201);
    const pages = await listPages(asOwner);
    expect(pages.filter((page) => page.id !== parent.id).map((page) => page.isPrivate)).toEqual([
      true,
      true,
    ]);
    expect(res.data!.documents[0]).toMatchObject({ parentId: parent.id, isPrivate: true });
  });

  it('rejects an archived, locked or invisible parent', async () => {
    const { asOwner } = await setupProject();
    const locked = (await documents(asOwner).post({ title: 'Locked' })).data!;
    await documents(asOwner)({ documentId: locked.id }).lock.post({ version: locked.version });
    expect((await importZip(asOwner, { 'a.md': 'A' }, locked.id)).status).toBe(409);

    const archived = (await documents(asOwner).post({ title: 'Archived' })).data!;
    await documents(asOwner)({ documentId: archived.id }).archive.post({
      version: archived.version,
    });
    expect((await importZip(asOwner, { 'a.md': 'A' }, archived.id)).status).toBe(409);

    const secret = (await documents(asOwner).post({ title: 'Secret', isPrivate: true })).data!;
    const member = await addMember(asOwner);
    expect((await importZip(member, { 'a.md': 'A' }, secret.id)).status).toBe(404);
    expect((await importZip(asOwner, { 'a.md': 'A' }, 999_999)).status).toBe(404);
  });

  it('allows only the levels left under a deep parent', async () => {
    const { asOwner } = await setupProject();
    let parentId: number | undefined;
    for (let level = 1; level < MARKDOWN_IMPORT_MAX_DEPTH; level++) {
      parentId = (await documents(asOwner).post({ title: `L${level}`, parentId })).data!.id;
    }
    expect((await importZip(asOwner, { 'dir/a.md': 'A' }, parentId)).status).toBe(400);
    expect((await importZip(asOwner, { 'a.md': 'A' }, parentId)).status).toBe(201);

    const deepest = (await documents(asOwner).post({ title: 'L10', parentId })).data!;
    expect((await importZip(asOwner, { 'a.md': 'A' }, deepest.id)).status).toBe(400);
  });

  it('places top-level pages after the existing ones', async () => {
    const { asOwner } = await setupProject();
    await documents(asOwner).post({ title: 'First' });
    await documents(asOwner).post({ title: 'Second' });
    const res = await importZip(asOwner, { 'a.md': 'A', 'b.md': 'B' });
    expect(res.status).toBe(201);
    expect((await listPages(asOwner)).map((page) => page.title)).toEqual([
      'First',
      'Second',
      'a',
      'b',
    ]);
  });
});
