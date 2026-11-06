import { db, user, userTeamsBotAccount } from '@repo/db';
import { isAccountDeactivated } from '@repo/auth';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import { readTeamsBotConfig, sendBotText, type TeamsBotConfig } from '@repo/net/teams-bot';
import { HttpError, pgErrorCode } from '#shared/lib';
import { botFrameworkKeys } from './jwks';
import { parseCommand } from './commands';
import { myIssues, searchIssues, showIssue } from './read-commands';

// The Microsoft Teams bot and the account links it creates. Linking mirrors Telegram:
// the api mints a one-time code, the user sends `link <code>` to the bot in a personal
// chat, and the bot endpoint stores the conversation the notifications are sent to.
// A linked member also reads issues with `my`, `search` and `show`, as themselves.

const LINK_CODE_TTL_MINUTES = 15;

const HELP =
  'Commands:\n\n' +
  'my: your open issues\n\n' +
  'search <text>: find issues by title\n\n' +
  'show <id>: details of an issue, for example show MKT-42\n\n' +
  'link <code>: connect this chat to your account (code from Accounts in your profile)\n\n' +
  'help: this list';

const NOT_LINKED =
  'Connect your account first. Open Accounts in your profile, press Connect for the Teams bot, ' +
  'and send the code it shows here: link <code>';

export interface TeamsBotLink {
  displayName: string | null;
  linkedAt: string;
  broken: boolean;
}

// The deep link that opens a chat with the bot: 28: is the prefix of a bot's id.
export function teamsBotChatUrl(config: TeamsBotConfig): string {
  return `https://teams.microsoft.com/l/chat/0/0?users=28:${encodeURIComponent(config.appId)}`;
}

export async function getTeamsBotLink(userId: string): Promise<TeamsBotLink | null> {
  const [row] = await db
    .select({
      displayName: userTeamsBotAccount.displayName,
      linkedAt: userTeamsBotAccount.linkedAt,
      brokenAt: userTeamsBotAccount.brokenAt,
    })
    .from(userTeamsBotAccount)
    .where(eq(userTeamsBotAccount.userId, userId));
  if (!row?.linkedAt) return null;
  return {
    displayName: row.displayName,
    linkedAt: row.linkedAt.toISOString(),
    broken: row.brokenAt !== null,
  };
}

// An existing link stays in place until the new code is confirmed, so a failed re-link
// does not leave the user without Teams.
export async function startTeamsBotLink(
  userId: string,
): Promise<{ code: string; expiresAt: string }> {
  const code = randomBytes(6).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  await db
    .insert(userTeamsBotAccount)
    .values({ userId, linkCode: code, linkCodeExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: userTeamsBotAccount.userId,
      set: { linkCode: code, linkCodeExpiresAt: expiresAt },
    });
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function unlinkTeamsBot(userId: string): Promise<void> {
  await db.delete(userTeamsBotAccount).where(eq(userTeamsBotAccount.userId, userId));
}

interface ConfirmInput {
  code: string;
  teamsUserId: string;
  displayName: string | null;
  serviceUrl: string;
  conversationId: string;
}

async function confirmLink(input: ConfirmInput): Promise<'ok' | 'expired' | 'taken'> {
  try {
    const rows = await db
      .update(userTeamsBotAccount)
      .set({
        teamsUserId: input.teamsUserId,
        displayName: input.displayName,
        serviceUrl: input.serviceUrl,
        conversationId: input.conversationId,
        linkCode: null,
        linkCodeExpiresAt: null,
        linkedAt: sql`now()`,
        brokenAt: null,
        lastError: null,
      })
      .where(
        and(
          eq(userTeamsBotAccount.linkCode, input.code),
          gt(userTeamsBotAccount.linkCodeExpiresAt, sql`now()`),
        ),
      )
      .returning({ userId: userTeamsBotAccount.userId });
    return rows.length > 0 ? 'ok' : 'expired';
  } catch (err) {
    // The partial unique index on teams_user_id: this Teams account is linked already.
    if (pgErrorCode(err) === '23505') return 'taken';
    throw err;
  }
}

// Verifies the Bot Framework token of a request: signed by Microsoft's published keys,
// issued for this bot, and carrying the serviceUrl the activity claims. Without the
// last check a caller holding any valid token could point our replies elsewhere.
async function assertBotFrameworkRequest(
  authorization: string | undefined,
  config: TeamsBotConfig,
  serviceUrl: string,
): Promise<void> {
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Missing bearer token');
  try {
    const { payload } = await jwtVerify(token, botFrameworkKeys, {
      algorithms: ['RS256'],
      issuer: 'https://api.botframework.com',
      audience: config.appId,
    });
    const claimed = payload.serviceurl;
    if (
      typeof claimed !== 'string' ||
      claimed.replace(/\/+$/, '') !== serviceUrl.replace(/\/+$/, '')
    ) {
      throw new Error('serviceurl mismatch');
    }
  } catch {
    throw new HttpError(401, 'Invalid bot token');
  }
}

async function linkedUserId(teamsUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: userTeamsBotAccount.userId, active: user.active })
    .from(userTeamsBotAccount)
    .innerJoin(user, eq(user.id, userTeamsBotAccount.userId))
    .where(
      and(
        eq(userTeamsBotAccount.teamsUserId, teamsUserId),
        isNotNull(userTeamsBotAccount.linkedAt),
      ),
    );
  return row && !isAccountDeactivated(row) ? row.userId : null;
}

