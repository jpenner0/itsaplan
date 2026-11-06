'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MailInboxProject, MailItem, Priority } from '@/lib/api/endpoints/mailInbox';
import {
  useAcceptMailItem,
  useCommentMailItem,
  useRejectMailItem,
  useRetriageMailItem,
} from './services/mailInbox.service';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low'];
const NONE = 'none';

// One email with its draft. Every field of the draft can be changed before accepting. An
// email with no draft (the check failed, or it was not queued) offers "Check again", and a
// sorted-out one can still be accepted once a project is chosen.
export default function MailInboxItem({
  item,
  projects,
}: {
  item: MailItem;
  projects: MailInboxProject[];
}) {
  const t = useTranslations('mailInbox');
  const accept = useAcceptMailItem();
  const reject = useRejectMailItem();
  const comment = useCommentMailItem();
  const retriage = useRetriageMailItem();
  const draft = item.draft;
  const [projectId, setProjectId] = useState<number | null>(draft?.projectId ?? null);
  const [title, setTitle] = useState(draft?.title ?? item.subject);
  const [description, setDescription] = useState(draft?.description ?? '');
  const [labelIds, setLabelIds] = useState<number[]>(draft?.labelIds ?? []);
  const [priority, setPriority] = useState<Priority | null>(draft?.priority ?? null);
  const [open, setOpen] = useState(false);
  const project = projects.find((p) => p.id === projectId);
  const error = accept.error ?? reject.error ?? comment.error ?? retriage.error;
  const busy = accept.isPending || reject.isPending || comment.isPending || retriage.isPending;

  const suggested = item.replyTo ?? draft?.duplicate ?? null;
  const sender = item.fromName ? `${item.fromName} <${item.fromAddress}>` : item.fromAddress;

  return (
    <article className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{item.subject || t('noSubject')}</h3>
          <p className="truncate text-xs text-muted-foreground">{sender}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.classification && (
            <Badge variant="secondary">{t(`classification.${item.classification}`)}</Badge>
          )}
          {item.triage === 'pending' && <Badge variant="outline">{t('checking')}</Badge>}
        </div>
      </div>

      <button
        type="button"
        className="mt-2 text-xs text-muted-foreground underline"
        onClick={() => setOpen(!open)}
      >
        {open ? t('hideEmail') : t('showEmail')}
      </button>
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto text-xs whitespace-pre-wrap">{item.body}</pre>
      )}
      {item.attachments.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('attachments', { names: item.attachments.map((a) => a.filename).join(', ') })}
        </p>
      )}

      {!item.replyTo && (item.triage === 'failed' || (item.triage === 'none' && !draft)) ? (
        <p className="mt-3 text-xs text-destructive">
          {item.triage === 'failed' ? t('checkFailed') : t('notChecked')}
        </p>
      ) : null}

      {suggested && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md bg-muted p-2 text-xs">
          <span>
            {t(item.replyTo ? 'replyTo' : 'duplicateOf', {
              identifier: suggested.identifier,
              title: suggested.title,
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => comment.mutate({ id: item.id, issueId: suggested.id })}
          >
            {t('addAsComment', { identifier: suggested.identifier })}
          </Button>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <Select
          value={projectId ? String(projectId) : ''}
          onValueChange={(v) => {
            setProjectId(Number(v));
            setLabelIds([]);
          }}
        >
          <SelectTrigger aria-label={t('project')}>
            <SelectValue placeholder={t('project')} />
          </SelectTrigger>
          <SelectContent>
            {projects
              .filter((p) => p.teamId === item.teamId)
              .map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Input
          aria-label={t('fieldTitle')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          aria-label={t('fieldDescription')}
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={priority ?? NONE}
            onValueChange={(v) => setPriority(v === NONE ? null : (v as Priority))}
          >
            <SelectTrigger className="w-36" aria-label={t('priority')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('noPriority')}</SelectItem>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`priorities.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {project?.labels.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={labelIds.includes(l.id)}
              className="rounded-full border px-2 py-0.5 text-xs aria-pressed:bg-accent"
              onClick={() =>
                setLabelIds(
                  labelIds.includes(l.id)
                    ? labelIds.filter((x) => x !== l.id)
                    : [...labelIds, l.id],
                )
              }
            >
              {l.name}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-destructive">{error.message}</p>}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {item.triage !== 'pending' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => retriage.mutate(item.id)}
          >
            {t('checkAgain')}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(item.id)}>
          {t('reject')}
        </Button>
        <Button
          size="sm"
          disabled={busy || !projectId || !title.trim()}
          onClick={() =>
            accept.mutate({
              id: item.id,
              input: {
                projectId: projectId!,
                title: title.trim(),
                description,
                labelIds,
                priority,
              },
            })
          }
        >
          {t('accept')}
        </Button>
      </div>
    </article>
  );
}
