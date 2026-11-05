import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { DevelopmentLink } from '@/lib/api/endpoints/git';
import { useIssueSyncErrorMessage } from '@/hooks/useIssueSyncErrorMessage';
import { usePublishIssue, useProjectSyncsIssues } from '@/services/issues.service';

// "Publish to GitHub": offered for an issue without a GitHub issue in a project whose
// repository syncs issues.
export function useIssuePublish(
  issueId: number,
  projectKey: string,
  links: DevelopmentLink[],
  enabled: boolean,
) {
  const t = useTranslations('issue.development');
  const errorMessage = useIssueSyncErrorMessage('publishConflict');
  const syncs = useProjectSyncsIssues(projectKey, enabled).data === true;
  const publishIssue = usePublishIssue(issueId);
  const available = enabled && syncs && !links.some((link) => link.kind === 'issue');

  function publish() {
    publishIssue.mutate(undefined, {
      onSuccess: () => toast.success(t('published')),
      onError: (error) => toast.error(errorMessage(error)),
    });
  }

  return { available, publish };
}
