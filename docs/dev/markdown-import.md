# Markdown import into Docs

`POST /projects/:projectKey/documents/import` takes a multipart `file` (a ZIP) and an optional
`parentId`, and answers 201 with the created top-level pages and the `skipped` paths. The user
guide is [importing-markdown-into-docs.md](../importing-markdown-into-docs.md).

The import runs synchronously in the api request. There is no worker job.

| File                                          | What it holds                                                |
| --------------------------------------------- | ------------------------------------------------------------ |
| `apps/api/src/modules/documents/markdown-import.ts`         | the ZIP parser: limits, page tree, frontmatter, references |
| `apps/api/src/modules/documents/markdown-import-service.ts` | parent check, uploads, the transaction                     |
| `apps/web/src/features/documents/utils/markdownFolderImport.ts` | the preview, which mirrors the parser's rules |

## Order of work

1. The parent is checked: visible, active, unlocked. Its depth sets `maxDepth` for the parser,
   `MARKDOWN_IMPORT_MAX_DEPTH` minus the parent's depth.
2. The parser reads the ZIP. Its errors name the file.
3. The page ids are taken from the `project_document` id sequence before the insert. The object
   keys and the rewritten page links need them, so the uploads can run before the transaction
   opens and the transaction stays short. A failed import leaves a gap in the ids.
4. Each referenced file is uploaded once per page that references it, because a
   `document_asset` row and its URL belong to one page. The copies together may not exceed the
   parser's 200 MB unpacked limit, which is checked before the first upload.
5. One transaction takes the locks in the global order (attachment storage, actor, Docs tree
   advisory lock), checks the parent again, checks the storage quota for all files together, and
   inserts all pages and asset rows.
6. If anything fails after the first upload, every uploaded object is deleted (best-effort,
   logged) and the error is rethrown.

The `project_document` and `document_asset` triggers move the `documents:<projectId>` scope once
per row, inside the one transaction, so clients see one change and refetch the tree once.
Mention notifications run per page after the commit, as `createDocument` does.

The route's guard is `['documents', 'edit']`, and the handler also asserts
`['documents', 'create']`, because the import creates pages and uploads page files.
