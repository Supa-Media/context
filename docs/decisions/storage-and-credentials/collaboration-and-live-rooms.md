# Storage and credentials — collaboration and live rooms

## A live editing room holds note text, and the enumeration does not list it

**Raised 2026-09-20 by the adversarial review, against the live-merge work in
flight. The call is the owner's; this is the record they need to make it, not
the decision.**

Two people typing in one note need a place where both sets of characters exist
before either is saved. In the design under review that place is the presence
room's update log, in Durable Object storage: every keystroke is appended, the
log is replayed to whoever joins, and one elected member flushes to the bucket
on a debounce.

**The feature's own account of the cost is honest and is quoted rather than
paraphrased**, because it is the better half of this argument: *"While a room is
live, text exists in the room's log — Durable Object storage — until the elected
writer flushes it. That is the one place note content is durable outside the
customer's bucket, it is what lets everybody's letters reach everybody, and it
is dropped when the room empties."*

**Decided by the owner, 2026-09-20: the enumeration changes, not the design.**
Non-negotiable #2 now names a live note's in-flight keystrokes alongside the
buckets and the search databases. The reasoning below stands as the record of
what was weighed; what follows is which way it went and why the alternative was
not taken.

Two people typing in one note need a shared place for characters that are
seconds old, and there is no version of that feature without one — so the
choice was never "log or no log", it was "say so, or hold it somewhere that
loses work". The in-memory option priced below keeps the sentence shorter at
the cost of losing unflushed characters whenever a room is evicted
mid-sentence, which is a worse thing to explain to somebody than one more line
in an enumeration. The enumeration exists so that a customer asking what of
theirs we hold gets a complete answer; extending it is what keeps that true.

**What stays load-bearing** is every bound below, because they are the reason
this is a third category and not an open door: one room per note, append-only,
deleted when the last person leaves, replayed only to a socket that passed
`canSee`, and never the only copy of anything. Remove any of them and the
sentence in #2 stops being honest, which is a different decision from this one
and has to be taken deliberately.

**The original argument, kept.** It cites non-negotiable #3. The binding
citation is #2. #3 says a derivative
must be *"rebuildable from the files, never the only copy of anything"*, and for
a few hundred milliseconds between a keystroke and its flush the log **is** the
only copy of those characters — which is not a derivative at all. But the
sharper constraint is #2's enumeration of what may hold customer data in a
Cloudflare account of ours: *"those buckets, and the per-context search
databases — and nothing of ours."* A Durable Object holding note text is a
**third category, and it is not on that list.** Whichever way this is settled,
that sentence has to change or the design does; leaving both as they are is the
option that is not available.

**What the design does to bound it**, each verified rather than taken on trust:

- the log lives in one Durable Object per `(workspaceId, notePath)`, so it is
  per-tenant by construction and there is no key to get wrong;
- it is replayed only to a socket that passed `canSee` at join, and a socket is
  closed at `PRESENCE_SOCKET_MAX_MS`, so a withdrawn reader stops receiving
  within that bound;
- it is deleted when the last member leaves, and the sweep that deletes it stays
  armed on a non-empty log even at zero sockets, so the deletion is reachable;
- the flush is continuous, so the window in which the log holds unique
  characters is a debounce rather than a session.

**What a reversal would cost, in both directions.** Removing the log removes
concurrent editing: the alternative to a shared place for in-flight characters
is the conflict box this work exists to delete, and "two people typing in one
note" cannot be built without one. Keeping it while leaving #2's enumeration
unamended costs the thing the enumeration is for — a customer asking what of
theirs we hold, and getting an answer that is complete.

**A third option, if the enumeration is to stay closed:** hold the log in memory
rather than in Durable Object storage. It survives hibernation today because
storage does; in memory it would not, so a room evicted mid-sentence loses
unflushed characters. That is a real cost and a smaller one than it sounds — the
flush is continuous — and it is the version that keeps "nothing of ours" true.
Nobody has priced it.

**The test that fails if the bound is reversed** is in
`apps/mcp/test/presence.test.mjs`: the last socket leaving takes the log with
it, a room with anybody still in it keeps every letter, and an empty room that
still holds a log keeps its alarm armed — with a room holding neither as the
non-vacuity half, since an `ensureAlarm` that always armed would pass the third
alone. Before those, the retention guard was implemented and stood on nothing —
the checks beside it asserted a function's *arity*, which a deletion that
cleared the whole prefix would have passed.

The third of those is the one worth naming separately: `dropLogIfEmpty` is only
ever called from `alarm()`, so a guard that deletes correctly and is never
scheduled bounds nothing at all. This paragraph described all three before any
of them existed — they were written against a branch that did not merge — which
is the same failure it is documenting, one level up. They exist now.

**One thing this work got right that belongs in this file.** The author expected
to need the gateway's first npm dependency and said they would break the
zero-dependency rule deliberately — then read why the rule exists and did not.
`check-gateway-imports.mjs` gives three reasons and the sharpest is that this
workspace hoists, so a bare import would bundle and ship **without ever
appearing in `apps/mcp/package.json`**: an invisible dependency in a Worker that
decrypts a customer's storage credential on every request. The merge logic went
to the clients instead, and updates are opaque bytes to the gateway. That is the
strongest argument for the rule anyone has produced, and it was produced by
someone trying to make an exception to it.


## Automatic collaboration extends the storage contract

The owner approved essential editing history in the customer bucket, in
addition to portable Markdown. The current contract is documented in
[collaboration](../collaboration.md). The older presence-only decisions above
describe the legacy transport; they do not authorize deleting acknowledged
collaboration history when a room empties.
