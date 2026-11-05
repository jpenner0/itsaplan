import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SettingsSection from '@/components/common/page/SettingsSection';
import SettingsCard from '@/components/common/page/SettingsCard';
import CopyableValue from '@/components/common/page/CopyableValue';
import EnabledSwitch from '@/components/common/inputs/EnabledSwitch';
import SecretInput from '@/components/common/inputs/SecretInput';
import type { GodOAuthAppForm } from '../../hooks/useGodOAuthAppForm';

const PROVIDER = {
  google: {
    clientIdPlaceholder: '…apps.googleusercontent.com',
    clientSecretPlaceholder: 'GOCSPX-…',
    redirectUriHint: 'redirectUriHint',
  },
  github: {
    clientIdPlaceholder: 'Ov23li…',
    clientSecretPlaceholder: undefined,
    redirectUriHint: 'githubRedirectUriHint',
  },
} as const;

// The credentials of the Google or GitHub OAuth app. The redirect URI is derived from
// the API origin and shown read-only, since it has to be registered on the OAuth app
// for the round trip to work at all.
export default function GodOAuthAppSettings({
  provider,
  form,
}: {
  provider: keyof typeof PROVIDER;
  form: GodOAuthAppForm;
}) {
  const t = useTranslations('god.authProvider');
  const { clientIdPlaceholder, clientSecretPlaceholder, redirectUriHint } = PROVIDER[provider];

  return (
    <SettingsSection
      title={t(provider)}
      description={t(form.hasCredentials ? `${provider}Configured` : `${provider}Missing`)}
      action={
        <EnabledSwitch
          checked={form.enabled}
          onChange={form.setEnabled}
          disabled={form.saving || !form.hasCredentials}
        />
      }
    >
      <SettingsCard className="space-y-6 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${provider}-client-id`}>{t('clientId')}</Label>
            <Input
              id={`${provider}-client-id`}
              value={form.clientId}
              onChange={(e) => form.setClientId(e.target.value)}
              placeholder={clientIdPlaceholder}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${provider}-client-secret`}>{t('clientSecret')}</Label>
            <SecretInput
              id={`${provider}-client-secret`}
              value={form.clientSecret}
              onChange={form.setClientSecret}
              hasStored={form.settings.hasClientSecret}
              placeholder={clientSecretPlaceholder}
            />
          </div>
        </div>

        <CopyableValue
          title={t('redirectUri')}
          value={form.settings.redirectUri}
          hint={t(redirectUriHint)}
          copyLabel={t('copyRedirectUri')}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