// Runs a command as the user the Teams account is linked to. Every read goes through the
// service functions and their access checks; the bot has no permissions of its own.
async function answerCommand(
  teamsUserId: string,
  command: ReturnType<typeof parseCommand>,
): Promise<string> {
  if (!command || command.keyword === 'help') return HELP;
  const userId = await linkedUserId(teamsUserId);
  if (!userId) return NOT_LINKED;
  switch (command.keyword) {
    case 'my':
      return myIssues(userId);
    case 'search':
      return searchIssues(userId, command.args);
    case 'show':
      return showIssue(userId, command.args);
    default:
      return HELP;
  }
}

export interface TeamsActivity {
  type: string;
  text?: string;
  serviceUrl: string;
  from?: { id: string; name?: string };
  conversation: { id: string; conversationType?: string };
  channelData?: { tenant?: { id: string } };
}

// Handles one verified activity from Teams. Only a message in a personal chat of this
// bot's tenant is acted on: a link binds notifications to the conversation it was
// confirmed in, so in a group it would send one user's notifications to everyone there.
export async function handleTeamsActivity(
  activity: TeamsActivity,
  authorization: string | undefined,
): Promise<void> {
  const config = readTeamsBotConfig();
  if (!config) throw new HttpError(404, 'Teams bot is not configured');
  await assertBotFrameworkRequest(authorization, config, activity.serviceUrl);
  if (activity.type !== 'message' || !activity.from) return;
  if (activity.channelData?.tenant?.id !== config.tenantId) return;

  const conversation = {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
  };
  const reply = (text: string) => sendBotText(conversation, text);
  if (activity.conversation.conversationType !== 'personal') {
    await reply('Open a private chat with this bot to connect your account.');
    return;
  }
  const command = parseCommand(activity.text);
  if (command?.keyword !== 'link') {
    await reply(await answerCommand(activity.from.id, command));
    return;
  }
  const code = command.args.match(/^([0-9a-f]{12})$/i)?.[1]?.toLowerCase();
  if (!code) {
    await reply(HELP);
    return;
  }
  const result = await confirmLink({
    code,
    teamsUserId: activity.from.id,
    displayName: activity.from.name ?? null,
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
  });
  await reply(
    result === 'ok'
      ? 'Your Teams account is connected. Notifications will arrive here.'
      : result === 'taken'
        ? 'This Teams account is already connected to another user.'
        : 'This code has expired. Open Accounts in your profile and press Connect again.',
  );
}
