import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SecretInput from '@/components/common/inputs/SecretInput';
import type { MailboxAuth } from '@/lib/api/endpoints/teamMailbox';
import type { TeamMailboxFormState } from '../../hooks/useTeamMailboxForm';

// The sign-in credentials of the chosen mode. A secret field never holds the stored value;
// left empty on an edit it keeps it.
export default function TeamMailboxSecretFields({
  auth,
  form,
  hasStored,
}: {
  auth: MailboxAuth;
  form: TeamMailboxFormState;
  hasStored: boolean;
}) {
  const t = useTranslations('teams.mailbox');
  if (auth === 'password') {
    return (
      <div className="space-y-1.5">
        <Label htmlFor="mailbox-password">{t('password')}</Label>
        <SecretInput
          id="mailbox-password"
          value={form.password}
          onChange={form.setPassword}
          hasStored={hasStored}
        />
        {hasStored && <p className="text-xs text-muted-foreground">{t('keepSecret')}</p>}
      </div>
    );
  }
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="mailbox-tenant">{t('tenantId')}</Label>
        <Input
          id="mailbox-tenant"
          value={form.tenantId}
          onChange={(e) => form.setTenantId(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mailbox-client">{t('clientId')}</Label>
        <Input
          id="mailbox-client"
          value={form.clientId}
          onChange={(e) => form.setClientId(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mailbox-client-secret">{t('clientSecret')}</Label>
        <SecretInput
          id="mailbox-client-secret"
          value={form.clientSecret}
          onChange={form.setClientSecret}
          hasStored={hasStored}
        />
        {hasStored && <p className="text-xs text-muted-foreground">{t('keepSecret')}</p>}
      </div>
    </>
  );
}
