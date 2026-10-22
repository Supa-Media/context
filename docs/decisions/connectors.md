# Connectors: apps Tex uses through their own OAuth app

Started with Slack, asked for by the owner on 2026-10-21: "make an official
slack connector like instinct, and also begin to plan for the other
connectors we need like outlook and github". Before this, Tex signed in to
Slack with its browser and sent the person to slack.com's "Sign in to your
workspace" page.

### A connector is a token Tex calls the app's API with, and nothing is copied into notes

- **One flow for every provider.** An agent asks for a link
  (`/gateway/connect/request`, the `manage connect` action); the person opens
  `/connect/<provider>/<token>` signed in, presses Continue, approves on the
  app's own consent screen, and the app sends them back to
  `/connect/<provider>`. The token is exchanged there, sealed to the workspace
  with `encryptSecret`, and the link is spent
  (`apps/convex/functions/connections.ts`).
- **One table for every provider** (`providerConnections`,
  `lib/schema/connections.ts`), with its link and attempt tables. A provider
  is one entry in `lib/providers/registry.ts`: its consent address, its
  exchange, its revoke, and its call rules beside it (`slack.ts`). Outlook,
  GitHub, Notion and Linear follow by adding an entry, not a flow.
- **Google stays separate.** Gmail, Calendar and Chat sync into notes and
  keep `googleConnections`; a connector syncs nothing.
- **The link is the vault link's shape**: 30 minutes, one use, only for the
  signed-in person whose grant asked, ten an hour. Unknown, spent and expired
  answer the same; a live link for someone else says it isn't theirs.
- **The consent round trip is the Google connect's shape**: a parked attempt
  keyed by a hashed `state`, and a completion secret that stays in the
  starting browser, so a consent somebody else started cannot land in this
  workspace. The attempt is spent before the code is exchanged.
- **A call is opened in the control plane only** (`callProvider`, through
  `/gateway/connect/call`): the token is decrypted for one request to an
  allow-listed method and never returned. A method off the list never leaves.
  An answer saying the token is gone marks the connection for reconnecting.
- **Every write is audited** (`connection.called`: method and whether it
  landed, never its words), as are connecting and disconnecting.
- **Disconnecting revokes the token at the provider**, scheduled with the
  sealed envelope, as is a replaced token on reconnect and every token when a
  workspace is deleted.

### A connection is one person's, for now

Decided by the owner, 2026-10-21: "I dont really want it connecting for
everyone, it should just be 1 person for now."

