/**
 * Which session a write on this device belongs to.
 *
 * ## Why a counter and not a bigger clear
 *
 * `forgetLocalCopies` deletes the keys that exist at the moment it runs. That
 * is all a `remove()` loop can be, and on its own it makes exactly one of the
 * two claims sign-out has to make: *gone before the session ends*. The other —
 * *stays gone* — is a statement about the future, and nothing in a list of
 * removals says anything about it.
 *
 * The offline layer is a set of fire-and-forget writes closed over a store
 * handle that is still perfectly usable after the clear: `rememberNote`,
 * `rememberBody`, `rememberListing`, the debounced `rememberDraft`, the
 * debounced queue persist, and `flush` from a drain settling. The reads that
 * feed them are Convex actions, which `ConvexReactClient.action()` gives no
 * client-side timeout, so one started before the press can land arbitrarily
 * long after it — and neither sign-out nor unmount cancels any of them. The
 * measured result is a **private-tier note body back in `localStorage` after
 * sign-out**, keyed by workspace and by nothing about who read it, and a queue
 * the person was told had been discarded written straight back down.
 *
 * So the clear needs a barrier beside it. The epoch is bumped **before** the
 * removals rather than after, because a write racing the clear must be dropped
 * rather than land in the gap between the last `remove()` and the return.
 *
 * ## Why it re-arms by itself
 *
 * `useOfflineNotes` captures the number once at mount. Everything that mount
 * ever writes carries that capture, so ending a session invalidates every
 * writer belonging to it in one increment, and the next console mount captures
 * the new number and caches normally again. Nothing has to be reset, which
 * matters: a barrier that had to be lowered again by hand is a barrier that
 * stays raised the day somebody forgets, and the whole feature would go quiet
 * with no error anywhere.
 *
 * A "simplification" to a boolean `signedOut` flag costs exactly that — it has
 * no way to say *whose* session a pending write belongs to, so it must either
 * be cleared on the next mount (a race with the writes still in flight from the
 * old one) or never (the feature dies after one sign-out).
 *
 * ## The cost, stated
 *
 * A mount whose session has ended stops caching for good, and the only thing
 * that ends a session is `forgetLocalCopies`. In every real flow the console is
 * unmounting a moment later — sign-out, account deletion — so nothing notices.
 * The one case where it does not is a `signOut()` that itself fails after the
 * clear has run, leaving somebody on a live console whose offline layer is
 * quietly inert (and whose `durable` still says `true`). That is accepted
 * rather than engineered around: the cache was just deliberately emptied, the
 * person was on their way out, and a reload re-arms it. The alternative —
 * lowering the barrier on some condition other than a new mount — is the race
 * this exists to close, and it would be reopened for a corner nobody is in.
 *
 * ## What it does not do
 *
 * It is not a cancellation. A read already in flight still completes, and a
 * queued write already handed to the network still reaches the bucket; what
 * stops is anything landing **on this device** under a session that is over,
 * plus a drain that has not started yet — that last one because it would send
 * the queue the person pressed "discard" on, and refusing to start is not the
 * same as aborting one mid-flight. Cancelling the calls themselves is a
 * different piece of work with different failure modes, and doing it badly —
 * an aborted write whose outcome nobody learns — is worse than letting one
 * finish and discarding what it wanted to store.
 */

let epoch = 0;

/** The session writes made from now on belong to. */
export function currentEpoch(): number {
  return epoch;
}

/**
 * End the current session for the purposes of local storage.
 *
 * Called by `forgetLocalCopies` before it removes anything. Returns the new
 * epoch so a caller can assert on it rather than on a private counter.
 */
export function endSession(): number {
  epoch += 1;
  return epoch;
}
