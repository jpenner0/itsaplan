import { useTranslations } from 'next-intl';
import type { ImportViolation, MarkdownImportPreview } from '../utils/markdownFolderImport';
import DocumentMarkdownImportTree from './DocumentMarkdownImportTree';

export default function DocumentMarkdownImportPreview({
  preview,
}: {
  preview: MarkdownImportPreview;
}) {
  const t = useTranslations('documents');
  const violation = (item: ImportViolation) => {
    switch (item.kind) {
      case 'zipSize':
        return t('importZipTooLarge');
      case 'pageCount':
        return t('importTooManyPages', { count: item.count });
      case 'pageLength':
        return t('importPageTooLong', { path: item.path });
      case 'invalidUtf8':
        return t('importInvalidUtf8', { path: item.path });
    }
  };

  return (
    <div className="grid gap-3 text-sm">
      {preview.violations.length > 0 && (
        <ul
          className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-destructive"
          role="alert"
        >
          {preview.violations.map((item, index) => (
            <li key={index} dir="auto">
              {violation(item)}
            </li>
          ))}
        </ul>
      )}
      {preview.pageCount === 0 && preview.violations.length === 0 && (
        <p className="text-muted-foreground">{t('importNothing')}</p>
      )}
      {preview.pageCount > 0 && (
        <>
          <p className="text-muted-foreground">
            {t('importSummary', { pages: preview.pageCount, assets: preview.assetCount })}
          </p>
          <div className="max-h-56 overflow-y-auto rounded-md border p-2">
            <DocumentMarkdownImportTree nodes={preview.tree} />
          </div>
        </>
      )}
      {preview.skipped.length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">
            {t('importSkipped', { count: preview.skipped.length })}
          </summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto" dir="ltr">
            {preview.skipped.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
