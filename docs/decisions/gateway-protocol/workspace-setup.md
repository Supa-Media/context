# Gateway protocol: an agent sets a workspace up, and only a third party's sign-in needs a browser

## What is Context's own is doable through the MCP (Dev2, 2026-10-17)

Decided by Dev2, 2026-10-17: what is UI-only about Context itself should be
doable through the MCP, so Tex (which holds the same six tools) does not send
the person to a browser for Context. Only a third party's sign-in needs one.

The first cut is three `manage` actions, each a row in
`apps/mcp/src/tools/v2/actions.js` carried by a tool that is not one of the
six (see [six tools](./six-tools.md)):

- **`create_workspace`** `{ slug, name, dry_run? }` (`create_workspace`):
  a shared workspace owned by the person, with them as its only member.
  `dry_run: true` says whether the handle is free and claims nothing; a name
  check is a dry run of the create rather than a second action, the shape
  `move_notes` and `move_folder` already have. Where the deployment offers it,
  the same transaction starts the free bucket Context runs (as the app's
  workspace flow offers first), so the workspace is usable in a minute;
  elsewhere the answer says storage is the person's to connect in the app.
- **`layout`** `{ template: "para" | "business" | "product" }` or
  `{ folder: <built-in role> }` (`apply_layout`): the app's presets, and its
  "Add a folder". `business` is the five plus Clients and Teams and `product`
  the five plus Teams and Products, as the owner set the presets on
  2026-10-08; one built-in folder covers any other mix.
- **`connect_google`** `{ kind: "gmail" | "calendar" }` (`connect_google`):
  a link to Connected apps in the person's personal workspace, where they press
  Connect and sign in to Google.

Invites and share links are out of this cut: they let more people see
something. There is no "default workspace" setting; every tool already takes
`context: "@name"`.

## One handler, the person off the grant

The gateway decides nothing. Each action posts to `/gateway/workspaces/*`
(`apps/convex/functions/lib/gatewayRoutes/workspaces.ts`) with the connection's
own token; the route resolves it to a live grant, finds the addressed workspace
inside that grant's reach, requires `context:write`, and then calls the handler
the app's own mutation calls — `createWorkspaceHandler`,
`applyStructureHandler`, `startFreeManagedHandler`, the `addBuiltInFolder`
file operation — with the grant's person. Those handlers took the caller from
`requireAuthId`; they now take an actor id, and the app's mutations pass the
signed-in user. So the name rules, the reserved words, the per-person cap, the
rate limit and the owner check cannot differ between the app and an agent.
The folder is written at the grant's tier, clamped by role, as every gateway
write is ([grants and reach](../identity-and-access/grants-and-reach.md)).

## Google is a page, never an authorize URL

A Google connect is bound to the browser that starts it: the starting browser
keeps a completion secret that never travels through Google, and the callback
refuses without it ([grants and reach](../identity-and-access/grants-and-reach.md),
"A third-party OAuth callback carries a secret the browser kept"). An authorize
URL minted for an agent is one no browser holds the secret for, so it could
never complete; giving the secret to the agent would undo the binding that
stops a connect built by one person being finished by another. So the action
hands back the app's own page, and the person starts the connect there.

## None of the three widens, so the egress gate does not hold them

A write addressed into another workspace is held by the egress gate as a
widening unless it is classified ([agent egress](../privacy-and-sharing/agent-egress.md)).
These three are classified by name in `NEVER_WIDENS` (`apps/mcp/src/privacy/egress.js`):
a new workspace's only member is the person; a layout writes folders and
`about.md` text Context wrote, chosen from a fixed list, so nothing the model
read can ride in it; and `connect_google` writes nothing. Listed by name, so a
tool added later is still held until somebody classifies it.

## What a "simplification" would cost

- **Calling `startGmailConnect` from the gateway and returning its URL** breaks
  the completion-secret binding, and every such connect fails at the callback.
- **A gateway-side copy of the name rules or the owner check** is a second
  copy that drifts; the gateway is dependency-free and cannot import them.
- **Dropping `NEVER_WIDENS`** puts every layout of a new workspace behind an
  approval on a gateway with the gate on, for a call that shows nobody anything.

## Tests

- `apps/convex/__tests__/controlPlane/workspaceSetup.test.ts`: a grant without
  `context:write` sets nothing up; one tenant cannot create, check, lay out or
  connect through another's workspace; the creator is the grant's person; the
  app's name rules and reserved words hold; an editor cannot choose a layout;
  Google only for a personal workspace's owner, as a page. Sabotage recorded
  in its header.
- `apps/mcp/test/workspaceSetup.test.mjs`: the actions translate, reach the
  addressed workspace, and a read-only connection never reaches the control
  plane; the egress gate (on in tests) does not hold them.
- `apps/mobile/__tests__/workspaceCreate.test.ts`: an agent's layout is the
  picker's preset, row for row.
- `apps/mobile/__tests__/checkoutReturn.test.ts`: the Connected apps link
  (`integrationsSettingsPath`, `@context/shared`) is the console's own
  `settingsHref(slug, "integrations")`.
