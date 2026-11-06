'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SettingsSection from '@/components/common/page/SettingsSection';
import { useAiAgentsQuery } from '@/services/aiAgents.service';
import type { MailboxAuth, TeamMailbox } from '@/lib/api/endpoints/teamMailbox';
import { useTeamMailboxForm } from '../../hooks/useTeamMailboxForm';
import TeamMailboxDelete from './TeamMailboxDelete';
import TeamMailboxSecretFields from './TeamMailboxSecretFields';
import TeamMailboxStatus from './TeamMailboxStatus';

// Sets up, changes or removes the team mailbox. Only INBOX is read, and only mail from the
// allowed senders is triaged by the chosen agent.
export default function TeamMailboxForm({
  teamId,
  mailbox,
}: {
  teamId: number;
  mailbox: TeamMailbox | null;
}) {
  const t = useTranslations('teams.mailbox');
  const tCommon = useTranslations('common');
  const form = useTeamMailboxForm(teamId, mailbox ?? undefined);
  const agents = (useAiAgentsQuery(teamId).data ?? []).filter((a) => a.kind === 'internal');

  return (
    <form
      className="flex flex-col gap-6 sm:max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.valid) void form.save().catch(() => {});
      }}
    >
      <SettingsSection title={t('title')} description={t('privacy')}>
        {mailbox && <TeamMailboxStatus mailbox={mailbox} />}
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-auth">{t('auth')}</Label>
          <Select value={form.auth} onValueChange={(v) => form.setAuth(v as MailboxAuth)}>
            <SelectTrigger id="mailbox-auth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t('authPassword')}</SelectItem>
              <SelectItem value="microsoft365">{t('authMicrosoft')}</SelectItem>
            </SelectContent>
          </Select>
          {form.auth === 'microsoft365' && (
            <p className="text-xs text-muted-foreground">{t('authMicrosoftHint')}</p>
          )}
        </div>
        <div className="grid grid-cols-[1fr_6rem] gap-2" dir="ltr">
          <div className="space-y-1.5">
            <Label htmlFor="mailbox-host">{t('host')}</Label>
            <Input
              id="mailbox-host"
              placeholder="outlook.office365.com"
              value={form.host}
              onChange={(e) => form.setHost(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mailbox-port">{t('port')}</Label>
            <Input
              id="mailbox-port"
              inputMode="numeric"
              value={form.port}
              onChange={(e) => form.setPort(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-secure">{t('encryption')}</Label>
          <Select
            value={form.secure ? 'tls' : 'starttls'}
            onValueChange={(v) => form.setSecure(v === 'tls')}
          >
            <SelectTrigger id="mailbox-secure">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tls">{t('tls')}</SelectItem>
              <SelectItem value="starttls">{t('starttls')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-user">{t('username')}</Label>
          <Input
            id="mailbox-user"
            dir="ltr"
            value={form.username}
            onChange={(e) => form.setUsername(e.target.value)}
          />
        </div>
        <TeamMailboxSecretFields
          auth={form.auth}
          form={form}
          hasStored={mailbox?.hasSecret === true && form.auth === mailbox.auth}
        />
      </SettingsSection>

      <SettingsSection title={t('triage')}>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-agent">{t('agent')}</Label>
          <Select value={form.agentId} onValueChange={form.setAgentId}>
            <SelectTrigger id="mailbox-agent">
              <SelectValue placeholder={t('agentPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mailbox-senders">{t('allowedSenders')}</Label>
          <Textarea
            id="mailbox-senders"
            dir="ltr"
            rows={4}
            placeholder={t('allowedSendersPlaceholder')}
            value={form.senders}
            onChange={(e) => form.setSenders(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('allowedSendersHint')}</p>
        </div>
      </SettingsSection>

      {form.error && <p className="text-sm text-destructive">{form.error}</p>}

      <div className="flex justify-end gap-2">
        {mailbox && <TeamMailboxDelete teamId={teamId} />}
        <Button type="submit" disabled={!form.valid || form.saving}>
          {mailbox ? tCommon('save') : t('setUp')}
        </Button>
      </div>
    </form>
  );
}
