'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Modal from '@/components/common/overlay/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Mailbox, MailboxAuth, MailboxInput } from '@/lib/api/endpoints/mailboxes';
import { useCreateMailbox, useUpdateMailbox } from './services/mailboxes.service';

// Connects a mailbox, or with `mailbox` set edits it and replaces its sign-in. A secret left
// empty keeps the stored one; replacing it is how a paused folder is reconnected.
export default function MailboxDialog({
  mailbox,
  onClose,
}: {
  mailbox?: Mailbox;
  onClose: () => void;
}) {
  const t = useTranslations('mailboxes');
  const tCommon = useTranslations('common');
  const create = useCreateMailbox();
  const update = useUpdateMailbox();
  const [label, setLabel] = useState(mailbox?.label ?? '');
  const [host, setHost] = useState(mailbox?.host ?? '');
  const [port, setPort] = useState(String(mailbox?.port ?? 993));
  const [secure, setSecure] = useState(mailbox?.secure ?? true);
  const [auth, setAuth] = useState<MailboxAuth>(mailbox?.auth ?? 'password');
  const [username, setUsername] = useState(mailbox?.username ?? '');
  const [password, setPassword] = useState('');
  const [tenantId, setTenantId] = useState(mailbox?.tenantId ?? '');
  const [clientId, setClientId] = useState(mailbox?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');

  const mutation = mailbox ? update : create;
  const needsSecret = !mailbox || auth !== mailbox.auth;
  const secretOk =
    auth === 'password'
      ? !needsSecret || password !== ''
      : tenantId !== '' && clientId !== '' && (!needsSecret || clientSecret !== '');
  const valid = label.trim() && host.trim() && username.trim() && Number(port) > 0 && secretOk;

  function submit() {
    const input: MailboxInput = {
      label: label.trim(),
      host: host.trim(),
      port: Number(port),
      secure,
      auth,
      username: username.trim(),
      ...(auth === 'password'
        ? { password }
        : { tenantId: tenantId.trim(), clientId: clientId.trim(), clientSecret }),
    };
    if (mailbox) update.mutate({ id: mailbox.id, input }, { onSuccess: onClose });
    else create.mutate(input, { onSuccess: onClose });
  }

  const field = (id: string, text: string, node: React.ReactNode, hint?: string) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {text}
      </label>
      {node}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <Modal title={mailbox ? t('dialog.editTitle') : t('dialog.createTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) submit();
        }}
      >
        {field(
          'mb-label',
          t('dialog.label'),
          <Input
            id="mb-label"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />,
        )}
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          {field(
            'mb-host',
            t('dialog.host'),
            <Input
              id="mb-host"
              placeholder="outlook.office365.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />,
          )}
          {field(
            'mb-port',
            t('dialog.port'),
            <Input
              id="mb-port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            />,
          )}
        </div>
        {field(
          'mb-secure',
          t('dialog.encryption'),
          <Select value={secure ? 'tls' : 'starttls'} onValueChange={(v) => setSecure(v === 'tls')}>
            <SelectTrigger id="mb-secure">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tls">{t('dialog.tls')}</SelectItem>
              <SelectItem value="starttls">{t('dialog.starttls')}</SelectItem>
            </SelectContent>
          </Select>,
        )}
        {field(
          'mb-auth',
          t('dialog.auth'),
          <Select value={auth} onValueChange={(v) => setAuth(v as MailboxAuth)}>
            <SelectTrigger id="mb-auth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="password">{t('dialog.authPassword')}</SelectItem>
              <SelectItem value="microsoft365">{t('dialog.authMicrosoft')}</SelectItem>
            </SelectContent>
          </Select>,
          auth === 'microsoft365' ? t('dialog.authMicrosoftHint') : undefined,
        )}
        {field(
          'mb-user',
          t('dialog.username'),
          <Input id="mb-user" value={username} onChange={(e) => setUsername(e.target.value)} />,
        )}
        {auth === 'password' ? (
          field(
            'mb-password',
            t('dialog.password'),
            <Input
              id="mb-password"
              type="password"
              autoComplete="new-password"
              placeholder={mailbox?.hasSecret && !needsSecret ? t('dialog.keepSecret') : ''}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />,
          )
        ) : (
          <>
            {field(
              'mb-tenant',
              t('dialog.tenantId'),
              <Input
                id="mb-tenant"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              />,
            )}
            {field(
              'mb-client',
              t('dialog.clientId'),
              <Input
                id="mb-client"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />,
            )}
            {field(
              'mb-client-secret',
              t('dialog.clientSecret'),
              <Input
                id="mb-client-secret"
                type="password"
                autoComplete="new-password"
                placeholder={mailbox?.hasSecret && !needsSecret ? t('dialog.keepSecret') : ''}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />,
            )}
          </>
        )}

        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={!valid || mutation.isPending}>
            {mailbox ? tCommon('save') : t('dialog.connect')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
