'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import ConfirmDialog from '@/components/common/overlay/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { useDeleteTeamMailbox } from '../../services/teamMailbox.service';

export default function TeamMailboxDelete({ teamId }: { teamId: number }) {
  const t = useTranslations('teams.mailbox');
  const remove = useDeleteTeamMailbox(teamId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t('delete')}
      </Button>
      {open && (
        <ConfirmDialog
          title={t('deleteTitle')}
          confirmLabel={t('delete')}
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            await remove.mutateAsync();
            toast.success(t('deleted'));
          }}
        >
          <p className="text-sm text-muted-foreground">{t('deleteConfirm')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
