'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import FullPageView from '@/components/common/page/FullPageView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Mailbox } from '@/lib/api/endpoints/mailboxes';
import MailboxDialog from './MailboxDialog';
import MailboxFolderForm from './MailboxFolderForm';
import {
  useDeleteFolder,
  useDeleteMailbox,
  useMailboxesQuery,
  useMailboxOptionsQuery,
} from './services/mailboxes.service';

// The user's mailboxes for the email intake. Only the owner sees one. A paused folder shows
// its error and "Reconnect", which opens the sign-in form: replacing the secret starts the
// folder again.
export default function MailboxesPage() {
  const t = useTranslations('mailboxes');
  const { data: mailboxes, isPending } = useMailboxesQuery();
  const { data: options } = useMailboxOptionsQuery();
  const del = useDeleteMailbox();
  const delFolder = useDeleteFolder();
  const [dialog, setDialog] = useState<{ mailbox?: Mailbox } | null>(null);

  return (
    <FullPageView label={t('label')} title={t('title')} description={t('description')}>
      <div className="mb-2 flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setDialog({})}>
          <Plus className="size-4" />
          {t('connect')}
        </Button>
      </div>
      {isPending && <Skeleton className="h-24 w-full" />}
      {mailboxes?.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      <div className="space-y-4">
        {mailboxes?.map((box) => (
          <section key={box.id} className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium">{box.label}</h2>
                <p className="truncate text-xs text-muted-foreground">
                  {box.username} · {box.host}:{box.port}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  title={t('edit')}
                  onClick={() => setDialog({ mailbox: box })}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title={t('remove')}
                  onClick={() => {
                    if (window.confirm(t('removeConfirm', { label: box.label })))
                      del.mutate(box.id);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
            <ul className="mt-3 divide-y">
              {box.folders.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate">{f.name}</span>
                      {f.status === 'paused' && <Badge variant="destructive">{t('paused')}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('folderMeta', { team: f.teamName, agent: f.agentName })}
                    </p>
                    {f.lastError && <p className="text-xs text-destructive">{f.lastError}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {f.status === 'paused' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ mailbox: box })}
                      >
                        {t('reconnect')}
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t('removeFolder')}
                      onClick={() => delFolder.mutate({ id: box.id, folderId: f.id })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {options && <MailboxFolderForm mailboxId={box.id} options={options} />}
          </section>
        ))}
      </div>
      {dialog && <MailboxDialog mailbox={dialog.mailbox} onClose={() => setDialog(null)} />}
    </FullPageView>
  );
}
