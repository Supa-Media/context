# A username changes twice, and the old one stays yours

Decided by the owner on 2026-11-22: "build it, but only allow people to change twice in a lifetime, and let them
keep their old name." This replaces "usernames are stable" (the onboarding line "You can't change it later").

## What a change is

A username is the slug of the person's personal workspace, so changing it is a slug change on that workspace,
from Settings › Profile › Username (`functions/names.ts` `changeMyUsername`, `lib/usernameChange.ts`).

Everything that holds data is keyed by ids and does not move: the workspace object `workspace:<workspaceId>`, the
buckets (`managedBucketName(workspaceId)`), memberships, grants (`{kind, id}` grantees), Tex's computers and chats.
Only the name layer changes.

- **The old name stays theirs.** Its row in `names` is kept, still pointing at the workspace, and the name is listed
  in `workspaces.formerSlugs`. Everything that resolves a name through `findName` keeps reaching the same person by
  it: `/@old` websites and short links, `old@context.lc` capture mail, invitations and shares sent to `@old`, and
  `identifiersForUser`. Nobody else can claim it. It is freed only with the account, like the current name.
- **Twice in a lifetime.** `workspaces.slugChanges` counts every change, a change back to a former name included;
  the third is refused with `USERNAME_CHANGES_USED`. The count lives on the personal workspace, which lives and dies
  with the account.
- **Copies of the handle are refreshed.** A session's workspace list carries `aliases` (the former names), so
  `context: "@old"` and `/tex/@old` reach the same workspace (`apps/mcp/src/session.js` `answersTo`). On a change
  the saved session lists are forgotten, every member's reach is pushed to their object again, and a workspace
  object that decides its own members is told its new name and former names through the take-away queue
  (`lib/accessHandOff/rename.ts`), so the reach rows it writes later carry them.

## Why keep the old name rather than hold and release it

A released name is an inbox and a set of links somebody else inherits: mail sent to `old@context.lc`, invitations
and shares addressed to `@old`, agents that remember `context: "@old"`. Keeping it means nothing written before the
change breaks and nothing can be hijacked. The cost is namespace: each person can hold at most three names, which
is why the limit is two changes.

An alias widens nothing. It is only listed on a workspace the connection already covers, so another person's old
name is refused exactly like a name nobody holds (`apps/mcp/test/usernameAliases.test.mjs`).

## What a simplification would cost, and the tests

- Deleting the old row on change releases the name: `apps/convex/__tests__/usernameChange.test.ts` fails four ways.
- Dropping the limit: the same file's "twice in a lifetime" test fails.
- Matching only the current handle in the gateway: `usernameAliases.test.mjs` fails.

Shared workspaces cannot be renamed yet; the same code would serve them, owner only, if that is ever wanted.
Tex cannot change a username by text; its capability list names the app path.

## Proving it end to end on a preview

An agent signs in to a pull request's preview as a persona (Actions → Preview agent sign-in), opens Settings →
Profile → Username → Change, and presses Send on "Check it's you". The same workflow with `step: email-code` hands it
the waiting code ([preview-sandbox](../../preview-sandbox.md)). After the change, the new handle opens the
workspace and the old one still does: through the app and through MCP with `context: "@old"`.
