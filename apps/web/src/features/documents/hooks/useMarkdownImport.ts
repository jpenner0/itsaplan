import { useRef, useState } from 'react';
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
  const [submitting, setSubmitting] = useState(false);
  // The state is not updated until the next render, so a second click needs the ref.
  const submitLock = useRef(false);
  // A result is dropped when a newer choose or a reset started after it.
  const generation = useRef(0);

  // A ZIP is unpacked in the browser. One that is too large arrives without files and with its
  // own violation. Anything else is the files of a folder, with its root name already removed.
  const choose = async (picked: PickedFile[]) => {
    const current = ++generation.current;
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
      if (current === generation.current) setSelection({ files, preview });
    } catch {
      if (current === generation.current) setError(t('importReadFailed'));
    } finally {
      if (current === generation.current) setReading(false);
    }
  };

  const reset = () => {
    generation.current += 1;
    setReading(false);
    setSelection(null);
    setError(null);
  };

  const submit = async () => {
    if (!selection || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
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
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const { preview } = selection ?? {};
  return {
    preview: preview ?? null,
    reading,
    error,
    pending: submitting,
    canImport:
      preview != null && preview.violations.length === 0 && preview.pageCount > 0 && !submitting,
    choose,
    reset,
    submit,
  };
}
