# Microsoft Teams bot

The Teams bot sends a member's notifications as direct messages in Microsoft Teams. It needs no
workflow per member, unlike the [Workflows webhook](teams-notifications.md). The bot only links
accounts and delivers notifications; it has no other commands.

The bot is off until the instance has an Azure Bot registration. Without one, the Accounts page
does not offer it and members can still use the webhook.

## How it works

- Microsoft calls the api at `POST $API_URL/teams-bot/messages`. Every request carries a bearer
  token signed by Microsoft. The api accepts it only if the issuer is `https://api.botframework.com`,
  the audience is the bot's app id, and its `serviceurl` claim equals the `serviceUrl` of the
  activity. Only messages from the bot's own tenant, in a personal chat, are acted on.
- A member links an account in **Account → Accounts → Microsoft Teams bot**. The api shows a
  one-time code that is valid for 15 minutes. The member sends `link <code>` to the bot, and the
  api stores the chat as the conversation that notifications go to.
- The worker sends notifications into that conversation as an Adaptive Card, the same card as the
  webhook channel. It authenticates with an app-only token from Microsoft Entra ID.
- The Teams events a member ticks in a project and the team gate (`teams.enabled`) are the same as
  for the webhook. A member with a linked bot gets messages from the bot; otherwise from the
  webhook. If the bot is removed from the chat (HTTP 403 or 404), the link is marked broken and the
  webhook is used until the member links again.

## Set up (operator)

1. In the Azure portal, create an **Azure Bot** resource with type **Single Tenant**. Note the
   Microsoft App ID and the Tenant ID, and create a client secret for the app registration.
2. Set the bot's messaging endpoint to `<API_URL>/teams-bot/messages`. The api must be reachable
   from the internet over https.
3. In the bot's Channels, enable **Microsoft Teams**.
4. Set `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_PASSWORD` and `TEAMS_BOT_TENANT_ID` for the api and the
   worker (`.env`, or the Helm values `api.env.TEAMS_BOT_APP_ID`, `api.env.TEAMS_BOT_TENANT_ID`
   and `secrets.teamsBotAppPassword`). Restart both.
5. Create the Teams app package: a zip with `manifest.json` and two icons (`color.png`, 192×192,
   and `outline.png`, 32×32). Upload it in Teams under **Apps → Manage your apps → Upload a custom
   app**, or publish it in the Teams admin center for the organization.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<TEAMS_BOT_APP_ID>",
  "developer": {
    "name": "Your organization",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "name": { "short": "It's a Plan" },
  "description": {
    "short": "Notifications from It's a Plan",
    "full": "Sends your It's a Plan notifications as direct messages."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#1F6FEB",
  "bots": [
    {
      "botId": "<TEAMS_BOT_APP_ID>",
      "scopes": ["personal"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "validDomains": []
}
```

## Limits

- Single tenant: only users of the Entra tenant in `TEAMS_BOT_TENANT_ID` can link.
- Only personal chats. A code sent in a group chat or a channel is refused.
- Run against a real tenant before relying on it. The test suite uses recorded Bot Framework
  requests with a local signing key and a fake sender, because Microsoft offers no test tenant.
