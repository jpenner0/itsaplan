# Importing Markdown into Docs

A folder of Markdown files, for example an Obsidian vault or a `docs/` folder from a repository,
can be imported into a project's Docs. Each file becomes a page and each folder a parent page, so
the folder tree becomes the page tree.

## Steps

1. Open **Docs** in the project. To import at the top level, use the import entry in the Docs
   sidebar. To import below an existing page, use **Import** in that page's menu.
2. Choose a folder or a ZIP file. A folder is packed into a ZIP file in the browser.
3. The preview shows the pages that will be created, the number of files that will be uploaded,
   and the files that are skipped. **Import** creates the pages.

The import needs the permission to create and to edit Docs pages. It always creates new pages. A
page with the same title as an existing page is created next to it and does not replace it.

## How files become pages

- A `.md` file becomes a page. Its title is `title:` from the frontmatter, or the file name
  without `.md`.
- A folder becomes a parent page with the folder name as title. Its content comes from
  `index.md` or `README.md` inside the folder, or from a file with the folder's name next to it
  (`guide.md` next to `guide/`). Without one of these files, the parent page is empty.
- Pages are sorted by name in natural order: `2-setup` comes before `10-usage`.
- Frontmatter is removed from the page text and stored with the page. `icon:` sets the page icon.
- A first heading `# Title` that repeats the title is removed.
- Images and other files that a page references, such as `![Diagram](img/diagram.png)`, are
  uploaded as files of that page, and the reference points to the uploaded file. A file used by
  two pages is uploaded once for each page. The instance's file type and storage limits apply.
- Links to other `.md` files in the import, such as `[Setup](../setup.md)`, point to the new
  page. Links to web addresses stay as written. `[[Wikilinks]]` stay text.
- Pages imported below a private page are private. At the top level, pages are visible to the
  project.

## Skipped files

Hidden files and folders (names that start with a dot, such as `.git/` and `.obsidian/`),
`__MACOSX/`, and files that no page references are not imported. The preview and the result list
them.

## Limits

| Limit                | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| ZIP file size        | 50 MB                                                              |
| Total unpacked size  | 200 MB                                                             |
| Pages                | 500                                                                |
| Characters per page  | 250,000                                                            |
| Nesting depth        | 10 page levels, counted from the top level of Docs                 |
| Frontmatter per page | 16 KB                                                              |

A file that is not valid UTF-8 text stops the import with an error that names the file. Any
error stops the whole import: no page is created and no file is kept.
