'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import GithubIcon from '@/components/common/GithubIcon';
import AccountConnectionRow from './AccountConnectionRow';
import {
  connectProvider,
  useDisconnectProvider,
  useLinkedAccountsQuery,
} from '../../services/accounts.service';

// The GitHub identity the issue sync matches to this account. It is no sign-in
// method, so disconnecting it never locks the account out.
export default function AccountGithubConnection() {
  const t = useTranslations('account.accounts');
  const { data: accounts } = useLinkedAccountsQuery();
  const disconnect = useDisconnectProvider();
  const [connecting, setConnecting] = useState(false);

  const github = accounts?.find((a) => a.providerId === 'github');

  async function onConnect() {
    setConnecting(true);
    try {
      await connectProvider('github', t('githubConnectFailed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('githubConnectFailed'));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <AccountConnectionRow
      icon={<GithubIcon className="size-4" />}
      name="GitHub"
      description={t('githubDescription')}
      connectedTo={github ? t('githubConnectedAs', { id: github.accountId }) : null}
      busy={connecting || disconnect.isPending}
      onConnect={() => void onConnect()}
      onDisconnect={() => {
        if (!github) return;
        disconnect.mutate(github.id, { onSuccess: () => toast.success(t('githubDisconnected')) });
      }}
    />
  );
}
