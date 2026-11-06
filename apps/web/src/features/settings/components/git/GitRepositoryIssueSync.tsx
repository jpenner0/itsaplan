import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { GitManagedRepository } from '@/lib/api/endpoints/git';
import SettingsRow from '@/components/common/page/SettingsRow';
import { Switch } from '@/components/ui/switch';
import { useIssueSyncErrorMessage } from '@/hooks/useIssueSyncErrorMessage';
import { useUpdateGitIssueSync } from '../../services/settings.service';

// The two-way issue sync toggles of one linked GitHub repository.
export default function GitRepositoryIssueSync({
  projectKey,
  connectionId,
  repository,
}: {
  projectKey: string;
  connectionId: number;
  repository: GitManagedRepository;
}) {
  const t = useTranslations('settings.git');
  const update = useUpdateGitIssueSync(projectKey, connectionId);
  const errorMessage = useIssueSyncErrorMessage('settingsConflict');

  function save(patch: { issuesSyncEnabled?: boolean; newIssuesToProvider?: boolean }) {
    update.mutate(
      { repositoryId: repository.id, patch },
      {
        onSuccess: () => toast.success(t('issueSyncSaved')),
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  return (
    <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/20">
      <SettingsRow
        title={t('issueSyncTitle')}
        description={repository.issuesSyncEnabled ? t('issueSyncOffHint') : t('issueSyncOnHint')}
        control={
          <Switch
            checked={repository.issuesSyncEnabled}
            disabled={update.isPending}
            onCheckedChange={(issuesSyncEnabled) => save({ issuesSyncEnabled })}
          />
        }
      />
      {repository.issuesSyncEnabled && (
        <SettingsRow
          title={t('newIssuesToGithub')}
          description={t('newIssuesToGithubHint')}
          control={
            <Switch
              checked={repository.newIssuesToProvider}
              disabled={update.isPending}
              onCheckedChange={(newIssuesToProvider) => save({ newIssuesToProvider })}
            />
          }
        />
      )}
    </div>
  );
}
