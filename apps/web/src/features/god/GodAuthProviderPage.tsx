'use client';

import ListSkeleton from '@/components/common/skeleton/ListSkeleton';
import GodAuthProviderForm from './components/auth-provider/GodAuthProviderForm';
import GodSectionPage from './components/GodSectionPage';
import {
  useInstanceGithubSettingsQuery,
  useInstanceGoogleSettingsQuery,
  useInstanceOidcSettingsQuery,
} from './services/god.service';

// The sign-in providers, Google and the instance's own OIDC server, and the GitHub app
// that links accounts. One settings row each, so this page loads all three before the
// form can compare against them. GodSettingsGate takes a single query, which is why the gate is spelled out.
export default function GodAuthProviderPage() {
  const google = useInstanceGoogleSettingsQuery();
  const github = useInstanceGithubSettingsQuery();
  const oidc = useInstanceOidcSettingsQuery();

  if (!google.data || !github.data || !oidc.data) {
    return (
      <GodSectionPage slug="auth-provider">
        <ListSkeleton rows={5} rowClassName="h-12" />
      </GodSectionPage>
    );
  }

  // Keyed on the loaded state: a save replaces the cache entries, so the form
  // remounts with fresh initial values instead of a stale "dirty" comparison.
  return (
    <GodAuthProviderForm
      key={`${JSON.stringify(google.data)}|${JSON.stringify(github.data)}|${JSON.stringify(oidc.data)}`}
      googleSettings={google.data}
      githubSettings={github.data}
      oidcSettings={oidc.data}
    />
  );
}
