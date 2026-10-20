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

Share links stay out: they let more people see something, and they have
their own gate. Invites came next (below, 2026-10-20). There is no "default
workspace" setting; every tool already takes `context: "@name"`.

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

## None of the three widens

A new workspace's only member is the person; a layout writes folders and
`about.md` text Context wrote, chosen from a fixed list, so nothing the model
read can ride in it; and `connect_google` writes nothing. Until the owner
removed the widening gate on 2026-10-17
([agent egress](../privacy-and-sharing/agent-egress.md)) they were listed in
`NEVER_WIDENS` so it would not hold them as writes into another workspace;
with the gate gone, nothing holds them, and the list went too.

## A real create waits for the person's yes (2026-10-17)

Not widening is not harmless. A `create_workspace` that is not a dry run
claims an @handle, and handles never free up (retiring a name does not free
it; see [vocabulary](../vocabulary-and-workspaces.md)); it also spends one of
the person's ten owned-workspace slots. Run with no yes, any connected AI
client, or an instruction planted in a page it read, could squat names for
good and use the slots up. So the claim is held through the same approvals
as an email (`.context/approvals/pending/`, answered in the app at
`/approvals` or by a texted YES), by `handleClaimOf` in
`apps/mcp/src/tools/session.js`. It outlived the widening gate, which the
owner removed on 2026-10-17, because it was never about widening: it is about
irreversibility. `dry_run: true` claims nothing and is never held, so checking
a name stays free.

**It asked on every gateway, the old `EGRESS_APPROVALS = "off"` switch
included, and from every turn, a clean one included** (history: the switch
went with the gate). The owner switched the
gate off because ordinary writes into shared workspaces were being held, a
cost in friction for a risk the person can undo (a write can be edited back,
a visibility narrowed again). Neither holds here: a claim is rare, one per
workspace a person makes, and nothing undoes it. The switch is about
widening; this hold is about irreversibility, which the switch's reasoning
never covered, so honouring the switch for it would extend the owner's
decision past what it said. For the same reason a texted turn whose ledger is
clean still asks: a clean ledger means the person's own words asked for a
workspace, not that the model spelled the handle they meant, and a typo
claimed is a typo kept. Now one place: `handleClaimOf` holds every real
create unless it is the person's replayed yes.

