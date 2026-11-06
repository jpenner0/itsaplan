import { t } from 'elysia';

const classification = t.Nullable(t.UnionEnum(['bug', 'feature', 'question', 'no_ticket', 'spam']));

export const InboxItemDto = t.Object({
  id: t.Number(),
  fromName: t.String(),
  fromAddress: t.String(),
  subject: t.String(),
  sentAt: t.Nullable(t.Date()),
  body: t.String(),
  attachments: t.Array(
    t.Object({ filename: t.String(), sizeBytes: t.Number(), stored: t.Boolean() }),
  ),
  classification,
  teamId: t.Number(),
  // none: no run was queued; pending; done; failed. A failed or none item has no draft and
  // offers "Check again".
  triage: t.UnionEnum(['none', 'pending', 'done', 'failed']),
  draft: t.Nullable(
    t.Object({
      projectId: t.Number(),
      projectKey: t.String(),
      projectName: t.String(),
      title: t.String(),
      description: t.String(),
      labelIds: t.Array(t.Number()),
      priority: t.Nullable(t.String()),
      duplicate: t.Nullable(
        t.Object({ id: t.Number(), identifier: t.String(), title: t.String() }),
      ),
    }),
  ),
});

export const InboxResponse = t.Object({
  items: t.Array(InboxItemDto),
  // Spam, newsletters, automatic replies, "no ticket" and senders that are not allowed: kept,
  // and still acceptable.
  sortedOut: t.Array(InboxItemDto),
});

// `enabled`: a team of the user has a mailbox, so the menu item is shown.
export const InboxCountResponse = t.Object({ open: t.Number(), enabled: t.Boolean() });

export const InboxProjectsResponse = t.Array(
  t.Object({
    id: t.Number(),
    key: t.String(),
    name: t.String(),
    teamId: t.Number(),
    labels: t.Array(t.Object({ id: t.Number(), name: t.String(), color: t.String() })),
  }),
);

export const AcceptBody = t.Object({
  projectId: t.Number(),
  title: t.String({ minLength: 1, maxLength: 200 }),
  description: t.String({ maxLength: 20_000 }),
  labelIds: t.Array(t.Number()),
  priority: t.Nullable(t.UnionEnum(['urgent', 'high', 'medium', 'low'])),
});

export const CommentBody = t.Object({ issueId: t.Number() });

export const AcceptedResponse = t.Object({ issueId: t.Number(), identifier: t.String() });

export const ItemParams = t.Object({ itemId: t.Numeric() });
