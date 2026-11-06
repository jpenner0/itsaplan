import { Elysia, t } from 'elysia';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { noContent } from '#shared/http';
import { errors } from '#shared/responses';
import {
  AcceptBody,
  AcceptedResponse,
  CommentBody,
  InboxCountResponse,
  InboxProjectsResponse,
  InboxResponse,
  ItemParams,
} from './model';
import {
  acceptItem,
  commentOnIssue,
  inboxCount,
  inboxProjects,
  listInbox,
  rejectItem,
  retriage,
} from './service';

// The session user's Mail inbox. Every route is self-scoped to the owner of the mailbox the
// email came from, so no project guard applies. The routes take the user's own rights into
// account when they create an issue or a comment. Not MCP tools: the content comes from
// outside senders and a person confirms it.
export const mailInboxRoutes = new Elysia({ name: 'mail-inbox', detail: { tags: ['Mail intake'] } })
  .use(authContext)

  .get('/account/mail-inbox', ({ user }) => listInbox(requireUser(user).id), {
    response: { 200: InboxResponse, ...errors(401) },
    detail: { summary: 'List my mail drafts' },
  })

  .get('/account/mail-inbox/count', ({ user }) => inboxCount(requireUser(user).id), {
    response: { 200: InboxCountResponse, ...errors(401) },
    detail: { summary: 'Count open mail drafts' },
  })

  .get('/account/mail-inbox/projects', ({ user }) => inboxProjects(requireUser(user).id), {
    response: { 200: InboxProjectsResponse, ...errors(401) },
    detail: { summary: 'Projects a draft can be accepted into' },
  })

  .post(
    '/account/mail-inbox/:itemId/accept',
    ({ user, params, body }) => acceptItem(requireUser(user).id, params.itemId, body),
    {
      params: ItemParams,
      body: AcceptBody,
      response: { 200: AcceptedResponse, ...errors(400, 401, 403, 404, 409) },
      detail: { summary: 'Accept a draft as an issue' },
    },
  )

  .post(
    '/account/mail-inbox/:itemId/comment',
    ({ user, params, body }) => commentOnIssue(requireUser(user).id, params.itemId, body.issueId),
    {
      params: ItemParams,
      body: CommentBody,
      response: { 200: AcceptedResponse, ...errors(400, 401, 403, 404, 409) },
      detail: { summary: 'Add the email as a comment on an issue' },
    },
  )

  .post(
    '/account/mail-inbox/:itemId/reject',
    async ({ user, params }) => {
      await rejectItem(requireUser(user).id, params.itemId);
      return noContent();
    },
    {
      params: ItemParams,
      response: { 204: t.Void(), ...errors(401, 404, 409) },
      detail: { summary: 'Reject a draft' },
    },
  )

  .post(
    '/account/mail-inbox/:itemId/retriage',
    async ({ user, params, set }) => {
      await retriage(requireUser(user).id, params.itemId);
      set.status = 202;
      return { ok: true };
    },
    {
      params: ItemParams,
      response: { 202: t.Object({ ok: t.Boolean() }), ...errors(400, 401, 404, 409) },
      detail: { summary: 'Check an email again' },
    },
  );
