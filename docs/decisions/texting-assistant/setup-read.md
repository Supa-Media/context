# Every Tex turn reads its setup, whoever the person is (2026-11-02)

Tex's setup is `ai/production/texting-assistant.md` in the pinned workspace,
with its skills and its jobs' setups (heartbeat, housekeeping, dreams) beside
it, and the helper agents under `ai/agents/`. Those rows are staff-only `team`
notes. The gateway used to read them through the person's own reach into the
pin, so two kinds of turn read nothing and ran on the built-in words without
saying so (no open web, five pages a turn, none of the setup's rules or
skills):

- a person who reaches the pin only as a pin reader, read as a guest, where
  `team` never shows;
- every group chat, once its setup row was read as the chat (#2498,
  2026-10-31), where each row the chat holds no token for renders private.

Found from a group job that stopped after five pages on 2026-11-02. The owner
chose a code-only door, keeping the prompt staff-only: "peoples tex should
always have access to the production note".

**Decision.** A Tex client's token (`context_texts`, `context_texts_group`,
`context_routines`, `context_heartbeat`, `context_housekeeping`,
`context_dreams`) may ask `/gateway/binding` for the pin with `setupRead`.
The control plane answers only for those clients and only for the pinned
workspace, and hands rules rendered for a member and then narrowed to
`ai/production` and `ai/agents` (`apps/convex/functions/lib/texSetupRead.ts`):
everything else in the pin is `private`, which a `team` read never sees. The
gateway opens it read-only, with no granted names, as a door no tool can
address (`apps/mcp/src/session.js` `sessionForSetup`), and every setup, skill,
job-setup and helper read in `apps/mcp/src/agent/production.js` goes through
it first. The person's own reach in the pin is unchanged. If the door ever
answers nothing, the turn logs `tex_setup_door_missed` and falls back to the
person's reach.

**What a simplification costs.** Making the setup `team`-visible to guests or
chats would publish the staff prompt to every pin reader. Reading it through
the person's reach again brings back silent built-in turns for everyone who is
not a member. Letting any client ask for `setupRead` hands an AI client the
staff folder.

**Tests.** `apps/mcp/test/agentSetupDoor.test.mjs` (nobody in it is a pin
member: a guest 1:1 and a group turn get the production prompt, an AI client
never asks) and `apps/convex/__tests__/texSetupRead.test.ts` (the setup shows
and nothing else does, AI clients and other workspaces get no binding), each
with its sabotage record.

## Answered by the pin's own object (2026-11-04)

Dev, after a cold text spent 400 ms opening this door through the control
plane: "can we do setup without convex?". The pin's workspace object already
holds the member rules and the sealed binding a member's request is opened
from (`store/objectBinding.js`), so it answers the setup read too:
`ws.open {userId, setupRead: true}` returns the member rules narrowed to
`ai/production` and `ai/agents` (`apps/mcp/src/workspaceStore/setupRules.js`,
the same narrowing as `texSetupRead.ts`) and the sealed binding, whoever the
reader is. The full member rules never leave the object for it.

The gateway asks it only for a session `sessionForSetup` built: a Tex client,
the pinned workspace by name, `team` as a `member`. `ws.open` stays the
gateway's alone (the control plane's door refuses it). On a miss (nothing
kept, a change still coming, access not yet in the object) the control plane
answers as before, and its binding is kept for the next one.
`SETUP_FROM_OBJECT=off` switches it back.

**What a simplification costs.** Sending the member rules whole would let the
setup door read every staff `team` note in the pin. Dropping the client or pin
check would hand any session the pin's setup folders.

**Tests.** `apps/mcp/test/objectBindingSetupRead.test.mjs` (served from the
object after the first, nothing outside the setup folders visible, every other
session refused) and `apps/convex/__tests__/texSetupReadParity.test.ts` (the
object's narrowing answers every path as the control plane's).
