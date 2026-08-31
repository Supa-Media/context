import { forgetEverything, forgetWorkspace, waitingOnDevice } from "./cache";
import { ownedKeys, parseKey } from "./keys";
import type { OutboxCounts } from "./outbox";
import { openStore } from "./store";

/**
 * The hygiene layer, wired to the platform's store.
 *
 * `cache.ts` says what forgetting means and takes a `KeyValueStore`; this says
 * *where* — it opens the one the platform gives (`store.web.ts` /`store.ts`)
 * so the console never has to plumb a store down to a sign-out button. The
 * split is the same one every other module in this folder keeps: the rules are
 * pure and testable against a `memoryStore()`, and exactly one file knows which
 * platform it is on.
 *
 * ## Why the store is opened here rather than shared with the hook
 *
 * `useOfflineNotes` opens its own and holds it for the life of the app. On
 * every store that actually persists anything — `localStorage` on web,
 * `AsyncStorage` on native — a second handle is the *same* data, so clearing
 * through this one clears what that one wrote. The exception is the in-memory
 * fallback a browser with site data blocked lands on (`memoryStore()`), where
 * two handles are two `Map`s: this would then clear an empty one. That is not a
 * leak, because the hook's `Map` is unreachable the moment the console unmounts
 * and never survived a reload in the first place — but it is the reason this
 * file does not *claim* to have cleared what it cannot see, and why the verdict
 * below is measured rather than assumed.
 *
 * ## The failure stance
 *
 * **Never block.** Being unable to end a session is worse than a cache that
 * outlives one, so nothing here throws: every call is wrapped, and the caller's
 * sign-out proceeds on any outcome.
 *
 * **Never silently.** An empty `catch` is how "we clear on sign-out" becomes a
 * sentence in a comment that nothing does — which is exactly the state this
 * module was written to end. So the clear is *verified*: it re-lists the keys it
 * owns afterwards rather than trusting that its removals landed, and returns
 * that verdict. Both real stores swallow their own failures (`remove` catches,
 * `keys` answers `[]`), so a clear that did nothing cannot announce itself any
 * other way — and a store that lies about its own keys cannot be checked from
 * here at all, which is stated rather than defended against.
 *
 * A verdict of `false` is warned about once, with a count and no path and no
 * note text — the same rule that keeps note content out of structured logs. A
 * log is the only channel that outlives the screen: by the time this answers,
 * the session is over and the console is being replaced, so there is nobody
 * left to show a notice to. The verdict is returned as well as warned about, so
 * a caller that *does* still have a surface can use it; the two that exist
 * today deliberately do not.
 */

export interface ForgetResult {
  /** Nothing this feature owns was left behind, measured rather than assumed. */
  cleared: boolean;
}

/**
 * Say that something was left behind, and say nothing about what.
 *
 * Counts only. A key carries a bucket path, and a path is a note's name — the
 * same rule that keeps note content out of structured logs applies to this one.
 */
function warnLeftBehind(what: string, left: number): void {
  console.warn(`[offline] ${what}: ${left} record(s) could not be removed from this device`);
}

/** The store itself failed. Neither real one can — see the file comment. */
function warnStoreUnusable(what: string): void {
  console.warn(`[offline] ${what}: this device's store could not be read or written`);
}

/**
 * Forget every local copy, for every context.
 *
 * Called on sign-out and on account deletion. Note text is the customer's
 * private content and a signed-out browser has no business holding a readable
 * copy of it; the queue goes with it, because a queue that survived would drain
 * into the bucket of whoever signs in next on that machine.
 */
export async function forgetLocalCopies(): Promise<ForgetResult> {
  try {
    const store = openStore();
    await forgetEverything(store);
    const left = ownedKeys(await store.keys());
    if (left.length > 0) warnLeftBehind("sign-out", left.length);
    return { cleared: left.length === 0 };
  } catch {
    // Neither real store can reject — see the file comment — so this is a
    // substituted store or a platform that broke its own contract. Reporting
    // failure is the honest answer; refusing to sign out is not.
    warnStoreUnusable("sign-out");
    return { cleared: false };
  }
}

/**
 * Forget one context.
 *
 * For a context that was left, revoked, or whose bucket was rebound — in each
 * case what is cached is a copy of somewhere the person can no longer reach, or
 * of somewhere else entirely.
 */
export async function forgetContextCopies(workspaceId: string): Promise<ForgetResult> {
  try {
    const store = openStore();
    await forgetWorkspace(store, workspaceId);
    const left = (await store.keys()).filter(
      (key) => parseKey(key)?.workspaceId === workspaceId,
    );
    if (left.length > 0) warnLeftBehind("leave", left.length);
    return { cleared: left.length === 0 };
  } catch {
    warnStoreUnusable("leave");
    return { cleared: false };
  }
}

/**
 * What this device is holding that the bucket has never seen.
 *
 * Queued writes outside the context on screen, plus every draft. The console
 * knows its own queue and nothing about the others; sign-out discards all of
 * them. See `waitingOnDevice` for why the open context's queue is excluded
 * rather than re-counted.
 */
export async function unsentOnDevice(
  exceptQueueIn: string | null,
): Promise<OutboxCounts> {
  try {
    return await waitingOnDevice(openStore(), exceptQueueIn);
  } catch {
    // A count that could not be read is reported as nothing waiting rather
    // than as a fabricated number. It makes the warning a floor, which is the
    // direction the note census fails in too.
    return { pending: 0, conflicted: 0, rejected: 0 };
  }
}
