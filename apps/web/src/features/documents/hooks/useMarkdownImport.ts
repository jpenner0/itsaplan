import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useImportMarkdownDocuments } from '../services/documents.service';
import {
  packMarkdownImport,
  previewMarkdownImport,
  readMarkdownZip,
  type MarkdownImportPreview,
  type PickedFile,
} from '../utils/markdownFolderImport';

interface Selection {
  files: PickedFile[];
  preview: MarkdownImportPreview;
}

const isZip = (file: File) => /\.zip$/i.test(file.name);

export function useMarkdownImport({
  projectKey,
  parentId,
  onImported,
}: {
  projectKey: string;
  parentId: number | null;
  onImported: () => void;
}) {
  const t = useTranslations('documents');
  const importer = useImportMarkdownDocuments(projectKey);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ZIP is unpacked in the browser. One that is too large arrives without files and with its
  // own violation. Anything else is the files of a folder, with its root name already removed.
  const choose = async (picked: PickedFile[]) => {
    setReading(true);
    setError(null);
    setSelection(null);
    try {
      const zipFile = picked.length === 1 && isZip(picked[0].file) ? picked[0].file : null;
      const { files, violations } = zipFile
        ? await readMarkdownZip(zipFile)
        : { files: picked, violations: [] };
      const preview =
        violations.length > 0
          ? { tree: [], pageCount: 0, assetCount: 0, skipped: [], violations }
          : await previewMarkdownImport(files);
      setSelection({ files, preview });
    } catch {
      setError(t('importReadFailed'));
    } finally {
      setReading(false);
    }
  };

  const reset = () => {
    setSelection(null);
    setError(null);
  };

  const submit = async () => {
    if (!selection) return;
    setError(null);
    try {
      const zip = await packMarkdownImport(selection.files);
      const result = await importer.mutateAsync({
        file: new File([zip], 'import.zip', { type: 'application/zip' }),
        parentId,
      });
      toast.success(t('importDone', { count: result.createdCount }));
      reset();
      onImported();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('importReadFailed'));
    }
  };

  const { preview } = selection ?? {};
  return {
    preview: preview ?? null,
    reading,
    error,
    pending: importer.isPending,
    canImport:
      preview != null &&
      preview.violations.length === 0 &&
      preview.pageCount > 0 &&
      !importer.isPending,
    choose,
    reset,
    submit,
  };
}
