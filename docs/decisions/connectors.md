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

### Who a connection acts as follows from the workspace's kind

- A **personal workspace's** connection acts as its person (Slack's user
  scopes): Tex reads what they can see, searches, and posts as them. Only that
  person's own calls reach it.
- A **shared workspace's** connection acts as the app (Slack's bot member
  "Tex"): it posts as Tex and sees only channels it is invited to. Owners and
  editors connect it; every member's Tex can use it.
- **A Tex group chat never reaches anyone's own connection** (the rule #2021
  set for logins, the owner 2026-10-21): its links are refused for a personal
  workspace, and its calls see only the shared workspace's connection.

### A post waits for the person's yes; a read or a reaction does not

`chat.postMessage`, `chat.update`, `chat.delete`, `chat.scheduleMessage` and
`chat.meMessage` are held by `apps/mcp/src/tools/irreversible.js` for the
person's YES to the words, as an invitation is. Reads, `reactions.add` and
`conversations.open` run at once. (Pending the owner's pick on the decision
card of 2026-10-21; asking per message is the default until then.)

### The Slack app

One app, "Tex by Context", serves dev, staging and production, with token
rotation off (a token lasts until revoked). Its manifest and setup steps are
kept with the owner's project files; its client id and secret are
`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in Convex, from 1Password. With
either unset the connector is off: the link page says so and the gateway
answers that it is not set up.

**What a simplification would cost:** one table per provider repeats the
cascade, the attempt sweep and the structure pins every time; letting the
gateway hold the token puts it in a Worker a prompt can steer; letting a
group chat use a personal connection lets anyone in the chat post as one of
them. Tests: `apps/convex/__tests__/connections/slackConnect.test.ts` ("a
group chat, or another person, never reaches someone's own Slack", "a consent
answered without the starting browser's secret lands nowhere", "a method off
the list never leaves") and `apps/mcp/test/connectors.test.mjs` ("a post
waits for the person's yes to its words").
