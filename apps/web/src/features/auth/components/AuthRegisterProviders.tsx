'use client';

import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import GithubIcon from '@/components/common/GithubIcon';
import GoogleIcon from '@/components/common/GoogleIcon';
import { useAuthConfig } from '@/services/authConfig.service';

// Signing in through a provider covers sign-up too: an address without an account
// gets one, subject to the instance registration mode.
export default function AuthRegisterProviders({
  pending,
  onOidc,
  onGoogle,
  onGithub,
}: {
  pending: boolean;
  onOidc: () => void;
  onGoogle: () => void;
  onGithub: () => void;
}) {
  const t = useTranslations('auth.register');
  const authConfig = useAuthConfig();

  return (
    <Field className="gap-2">
      {authConfig?.oidc && (
        <Button type="button" variant="outline" onClick={onOidc} disabled={pending}>
          <ShieldCheck />
          {/* The operator named their own identity provider, so the label is shown
              as given rather than translated. */}
          {authConfig.oidcLabel || t('withSso')}
        </Button>
      )}
      {authConfig?.google && (
        <Button type="button" variant="outline" onClick={onGoogle} disabled={pending}>
          <GoogleIcon className="size-4" />
          {t('withGoogle')}
        </Button>
      )}
      {authConfig?.github && (
        <Button type="button" variant="outline" onClick={onGithub} disabled={pending}>
          <GithubIcon />
          {t('withGithub')}
        </Button>
      )}
    </Field>
  );
}
