'use client';

import { useRef, useState, type DragEvent } from 'react';
import { FileArchive, FolderOpen, Loader2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useMarkdownImport } from '../hooks/useMarkdownImport';
import { droppedFiles } from '../utils/markdownDrop';
import { dropCommonRoot, pickedFolderFiles } from '../utils/markdownFolderImport';
import DocumentMarkdownImportPreview from './DocumentMarkdownImportPreview';

export default function DocumentMarkdownImportDialog({
  open,
  projectKey,
  parentId,
  onOpenChange,
}: {
  open: boolean;
  projectKey: string;
  parentId: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('documents');
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const flow = useMarkdownImport({
    projectKey,
    parentId,
    onImported: () => onOpenChange(false),
  });
  const busy = flow.pending || flow.reading;

  const changeOpen = (next: boolean) => {
    if (flow.pending) return;
    if (!next) flow.reset();
    onOpenChange(next);
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    // droppedFiles takes the entries before its first await, which is where the browser clears
    // the transfer.
    void droppedFiles(event.dataTransfer).then(
      (files) => flow.choose(dropCommonRoot(files)),
      () => flow.choose([]),
    );
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={!flow.pending}
        aria-busy={busy}
        onEscapeKeyDown={(event) => {
          if (flow.pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (flow.pending) event.preventDefault();
        }}
      >
        <DialogHeader className="text-start">
          <DialogTitle>{t('importMarkdown')}</DialogTitle>
          <DialogDescription>
            {t(parentId === null ? 'importDescription' : 'importSubpagesDescription')}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            'grid place-items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center',
            dragging && 'border-primary bg-muted/50',
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <Upload className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{t('importDrop')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              <FolderOpen />
              {t('importChooseFolder')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => zipInput.current?.click()}
            >
              <FileArchive />
              {t('importChooseZip')}
            </Button>
          </div>
          <input
            ref={folderInput}
            className="sr-only"
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is not in React's input attribute types
            webkitdirectory=""
            tabIndex={-1}
            aria-label={t('importChooseFolder')}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.currentTarget.value = '';
              if (files.length > 0) void flow.choose(pickedFolderFiles(files));
            }}
          />
          <input
            ref={zipInput}
            className="sr-only"
            type="file"
            accept=".zip,application/zip"
            tabIndex={-1}
            aria-label={t('importChooseZip')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (file) void flow.choose([{ path: file.name, file }]);
            }}
          />
        </div>

        {flow.reading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t('importReading')}
          </p>
        )}

        {flow.preview && <DocumentMarkdownImportPreview preview={flow.preview} />}

        {flow.error && (
          <p
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
            dir="auto"
          >
            {flow.error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={flow.pending}
            onClick={() => changeOpen(false)}
          >
            {t('cancel')}
          </Button>
          <Button type="button" disabled={!flow.canImport} onClick={() => void flow.submit()}>
            {flow.pending ? <Loader2 className="animate-spin" /> : <Upload />}
            {flow.pending ? t('importing') : t('importAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
