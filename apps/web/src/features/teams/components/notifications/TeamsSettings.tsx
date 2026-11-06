import SettingsSection from '@/components/common/page/SettingsSection';
import EnabledSwitch from '@/components/common/inputs/EnabledSwitch';
import type { TeamsForm } from '../../hooks/useTeamsForm';
import { useTranslations } from 'next-intl';

// The team only decides whether its projects deliver to Microsoft Teams. Each member
// connects their own Workflows webhook in their account settings.
export default function TeamsSettings({ form }: { form: TeamsForm }) {
  const t = useTranslations('teams.notifications');
  return (
    <SettingsSection
      title={t('teamsTitle')}
      description={t('teamsHint')}
      action={<EnabledSwitch checked={form.enabled} onChange={form.setEnabled} />}
    />
  );
}
