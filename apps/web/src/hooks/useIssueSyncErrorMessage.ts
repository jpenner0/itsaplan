import { useTranslations } from 'next-intl';
import { ApiError } from '@/lib/api/core/client';

// Turns a failed issue-sync request into text. `conflict` names what a 409 means on the
// screen that sent it.
export function useIssueSyncErrorMessage(conflict: 'settingsConflict' | 'publishConflict') {
  const t = useTranslations('issue.sync');
  return (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 409) return t(conflict);
      if (error.status === 502) return t('github');
      if (error.status === 503) return t('busy');
    }
    return error instanceof Error ? error.message : t('github');
  };
}
