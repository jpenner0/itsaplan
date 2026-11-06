import { Elysia } from 'elysia';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { noContent } from '#shared/http';
import { errors } from '#shared/responses';
import {
  FolderBody,
  FolderParams,
  MailboxCreateBody,
  MailboxDto,
  MailboxList,
  MailboxOptions,
  MailboxParams,
  MailboxUpdateBody,
} from './model';
import {
  addFolder,
  createMailbox,
  deleteMailbox,
  listMailboxes,
  mailboxOptions,
  removeFolder,
  updateFolder,
  updateMailbox,
} from './service';
import { t } from 'elysia';

// The session user's own mailboxes for the email intake. Every route is self-scoped, so no
// project guard applies. They carry credentials, so none is an MCP tool.
export const mailboxRoutes = new Elysia({ name: 'mailboxes', detail: { tags: ['Mail intake'] } })
  .use(authContext)

  .get('/account/mailboxes', ({ user }) => listMailboxes(requireUser(user).id), {
    response: { 200: MailboxList, ...errors(401) },
    detail: {
      summary: 'List my mailboxes',
      description: "The session user's connected mailboxes.",
    },
  })

  .get('/account/mailboxes/options', ({ user }) => mailboxOptions(requireUser(user).id), {
    response: { 200: MailboxOptions, ...errors(401) },
    detail: {
      summary: 'Teams and agents a folder can use',
      description: 'The teams the user belongs to and the internal agents of those teams.',
    },
  })

  .post(
    '/account/mailboxes',
    async ({ user, body, set }) => {
      const created = await createMailbox(requireUser(user).id, body);
      set.status = 201;
      return created;
    },
    {
      body: MailboxCreateBody,
      response: { 201: MailboxDto, ...errors(400, 401) },
      detail: { summary: 'Connect a mailbox' },
    },
  )

  .patch(
    '/account/mailboxes/:mailboxId',
    ({ user, params, body }) => updateMailbox(requireUser(user).id, params.mailboxId, body),
    {
      params: MailboxParams,
      body: MailboxUpdateBody,
      response: { 200: MailboxDto, ...errors(400, 401, 404) },
      detail: {
        summary: 'Update or reconnect a mailbox',
        description:
          'Replacing the password or the Microsoft 365 credentials starts a paused folder again.',
      },
    },
  )

  .delete(
    '/account/mailboxes/:mailboxId',
    async ({ user, params }) => {
      await deleteMailbox(requireUser(user).id, params.mailboxId);
      return noContent();
    },
    {
      params: MailboxParams,
      response: { 204: t.Void(), ...errors(401, 404) },
      detail: { summary: 'Remove a mailbox' },
    },
  )

  .post(
    '/account/mailboxes/:mailboxId/folders',
    async ({ user, params, body, set }) => {
      const updated = await addFolder(requireUser(user).id, params.mailboxId, body);
      set.status = 201;
      return updated;
    },
    {
      params: MailboxParams,
      body: FolderBody,
      response: { 201: MailboxDto, ...errors(400, 401, 403, 404, 409) },
      detail: {
        summary: 'Add a folder',
        description:
          'Only this folder is read. Its emails are sent to the AI provider of the chosen agent.',
      },
    },
  )

  .patch(
    '/account/mailboxes/:mailboxId/folders/:folderId',
    ({ user, params, body }) =>
      updateFolder(requireUser(user).id, params.mailboxId, params.folderId, body),
    {
      params: FolderParams,
      body: t.Pick(FolderBody, ['teamId', 'agentId']),
      response: { 200: MailboxDto, ...errors(400, 401, 403, 404) },
      detail: { summary: 'Change the team and agent of a folder' },
    },
  )

  .delete(
    '/account/mailboxes/:mailboxId/folders/:folderId',
    async ({ user, params }) => {
      await removeFolder(requireUser(user).id, params.mailboxId, params.folderId);
      return noContent();
    },
    {
      params: FolderParams,
      response: { 204: t.Void(), ...errors(401, 404) },
      detail: { summary: 'Remove a folder' },
    },
  );