**Tex's onboarding by text keeps working.** The held call answers the model
with the texting line ("Tell them plainly what you want to do; they will be
asked to reply YES"), the turn's answer ends with the gateway's own one-line
ask ("I need your OK: claim the handle @woodshop for a new shared workspace
(handles are permanent). Should I go ahead?"), and the person's yes runs it
through `agent/route.js` before any model, as for every other held call. The
cost is one text per workspace made. An MCP client is told the person can
approve it in the Context app and to call again with the same arguments.

What a simplification would cost: letting the switch pass a claim, or a clean
ledger, puts every handle one injected sentence (or one misheard name) away
from being taken forever. Tests: `apps/mcp/test/egress.test.mjs` ("claiming a
handle always waits for the person, and a dry run never does");
`apps/mcp/test/workspaceSetup.test.mjs` ("create_workspace checks a handle,
then claims it ... once they say yes", "a dry run is never held, and a claim
is held even with the widening gate switched off", "Tex asks by text before
claiming a handle, and the texted YES claims it"), sabotage in its header.

## Tex invites people, and offers a shared workspace when work involves them (2026-10-20)

Decided by the owner, 2026-10-20: "a lot of users are going to be interacting
with context only through TEX ... once multiple people are involved, suggest,
hey, this is probably something that can be in another workspace. Even if
it's just one other person." Before this, Tex could make a shared workspace
but was told "inviting people is done in the app", and nothing told it to
offer one, so a person who only texts never made one and their work with
others stayed in a personal workspace nobody else could open.

- **`manage invite`** `{ people: [{ who, role? }] }` (`invite_member`), with
  `context` set to a shared workspace the person owns: `who` is an email
  address or a @handle, `role` editor (the default) or member, at most ten.
  It posts to `/gateway/workspaces/invite`, which clears the grant as the
  other routes do and calls `inviteMemberHandler`
  (`apps/convex/functions/lib/invitations/invite.ts`), the body the app's
  `inviteMember` now calls too. So the owner check, the string rules, the
  hourly limit, the pending cap and the `null` that keeps an invite box from
  being an existence oracle are the app's. A personal workspace is refused
  at the route: an agent never opens one person's workspace to somebody else.
- **`create_workspace` takes the same `invite`.** `createShared` makes the
  workspace and the invitations in one transaction, so a refusal for one
  string makes nothing at all, and one yes covers both.
- **Both wait for the person's yes, naming everyone.** An invitation is an
  email that cannot be unsent, which is the same reason an email waits
  (`tools/irreversible.js`, beside the handle claim it generalizes). The
  summary names each invitee and role ("claim the handle @woodshop ..., and
  invite ada@example.com as an editor (Context emails them)"), so a yes is to
  those people. It is not a sharing-judge call: the held yes is stronger, and
  judging it too would refuse Tex's offer before the person could answer it.
  Housekeeping refuses it (`mightWiden`), since nobody is watching.
- **The offer is the held call.** Every turn (one workspace or several) is
  told, in `agent/workspaces.js`, to offer a shared workspace once when work
  is done with at least one other person and none covers it, never for
  family, friends or a one-off plan, to remember a no, and to make the offer
  by calling `create_workspace` with `invite`. The gateway's own ask is the
  question, so the person answers once: "Before I do that, I need your OK:
  ... Should I go ahead?" Nothing is created or sent before that yes.
- **A texted yes offers the next step.** No model runs on a texted yes
  (`textedSettle.js`), so the done line for a create is followed by "Want me
  to set up its folders and move your notes about it there?"; the next yes
  goes to the model with that line in the conversation.

What a simplification would cost: running an invite without the yes lets one
injected sentence email strangers in the person's name; letting the agent
invite into a personal workspace opens every note in it; a gateway-side copy
of the invite rules drifts from the app's and can leak who has an account.

Tests: `apps/convex/__tests__/controlPlane/workspaceInvite.test.ts` (one
transaction, owner only, personal refused, the same answer whoever the
strings name; sabotage in its header); `apps/mcp/test/workspaceInvite.test.mjs`
(held and named, released once, refused in words, the texted offer and its
one YES; sabotage in its header); `apps/mcp/test/agentWorkspaces.test.mjs`
("one workspace ... is still offered a shared one").

## The owned-workspace cap counts owners before it limits (2026-10-17)

`createWorkspaceHandler` (`apps/convex/functions/lib/workspaces/create.ts`)
used to read the first eleven of a person's memberships and then keep the
owner rows. Memberships come back in creation order, so someone who had
joined eleven or more workspaces before creating their own counted none of
their owned ones and never met the cap. The owner filter now runs before the
limit. No index covers `role` on `workspaceMembers`, so it is a filter on the
`by_user` range rather than a new index: the scan is bounded by one person's
memberships, which is small, and a schema index was not worth a migration for
it. Tests in `apps/convex/__tests__/workspaces.test.ts`: "a member of many
contexts who owns ten is refused the eleventh", "owning nine while a member
of fifteen still allows a tenth".

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
- `apps/convex/__tests__/controlPlane/workspaceInvite.test.ts` and
  `apps/mcp/test/workspaceInvite.test.mjs`: invites, above.
- `apps/mcp/test/workspaceSetup.test.mjs`: the actions translate, reach the
  addressed workspace, and a read-only connection never reaches the control
  plane; a layout or a connect is never held, and a real create is held for
  the person's yes.
- `apps/mobile/__tests__/workspaceCreate.test.ts`: an agent's layout is the
  picker's preset, row for row.
- `apps/mobile/__tests__/checkoutReturn.test.ts`: the Connected apps link
  (`integrationsSettingsPath`, `@context/shared`) is the console's own
  `settingsHref(slug, "integrations")`.