- An app connects only in the person's own **personal workspace**, by its
  owner, and acts as them (Slack's user scopes): Tex reads what they can see,
  searches, and posts as them. Only that person's own calls reach it
  (`mayConnect`, `connectionsForCall`).
- A **shared workspace** gets no link, even for its owner. The workspace-wide
  shape (Slack's bot member "Tex", `scope: "workspace"`) stays in the schema
  and `scopeForWorkspaceKind` so it can come back as a decision, but nothing
  makes one and no call reaches one.
- **A Tex group chat never gets a link and never reaches a connection** (the
  rule #2021 set for logins). The group turn is not offered the connector
  tools; Tex says to text it one-to-one.

Reversing this is a decision here first. The tests that fail are "an app
connects for one person only" and "a workspace-wide connection, were one ever
stored, is reached by nobody" (`apps/convex/__tests__/connections/`), and "a
group turn is never offered Slack" (`apps/mcp/test/connectors.test.mjs`).

### A post waits for the person's yes; a read or a reaction does not

`chat.postMessage`, `chat.update`, `chat.delete`, `chat.scheduleMessage` and
`chat.meMessage` are held by `apps/mcp/src/tools/irreversible.js` for the
person's YES to the words, as an invitation is. Reads, `reactions.add` and
`conversations.open` run at once. (Pending the owner's pick on the decision
card of 2026-10-21; asking per message is the default until then.)

The ask names where the post goes as Slack names it, never by an id
(2026-10-22: Dev2 was asked to OK "post in Slack in U0FAKE0001"). Before the
hold, `slackPlace` (`apps/mcp/src/tools/connectors.js`) asks Slack
(`users.info`, `conversations.info`) for the person's name or the channel's
`#name` and the Slack's own name: "send a Slack message to Jo Park
(Acme): …". The name comes from Slack, never from the model's
arguments, so a model can't put a friendlier name on somebody else's channel;
when Slack can't say, the id stays. Test: "a held Slack post names the person
or channel as Slack has it, never an id" in `apps/mcp/test/connectors.test.mjs`.

### The Slack app

One app, "Tex by Context", serves dev, staging and production, with token
rotation off (a token lasts until revoked). Its manifest and setup steps are
kept with the owner's project files; its client id and secret are
`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in Convex, from 1Password. With
either unset the connector is off: the link page says so and the gateway
answers that it is not set up.

The app's user token scopes must equal `SLACK_USER_SCOPES` in
`functions/lib/providers/slack.ts`: add a scope in the Slack app first, then
in code, or connecting fails with `invalid_scope`. A connection granted fewer
scopes than the code now asks for shows Reconnect in Settings, and the
gateway answers Slack's `missing_scope` with "ask them to reconnect", never
"it can't be done". `im:write` and `mpim:write` (2026-10-21) are what open a
DM before posting to it.

Tex reads Slack as a person would: a channel may be named `#name`;
`users.list` and `conversations.list` come back whole and short;
`conversations.history`, `conversations.replies` and `search.messages` come
back trimmed with every author named (`slackLists.ts`, `slackMessages.ts`). A
texted turn sees an action only as its summary and argument names
(`agent/sixTools.js`), so the recipes (find, DM, post, reply in a thread)
live in `ACTIONS.send.slack.summary`.

**What a simplification would cost:** one table per provider repeats the
cascade, the attempt sweep and the structure pins every time; letting the
gateway hold the token puts it in a Worker a prompt can steer; letting a
group chat use a connection lets anyone in the chat post as one person.
Tests: `apps/convex/__tests__/connections/slackConnect.test.ts` ("a
group chat, or another person, never reaches someone's own Slack", "a consent
answered without the starting browser's secret lands nowhere", "a method off
the list never leaves") and `apps/mcp/test/connectors.test.mjs` ("a post
waits for the person's yes to its words").

### An app with an official MCP server connects through it (2026-10-21)

Dev2 asked that Tex reach apps through their official MCP servers where they
exist, "so Tex essentially just has more tools", and that Tex know which apps
it reaches natively and which it still signs in to with its browser.

- **One flow for every such app.** Linear, Notion, Jira and Confluence,
  Airtable, monday.com, Planning Center, Calendly, ClickUp and Todoist are one
  row each in `lib/providers/mcpApps.ts`: a name and a server URL. The link,
  the consent page and the callback are the Slack ones.
- **No keys of ours.** The control plane discovers the server's authorization
  server (RFC 9728, RFC 8414), registers itself once per callback address
  (RFC 7591, a public client) and keeps that registration in
  `providerOAuthClients`. Consent always carries PKCE (S256) and the server as
  `resource` (RFC 8707). An app whose server needs a pre-registered client
  (Slack, HubSpot, Box, Asana) is not in this list; Slack keeps its Web API
  connector.
- **The public action never opens a secret.** `completeProviderConnect`
  schedules `finishStandardConsent`, which exchanges the code; the callback
  page watches `connectionState` until it lands or fails.
- **A read is what the app marks read-only, and nothing else.** A tool runs
  without a change only when its `readOnlyHint` is true. A tool marked
  otherwise, or not marked at all, is refused as `needs_yes`, and the gateway
  holds every `app_change` (`send app`) for the person's yes to exactly that
  call (`irreversible.js`), because Context cannot know what an app's tool
  does. Simplifying this to "trust the description" lets a model post or
  delete in somebody's workspace unasked. Tests:
  `apps/convex/__tests__/connections/mcpConnect.test.ts`,
  `apps/mcp/test/apps.test.mjs`.
- **Tex reads the catalog before reaching for a browser.** `fetch apps:` lists
  every app this deployment connects and the person's state in each; anything
  not listed is a browser job. A group chat sees every app as unavailable.
- **An app's answer marks the turn untrusted, a change's included.**
  `app_read`, `app_change` and `slack_api` are in `UNTRUSTED_READS`, and a
  write's answer is recorded when its tool is one of them, so a planted issue
  or message steers nothing the way an email cannot. Test:
  `apps/mcp/test/egress.test.mjs`.
- **Settings lists every app, not only connected ones (2026-10-21).** Dev2:
  "no way to connect through context and see what I have / manage the
  connections?" Settings › Apps Tex uses reads the same catalog Tex does
  (`lib/connections/catalog.ts`) and its Connect button mints the same
  one-use link (`connectionSettings.startAppConnect`), so it can only connect
  the presser's own personal workspace and there is one consent flow, not
  two. Tests: `apps/convex/__tests__/connections/settingsApps.test.ts`,
  `apps/mobile/__tests__/providerConnectionsCard.test.ts`.

Outlook stays on its own Microsoft Graph connector, waiting on a Microsoft
Entra app (Dev2 has no Microsoft directory yet).
