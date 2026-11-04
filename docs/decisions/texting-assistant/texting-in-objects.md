# A text reaches Tex without Convex (2026-11-04)

The owner, looking at a text's timing: "if the MCP doesn't have to go through
convex, I believe, then neither should texting." Since 2026-11-01 an MCP
request goes token → person object → workspace object with no Convex call
([access-in-objects](../identity-and-access/access-in-objects.md)). A text
did not, because the texting grants were left with the control plane
(`CONTROL_PLANE_CLIENTS`), so on 2026-11-03 a one-word text spent about 2.4 s
of 7.5 s waiting on Convex:

- the Worker's `/agent-texts/session`: a mutation that mints a new grant,
  re-arms the dream, check-in and housekeeping and writes an audit row, then
  two queries for the zone and the style;
- the gateway resolving that `cat_` token at `/gateway/session`;
- the cap check (`/gateway/builtin-model`);
- the identity block (`/gateway/agent/identity`, about 1 s cold).

This reverses the texting row of `CONTROL_PLANE_CLIENTS` and, for the texting
facts below, the rule that only the control plane holds account facts.

## The path

1. **The phone's inbox remembers whose it is.** A text arrives with only a
   number, and an object is found by its name (`workspace:<id>`), so the
   number has to lead to a workspace id. The texting Worker already keeps one
   inbox object per number; it keeps the personal workspace id the gateway
   answered with, and sends it with every session ask. No new object (the
   owner, 2026-11-04: "why can't it just be the person's personal workspace
   object?"). The id is a locator, never proof: the person object answers only
   for a phone hash it holds itself. Only an inbox with no id yet (a first
   text, a relink, an id the object refused) makes the gateway ask Convex
   which person linked the number, once. A group chat needs none of this: its
   chat id names its own object.
2. **The person object holds the texting record.** One row: the phone hashes
   linked to this person, whether texting is paused ("This wasn't me"), the
   scopes their role allows, their zone, their Tex style, and the identity
   block (name, handle, phones, emails, Google accounts). The phones and
   emails here are a second copy of sign-in facts, kept because Tex is told
   them on every turn (decided by the owner, 2026-10-23,
   [identity](../../../apps/mcp/src/agent/identity.js)); sign-in itself stays
   in Convex.
3. **One call, no session ask.** The Worker sends the text straight to the
   gateway's `/agent` with the phone and the workspace id its inbox keeps,
   behind `AGENT_WORKER_SECRET` (the owner, 2026-11-04: "is this the simplest
   most elegant solution possible?"). The worker secret and a phone already
   got a token from Convex, so this proves nothing less. The gateway hashes the
   phone (HMAC-SHA256 under a gateway secret, so no object holds the number
   itself) and asks the person object, which refuses an unknown or paused
   phone and otherwise keeps a 15-minute `cat1.<personalWorkspaceId>.<secret>`
   texting connection and answers with the zone, style and identity; the turn
   runs in the same request, and the token comes back with the reply for the
   Worker's later calls (events, chat reads, jobs). The call goes over a
   service binding to the gateway Worker, not public HTTPS: the texting
   Worker stays its own Worker (Sendblue's side: dedupe, the per-phone queue,
   steering, presence, sends, jobs; the owner asked why not one Worker, and
   the hop, not the split, was the cost).
4. **Nothing Convex holds is waited on.** The identity block is read from the
   texting record. The grant row, the audit row and the dream, check-in and
   housekeeping re-arming are written to Convex behind the reply, from an
   outbox that retries, never on the path.

## Group chats too

The owner, the same night: "please make sure you speed up both group chats
and 1:1 texts." A group text asked Convex (`/agent-texts/group`) on every
message who is in the chat, who has an account, the guest labels, whose grant
it runs under and how Tex speaks up. The chat's own Tex object, named by its
chat id, keeps that answer: members and their accounts, guest phones as
hashes (a guest needs no account), the sponsor, engagement and style. A text
from the same participants as last time is answered there, with a 15-minute
group token, in the same one call. A change of participants or a command
(invite, share mail, stop, start) still goes to Convex, whose answer replaces
the one kept, so who may reach the chat's home is never decided from a stale
list.

## Who is the authority

The person object owns the phone link, as it owns connections: one source,
copied one way. Linking, unlinking, pausing and unpausing write the object
first and Convex second (`writeBoth`), so an
unlinked or paused phone is refused on its very next text even while the copy
is on its way, and a failed object write fails the change. A change to a fact
in the identity block (a name, an email, a Google account) is written to the
object behind the change in Convex: a stale name is wrong, never unsafe.

## Rollout

Per person, like access: `texting: "convex" | "object"`. A person is switched
once their object holds the record and the index object names them; until
then the gateway's route answers by asking Convex exactly as the Worker used
to, so nobody is cut off mid-move.

## What a simplification costs

- Trusting the inbox's workspace id would let a wrong or stale id open a
  person object that never linked the number; the person object checks its
  own phone hashes, and a refusal clears the inbox's id.
- Writing Convex first on unlink would leave a removed phone answered until
  the copy lands.
- Waiting for the Convex write-behind before answering puts the 2.4 s back.

Tests: the isolation tests in `apps/mcp/test/textingObjects.test.mjs` (a phone
held by one person never opens another's object; a paused or unlinked phone is
refused at once; no object keeps the number itself), and the Convex
side in `apps/convex/__tests__/textingObjects.test.ts`.
