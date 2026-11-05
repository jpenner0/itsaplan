'use client';

import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type {
  InstanceGithubSettings,
  InstanceGoogleSettings,
  InstanceOidcSettings,
} from '@/lib/api/endpoints/god';
import { Button } from '@/components/ui/button';
import GodSectionPage from '../GodSectionPage';
import GodOAuthAppSettings from './GodOAuthAppSettings';
import GodOidcSettings from './GodOidcSettings';
import { useGodOAuthAppForm } from '../../hooks/useGodOAuthAppForm';
import {
  useUpdateInstanceGithubSettings,
  useUpdateInstanceGoogleSettings,
} from '../../services/god.service';
import { useGodOidcForm } from '../../hooks/useGodOidcForm';

// One section per provider, committed through the page's single Save. GitHub sits here
// as an OAuth app too, though it only links accounts and signs nobody in.
export default function GodAuthProviderForm({
  googleSettings,
  githubSettings,
  oidcSettings,
}: {
  googleSettings: InstanceGoogleSettings;
  githubSettings: InstanceGithubSettings;
  oidcSettings: InstanceOidcSettings;
}) {
  const t = useTranslations('god.authProvider');
  const tCommon = useTranslations('common');
  const google = useGodOAuthAppForm(googleSettings, useUpdateInstanceGoogleSettings());
  const github = useGodOAuthAppForm(githubSettings, useUpdateInstanceGithubSettings());
  const oidc = useGodOidcForm(oidcSettings);

  const dirty = google.dirty || github.dirty || oidc.dirty;
  const saving = google.saving || github.saving || oidc.saving;

  // Only the sections that changed are written, so saving one provider does not
  // resubmit the other's credentials.
  async function save() {
    try {
      if (google.dirty) await google.save();
      if (github.dirty) await github.save();
      if (oidc.dirty) await oidc.save();
      toast.success(t('saved'));
    } catch {
      // The failure already surfaced through the global mutation error toast.
    }
  }

  return (
    <GodSectionPage
      slug="auth-provider"
      actions={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? tCommon('saving') : tCommon('save')}
        </Button>
      }
    >
      <div className="space-y-10">
        <GodOidcSettings form={oidc} />
        <GodOAuthAppSettings provider="google" form={google} />
        <GodOAuthAppSettings provider="github" form={github} />
      </div>
    </GodSectionPage>
  );
}
