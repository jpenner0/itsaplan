import type { AgentScheduleType } from '@/lib/api/endpoints/agentSchedules';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsScheduleField } from './SettingsScheduleField';
import { useTranslations } from 'next-intl';

export function SettingsScheduleTypeField({
  value,
  onChange,
}: {
  value: AgentScheduleType;
  onChange: (value: AgentScheduleType) => void;
}) {
  const t = useTranslations('settings.schedules');
  return (
    <SettingsScheduleField htmlFor="schedule-type" label={t('type')}>
      <Select value={value} onValueChange={(next) => onChange(next as AgentScheduleType)}>
        <SelectTrigger id="schedule-type" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="cron">{t('types.cron')}</SelectItem>
          <SelectItem value="status">{t('types.status')}</SelectItem>
          <SelectItem value="synced_issue_created">{t('types.synced_issue_created')}</SelectItem>
          <SelectItem value="pull_request_opened">{t('types.pull_request_opened')}</SelectItem>
        </SelectContent>
      </Select>
      {value === 'synced_issue_created' && (
        <p className="text-xs text-muted-foreground">{t('typeHints.synced_issue_created')}</p>
      )}
      {value === 'pull_request_opened' && (
        <p className="text-xs text-muted-foreground">{t('typeHints.pull_request_opened')}</p>
      )}
    </SettingsScheduleField>
  );
}
