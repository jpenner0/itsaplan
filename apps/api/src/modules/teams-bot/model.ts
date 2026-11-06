import { t } from 'elysia';

export const TeamsBotAccountResponse = t.Object({
  // False when the instance has no Teams bot configured: the UI does not offer it.
  available: t.Boolean(),
  chatUrl: t.Nullable(t.String()),
  link: t.Nullable(
    t.Object({
      displayName: t.Nullable(t.String()),
      linkedAt: t.String(),
      broken: t.Boolean(),
    }),
  ),
});

export const TeamsBotLinkStartResponse = t.Object({
  code: t.String(),
  chatUrl: t.String(),
  expiresAt: t.String(),
});

// The part of a Bot Framework activity this endpoint reads. Teams sends much more.
export const TeamsActivityBody = t.Object({
  type: t.String(),
  text: t.Optional(t.String()),
  serviceUrl: t.String(),
  from: t.Optional(t.Object({ id: t.String(), name: t.Optional(t.String()) })),
  conversation: t.Object({ id: t.String(), conversationType: t.Optional(t.String()) }),
  channelData: t.Optional(t.Object({ tenant: t.Optional(t.Object({ id: t.String() })) })),
});
