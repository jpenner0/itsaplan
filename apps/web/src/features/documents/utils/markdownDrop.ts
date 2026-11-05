import type { PickedFile } from './markdownFolderImport';

const readEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

async function collect(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: entry.fullPath.replace(/^\//, ''), file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most one batch per call, so read until it is empty.
  for (let batch = await readEntries(reader); batch.length > 0; batch = await readEntries(reader)) {
    for (const child of batch) await collect(child, out);
  }
}

// Reads the dropped folders and files. Entries must be taken from `items` synchronously, before
// the first await, because the browser clears the DataTransfer afterwards.
export async function droppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  const entries = [...transfer.items].flatMap((item) => item.webkitGetAsEntry() ?? []);
  const out: PickedFile[] = [];
  for (const entry of entries) await collect(entry, out);
  return out;
}
