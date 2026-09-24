/**
 * WHO ELSE IS IN THIS NOTE — `src/presence.js`, `src/presenceRoom.js`, and the
 * `GET /presence` route.
 *
 * Presence is a *read* that happens to be a socket, and every check below is
 * written from that sentence. A caller who could not read the note cannot join
 * its room; a caller who can gets a roster of names and carets and nothing
 * else. Two properties are load-bearing enough to be worth saying before the
 * checks that prove them:
 *
 *  1. **No note text crosses this channel.** A client sends two integers and
 *     the server relays two integers. The checks assert the *shape* of a
 *     relayed frame rather than trusting the comment: a cursor frame carrying
 *     a `text` field arrives with that field gone.
 *  2. **A client cannot name itself, or pick its room.** The display name comes
 *     off the resolved session and the room key off the workspace that session
 *     resolved to, so a client that sends its own `x-presence-member` header or
 *     names another workspace in the URL gets neither. "Off the session" is not
 *     the end of that sentence, though, and the checks say which part of it:
 *     the session carries every context the connection may address, and the
 *     one that names the *person* is the personal one they own. A guest in
 *     somebody else's personal context has the host's at the head of that set.
 *
 * The room itself is a Durable Object and there is no `WebSocketPair` in node,
 * so what runs here is the pure state module in full plus the route up to the
 * point of dispatch — which is exactly where every refusal lives. The frames
 * the room sends are `presence.js` functions and are checked directly.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `presence` removed from RESERVED_FIRST_SEGMENTS (the route becomes a slug) 16
 *   `canSee` dropped from the route (any readable token joins any room)         2
 *   control characters left in a display name                                   2
 *   `x-presence-member` copied from the client instead of overwritten           1
 *   the byte ceiling measured with `String.length` rather than encoded bytes     1
 *   `normalizeOffset` accepting a non-integer unchanged                          1
 *   `expire` never dropping an idle member                                       1
 *   `/presence` removed from `isTransportPath` (no origin check on the socket)   1
 *   room key built from a workspace named in the URL rather than the session's   0
 *   `role === "owner"` dropped from `personalNameFor` (a guest is the host)     2
 *   the client's registered name consulted before the verified handle           2
 *   `kind === "personal"` dropped (a workspace slug labels a person)             2
 *   the slug clause dropped (an absent handle becomes `@null`)                   1
 *   `roomKey` drops the PATH (one room per workspace)                       0 -> 3
 *   `roomKey` drops the WORKSPACE (one room per path, across tenants)       1 -> 3
 *   `roomKey` drops the percent-encoding                                    1 -> 3
 *
 * The first two of those four share a fixture and therefore share their failures: the
 * team connection's client is registered as `@presencetest`, the host's own
 * handle, so a name that reaches the room from either the wrong context or the
 * wrong field is the same string. That is the hostile case rather than a tidy
 * one, and it is kept deliberately — a client that registers itself under the
 * handle of the person whose note it is about to sit in is the thing being
 * refused, and the two routes to it should both be red.
 *
 * The last two rows were **0** when first measured, because every fixture here
 * was a caller in one context. `kind` is now covered by a caller who owns a
 * *shared* context and a personal one, and the slug clause by a covered context
 * the control plane returned no name for. Both were closed rather than recorded
 * at zero: usernames and workspace slugs are one namespace, so `@sharedteam`
 * and `@null` are both well-formed handles for people who do not exist.
 *
 * **The room-key row, still at 0, is why this discipline is worth the time.**
 * Teaching the route
 * to read a workspace out of the query string reddened NOTHING: every tenancy
 * check here varied the *token*, so all of them passed while the URL quietly
 * picked the room. "Another workspace's token addresses its own room" is true
 * and was never the whole question. The two checks that now cover it — a
 * workspace named in the query string, and a slug for a context the grant does
 * not cover — exist because of that zero and not because anybody thought of
 * them while writing the route. The row is kept at 0 rather than restated at
 * its post-fix count, because what it records is the hole, not the patch.
 *
 * The first row is the opposite shape and worth its own sentence: sixteen
 * checks across this suite already depended on `/presence` naming a route
 * rather than a workspace, which is what it looks like when a name is load
 * bearing before anybody writes a test for it by that name.
 *
 * ## The room-key zero, a second time, one axis over
 *
 * The three `roomKey` rows were added 2026-09-21 and the first of them was
 * **0**. `roomKey` had three checks and all three varied the *workspace*:
 * two tenants, a delimiter collision between two tenants, and stability. None
 * said that **two notes in one workspace are two different rooms**, so a key
 * that had stopped naming the note passed everything.
 *
 * That matters here more than the arithmetic suggests. `/presence` authorizes
 * a **path** — `canSee` on it, then `objectExists` on it — and then enters
 * `roomKey(workspaceId, notePath)`. The path in the key is the only thing that
 * makes the note it authorized and the room it joined the same note. Without
 * it a team-tier caller cleared for a team note is handed the live text of a
 * private one somebody is typing in: the `canSee`-at-join bound non-negotiable
 * #2 names, defeated by the key rather than by the check.
 *
 * The other two rows moved 1 -> 3 for a reason worth keeping: every check on
 * this function called `roomKey` on **both sides**, so it was its own oracle
 * and a change to it moved the expectation with it. One literal — here, and
 * one on the route — is what makes the self-comparisons mean anything.
 *
 * 🔎 So this is the same lesson as the row above it, one axis over: that zero
 * was *every tenancy check varied the token*; this one is *every room-key
 * check varied the workspace*. **A suite is uniform in whatever its author was
 * not thinking about, and what they were not thinking about is named by the
 * thing they were.** Both were found by sabotage and neither by reading.
 *
 * This file used to hold every one of these checks directly, in one
 * 2,295-line function. It is now a thin facade over
 * `test/presence/*.test.mjs`, split by responsibility, so
 * `import { runPresenceChecks } from "./presence.test.mjs"` keeps working
 * unchanged and every check still runs in its original order. The
 * `WebSocketPair` global mock the room-object sections need is now
 * `fixtures.mjs`'s `withFakeWebSocketPair`, installed and restored once per
 * split file rather than once for the whole mega-section — behaviourally
 * identical, since no section after the first ever reads a pair created by an
 * earlier one, confirmed by tracing every `pairs[` read before splitting.
 */

import { runPresenceRoomKeysAndFramesChecks } from "./presence/roomKeysAndFrames.test.mjs";
import { runPresenceSeedingAndSweepChecks } from "./presence/seedingAndSweep.test.mjs";
import { runPresencePeerSyncAndAgentWriteChecks } from "./presence/peerSyncAndAgentWrites.test.mjs";
import { runPresenceRelayV2SpeculativeUpdateChecks } from "./presence/relayV2SpeculativeUpdates.test.mjs";
import { runPresenceRouteChecks } from "./presence/route.test.mjs";

export async function runPresenceChecks(check) {
  await runPresenceRoomKeysAndFramesChecks(check);
  await runPresenceSeedingAndSweepChecks(check);
  await runPresencePeerSyncAndAgentWriteChecks(check);
  await runPresenceRelayV2SpeculativeUpdateChecks(check);
  await runPresenceRouteChecks(check);
}
