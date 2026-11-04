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
3. **The session ask goes to the gateway, not Convex.** The Worker asks the
   gateway's `TexTexts` entrypoint (`apps/mcp/src/agent/textsSession.js`)
   over a service binding, with the phone and the workspace id its inbox
   keeps. A named entrypoint has no public URL: only a Worker in this account
   bound to it can call it, so the ask carries no secret. The gateway hashes
   the phone (HMAC-SHA256 under a key derived from the gateway secret, so no
   object holds the number itself; Convex derives the same key to write the
   record) and asks the person object, which refuses an unknown or paused
   phone and otherwise keeps a 15-minute `cat1.<personalWorkspaceId>.<secret>`
   texting connection and answers with the zone and style. The Worker then
   sends the text to `/agent` with that token, as before; the person object
   resolves it and carries the identity block on the session, so the turn
   asks Convex for nothing. Every miss is `{status: "unlinked"}`, and the
   Worker then asks Convex as it always has. The design first folded the
   session into the `/agent` call itself (the owner, 2026-11-04: "is this the
   simplest most elegant solution possible?"); an in-account binding call
   costs a few milliseconds, so keeping the two steps kept `/agent`
   unchanged, and the cost was Convex, not the hop. The texting Worker stays
   its own Worker (Sendblue's side: dedupe, the per-phone queue, steering,
   presence, sends, jobs; the owner asked why not one Worker, and the hop,
   not the split, was the cost).
4. **One Convex write is still waited on, and nothing Convex reads.** The
   identity block, zone and style come from the texting record. Before the
   token goes out, Convex keeps its copy of the grant with the token's hash,
   in one mutation that also writes the audit row and re-arms the dream,
   check-in and housekeeping (`/gateway/texts/opened`,
   `apps/convex/functions/textingObjects.ts`). It is waited on because every
   control-plane route that takes the token (the model cap, the vault, mail,
   pages) resolves it from that copy; written behind, the first of them could
   run before it lands and refuse a live token. One write replaces the old
   four calls. It can go behind once the cap check, the only token call before
   the model runs, is answered by the object too.

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

The first step needs no object. The chat's inbox in the texting Worker keeps
the last "ready" answer, with its token, keyed to the tagger and a hash of the
chat's people (`apps/agent/src/groupKept.ts`). A plain tag from the same
person with the same people, within eight minutes of the mint (a group token
lives fifteen), runs on that token at once, and the control plane is asked
behind the turn without minting: its bookkeeping (the check-in, the reach) is
kept, its answer refreshes the kept one, and anything but "ready" drops it so
the next tag asks first. Reuse widens nothing: the gateway re-checks the grant
on every call (live, not paused, the chat not muted, each workspace still
shared, `liveGrants.ts` `groupStillShares`). Another sender, another set of
people, a command, a style choice, a setting or a routine always asks first.
What it can get wrong for one message is a name, a guest label or the style.

## Who is the authority

The person object keeps the phone link, as it keeps connections, and Convex
keeps the record it is copied from: link, unlink, pause, unpause and a change
of Tex style push the record again (`lib/textingRefresh.ts`), and an unlink or
a pause revokes every texting token the object opened. Convex also re-checks
the link and the pause in the one write each text makes, so a push still on
its way never lets a removed or paused phone in. A record older than ten
minutes is pushed again behind a text, so a changed zone or name reaches the
object; a stale name is wrong, never unsafe.

## Rollout

Per person, like access: `texting: "convex" | "object"` on the personal
workspace's homes row, `object` only once the record landed and only while
`personAccess` is `object`. Only then does `/agent-texts/session` name the
personal workspace, which the Worker keeps; until then every text goes the
old way, so nobody is cut off mid-move. `textingObjects.backfill` switches
everyone who can be, and `switchOff` puts one person back.

## What a simplification costs

- Trusting the inbox's workspace id would let a wrong or stale id open a
  person object that never linked the number; the person object checks its
  own phone hashes, and a refusal clears the inbox's id.
- Dropping Convex's re-check from the one write would leave a removed or
  paused phone answered until the push lands.
- Writing the grant copy behind would let a tool call or the cap check run
  before it lands and refuse a live token.

Tests: the isolation tests in `apps/mcp/test/textingObjects.test.mjs` (a phone
held by one person never opens another's object; a paused or unlinked phone is
refused at once) and `apps/mcp/test/textsSession.test.mjs` (a workspace id
naming somebody else's object is the same miss; the phone is only ever a keyed
hash, pinned to a vector Convex's copy must match; Convex is told the token's
hash and never the token; who is texting is read off the session), and the
Convex side in `apps/convex/__tests__/textingObjects.test.ts`; for a group,
`apps/agent/src/groupKept.test.ts` (another sender, a newcomer, an old token,
a command or a chat that stopped answering never runs on a kept token).
