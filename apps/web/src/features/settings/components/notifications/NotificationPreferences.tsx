import { type ReactNode } from 'react';
import { Mail, MessagesSquare, Send } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import SettingsSection from '@/components/common/page/SettingsSection';
import NotificationTelegramAccount from './NotificationTelegramAccount';
import NotificationTeamsAccount from './NotificationTeamsAccount';
import { NOTIFICATION_EVENTS } from '../../utils/notificationEvents';
import type { NotificationPreferencesForm } from '../../hooks/useNotificationPreferencesForm';
import { useTranslations } from 'next-intl';

// A member's own notification preferences for the project: for each issue event, a
// checkbox per channel (email, Telegram). Visible to every member (each edits only
// their own). Email is sent to the account address; Telegram to the account connected
// in the member's profile, shown below. Delivery only happens for channels a project
// owner has configured. Save lives in the page header.

// Shared column templates so the header labels line up with every event row. The Teams
// column exists only while the project's team has turned Teams on.
const COLS = 'grid grid-cols-[1fr_5rem_5rem] items-center';
const COLS_WITH_TEAMS = 'grid grid-cols-[1fr_5rem_5rem_5rem] items-center';

export default function NotificationPreferences({ form }: { form: NotificationPreferencesForm }) {
  const t = useTranslations('settings.notifications');
  const { emailEvents, setEmailEvents, telegramEvents, setTelegramEvents } = form;
  const { teamsEvents, setTeamsEvents, teamsEnabled } = form;
  const cols = teamsEnabled ? COLS_WITH_TEAMS : COLS;
  return (
    <div className="flex flex-col gap-10">
      <SettingsSection title={t('eventsTitle')}>
        <div className="max-w-xl">
          <div className={`${cols} px-3 pb-1`}>
            <span />
            <ChannelHeader icon={<Mail className="size-3.5" />} label={t('email')} />
            <ChannelHeader icon={<Send className="size-3.5" />} label={t('telegram')} />
            {teamsEnabled && (
              <ChannelHeader icon={<MessagesSquare className="size-3.5" />} label={t('teams')} />
            )}
          </div>
          <div className="flex flex-col">
            {NOTIFICATION_EVENTS.map((event) => (
              <ChannelRow
                key={event}
                label={t(`events.${event}`)}
                emailChecked={emailEvents[event]}
                telegramChecked={telegramEvents[event]}
                teamsChecked={teamsEnabled ? teamsEvents[event] : undefined}
                cols={cols}
                onEmail={(v) => setEmailEvents({ ...emailEvents, [event]: v })}
                onTelegram={(v) => setTelegramEvents({ ...telegramEvents, [event]: v })}
                onTeams={(v) => setTeamsEvents({ ...teamsEvents, [event]: v })}
              />
            ))}
          </div>
        </div>
      </SettingsSection>

      <NotificationTelegramAccount />
      {teamsEnabled && <NotificationTeamsAccount />}
    </div>
  );
}

function ChannelHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground">
      {icon}
      {label}
    </span>
  );
}

function ChannelRow({
  label,
  emailChecked,
  telegramChecked,
  teamsChecked,
  cols,
  onEmail,
  onTelegram,
  onTeams,
}: {
  label: string;
  emailChecked: boolean;
  telegramChecked: boolean;
  // Undefined while the team has not turned Teams on.
  teamsChecked: boolean | undefined;
  cols: string;
  onEmail: (value: boolean) => void;
  onTelegram: (value: boolean) => void;
  onTeams: (value: boolean) => void;
}) {
  return (
    <div className={`${cols} -mx-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent`}>
      <span className="text-sm">{label}</span>
      <div className="flex justify-center">
        <Checkbox
          checked={emailChecked}
          onCheckedChange={(v) => onEmail(v === true)}
          aria-label={`${label} — email`}
        />
      </div>
      <div className="flex justify-center">
        <Checkbox
          checked={telegramChecked}
          onCheckedChange={(v) => onTelegram(v === true)}
          aria-label={`${label} — Telegram`}
        />
      </div>
      {teamsChecked !== undefined && (
        <div className="flex justify-center">
          <Checkbox
            checked={teamsChecked}
            onCheckedChange={(v) => onTeams(v === true)}
            aria-label={`${label} — Teams`}
          />
        </div>
      )}
    </div>
  );
}
