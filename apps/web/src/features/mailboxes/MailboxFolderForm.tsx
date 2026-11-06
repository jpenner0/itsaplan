'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MailboxOptions } from '@/lib/api/endpoints/mailboxes';
import { useAddFolder } from './services/mailboxes.service';

// Adds a folder to a mailbox. The team pays for the AI and only its projects are suggested;
// the agent is an internal agent of that team.
export default function MailboxFolderForm({
  mailboxId,
  options,
}: {
  mailboxId: number;
  options: MailboxOptions;
}) {
  const t = useTranslations('mailboxes');
  const add = useAddFolder();
  const [name, setName] = useState('INBOX');
  const [teamId, setTeamId] = useState('');
  const [agentId, setAgentId] = useState('');
  const team = options.teams.find((x) => String(x.id) === teamId);

  return (
    <form
      className="mt-3 space-y-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          {
            id: mailboxId,
            input: { name: name.trim(), teamId: Number(teamId), agentId: Number(agentId) },
          },
          { onSuccess: () => setAgentId('') },
        );
      }}
    >
      <p className="text-xs text-muted-foreground">{t('folderForm.privacy')}</p>
      <Input
        aria-label={t('folderForm.name')}
        placeholder={t('folderForm.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          value={teamId}
          onValueChange={(v) => {
            setTeamId(v);
            setAgentId('');
          }}
        >
          <SelectTrigger aria-label={t('folderForm.team')}>
            <SelectValue placeholder={t('folderForm.team')} />
          </SelectTrigger>
          <SelectContent>
            {options.teams.map((x) => (
              <SelectItem key={x.id} value={String(x.id)}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentId} onValueChange={setAgentId} disabled={!team}>
          <SelectTrigger aria-label={t('folderForm.agent')}>
            <SelectValue placeholder={t('folderForm.agent')} />
          </SelectTrigger>
          <SelectContent>
            {team?.agents.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {add.error && <p className="text-sm text-destructive">{add.error.message}</p>}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || !teamId || !agentId || add.isPending}
        >
          {t('folderForm.add')}
        </Button>
      </div>
    </form>
  );
}
