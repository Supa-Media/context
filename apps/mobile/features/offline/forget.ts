import { forgetEverything, forgetWorkspace, waitingOnDevice } from "./cache";
import { endSession } from "./epoch";
import { keysForWorkspace, ownedKeys } from "./keys";
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
 * ## The clear is a barrier, not a moment
 *
 * A `remove()` loop deletes the keys that exist while it runs, and that is all
 * it can ever be. The offline layer's writers are fire-and-forget over an async
 * store and the reads that feed them are Convex actions with no client-side
 * timeout, so one started before the press lands arbitrarily long after it —
 * and a private note body goes back onto the device *behind* the clear, keyed
 * by workspace and by nothing about who read it. So `endSession()` is called
 * **before** anything is removed: the epoch is what makes "stays gone" a claim
 * rather than a hope, and bumping it first is what stops a write racing the
 * clear from landing in the gap between the last `remove()` and the return.
 * `epoch.ts` carries the argument; `useOfflineNotes` holds the other half.
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
 * file does not *claim* to have cleared what it cannot see, and why that case
 * answers `unmeasured` rather than `cleared`.
 *
 * ## The failure stance
 *
 * **Never block.** Being unable to end a session is worse than a cache that
 * outlives one, so nothing here throws: every call is wrapped, and the caller's
 * sign-out proceeds on any outcome. A rejection is not the only way a store
 * fails to answer, and this codebase is precise about the difference elsewhere
 * — `ConvexReactClient.action()` "neither resolves nor rejects" is why the
 * offline read path exists at all. `AsyncStorage` is a bridge call, and a
 * wedged bridge never settles, so the stance needs a **deadline** as well as a
 * `catch`: without one, "awaited, and first" is a sign-out button that hangs
 * forever, which is the exact failure the stance forbids.
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
 * Every verdict but `cleared` is warned about once, with a count and no path
 * and no note text — the same rule that keeps note content out of structured
 * logs. The one exception is the in-memory fallback, which answers
 * `unmeasured` silently: there is nothing durable to report on, so a warning
 * would be an alarm about records nothing holds.
 *
 * This sentence has now been wrong twice, in opposite directions, which is
 * worth leaving on the record in a file whose comments are the record. It
 * first claimed the non-durable branch warned like the others; the correction
 * then over-swung and said `unmeasured` never warns. It comes from three
 * places and two of them do — `clearEverything`'s catch via
 * `warnStoreUnusable`, and the deadline via `warnStoreSilent`. Only the
 * `!store.durable` early return is quiet. A
 * log is the only channel that outlives the screen: by the time this answers,
 * the session is over and the console is being replaced, so there is nobody
 * left to show a notice to. The verdict is returned as well as warned about, so
 * a caller that *does* still have a surface can use it; the two that exist
 * today deliberately do not.
 */

/**
 * How long the clear may take before the session ends without it.
 *
 * Generous by orders of magnitude for what it bounds — a `localStorage` sweep
 * is microseconds and an `AsyncStorage` one is a few milliseconds — because
 * this is not a latency budget, it is the answer to a bridge that has stopped
 * answering at all. Short enough that nobody experiences it as a hung button.
 *
 * The ordering claim survives it: `endSession()` has already run by the time
 * the deadline can fire, so a clear still grinding away behind a timed-out
 * sign-out cannot be overtaken by a new write, and the removals it does land
 * still land.
 */
export const CLEAR_DEADLINE_MS = 2_000;

/**
 * What this device is holding, after the attempt.
 *
 * Three answers rather than a boolean, because "cleared" and "could not be
 * checked" are different facts and collapsing them is how a verdict starts
 * lying. The in-memory fallback is the case that forces it: this file opens its
 * own handle, so on a `memoryStore()` it measures a `Map` it constructed one
 * line earlier — empty by construction — and a `boolean` has no way to say so.
 * Reporting that as `cleared` would be assumed rather than measured, which is
 * what this module exists not to do; reporting it as *not* cleared would raise
 * an alarm about records nothing durable is holding.
 */
export type ForgetVerdict =
  /** Nothing this feature owns is left, re-listed after the removals. */
  | "cleared"
  /** Records this feature owns are still on the device. */
  | "left-behind"
  /** The store could not be read or written, or this handle cannot see it. */
  | "unmeasured";

export interface ForgetResult {
  verdict: ForgetVerdict;
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

/** The store never answered at all, which is not the same as refusing. */
function warnStoreSilent(what: string): void {
  console.warn(`[offline] ${what}: this device's store did not answer in time`);
}

/**
 * Run the clear, or stop waiting for it.
 *
 * A timeout, not a cancellation: `work` keeps running and its removals still
 * land. What is bounded is how long a person can be held on a sign-out button
 * by a store that has stopped answering — and it is warned about rather than
 * absorbed, because "did not answer" is a different fact from "refused" and
 * the failure stance above forbids either being silent. The timer is always
 * cleared, because a two-second handle left dangling on every sign-out is a
 * two-second handle holding the process open in every test that presses one.
 */
/*
  Frozen because it is returned by identity from both failure paths, so a
  caller that mutated what it received would poison the constant for every
  later call — turning "reported as nothing waiting rather than as a
  fabricated number", which is this function's whole stated promise, into a
  fabricated number that persists. No caller does that today; freezing costs
  nothing and removes the question.
*/
const NOTHING_WAITING: OutboxCounts = Object.freeze({ pending: 0, conflicted: 0, rejected: 0 });

async function withDeadline<T>(
  work: Promise<T>,
  what: string,
  whenSilent: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          warnStoreSilent(what);
          resolve(whenSilent());
        }, CLEAR_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Forget every local copy, for every context.
 *
 * Called on sign-out and on account deletion. Note text is the customer's
 * private content and a signed-out browser has no business holding a readable
 * copy of it; the queue goes with it, because a queue that survived would drain
 * into the bucket of whoever signs in next on that machine.
 *
 * The epoch is ended first and synchronously — before the store is even opened
 * — so that everything after this line is about keys that already exist.
 */
export async function forgetLocalCopies(): Promise<ForgetResult> {
  endSession();
  return withDeadline(clearEverything(), "sign-out", () => ({ verdict: "unmeasured" }));
}

async function clearEverything(): Promise<ForgetResult> {
  try {
    const store = openStore();
    await forgetEverything(store);
    if (!store.durable) return { verdict: "unmeasured" };
    const left = ownedKeys(await store.keys());
    if (left.length > 0) {
      warnLeftBehind("sign-out", left.length);
      return { verdict: "left-behind" };
    }
    return { verdict: "cleared" };
  } catch {
    // Neither real store can reject — see the file comment — so this is a
    // substituted store or a platform that broke its own contract. Reporting
    // failure is the honest answer; refusing to sign out is not.
    warnStoreUnusable("sign-out");
    return { verdict: "unmeasured" };
  }
}

/**
 * Forget one context.
 *
 * For a context that was **left** — the one caller there is. What is cached
 * then is a copy of somewhere the person can no longer reach.
 *
 * The two neighbouring cases a comment here used to claim are deliberately not
 * wired, and the reason is different for each:
 *
 *  - **Revoked.** An owner removing somebody's membership happens on another
 *    machine. There is no event on this device to hang a clear on, and polling
 *    for one would be the console asking "am I still allowed" on a schedule.
 *    The age bound (`MAX_AGE_MS`) is what bounds it instead, and a revoked
 *    grant already fails closed on every *read*: `isServerRefusal` keeps a
 *    refusal from being served off the device.
 *  - **Rebound.** A rebind is very often somebody repairing a broken binding,
 *    and `STORAGE_NOT_CONNECTED` / `STORAGE_UNUSABLE` are on the overridable
 *    allow-list precisely so a person whose bucket is unreachable can still
 *    read what is on their machine (see `cachedAfterRefusal.test.ts`).
 *    Clearing on disconnect would blank the notes of exactly the person that
 *    fallback exists for, at exactly the moment it is doing its job.
 *
 * The residual is stated rather than papered over: an owner who deliberately
 * disconnects storage keeps reading notes off this device until the sweep's
 * age bound catches them. That is a consequence of the allow-list, not of this
 * function, and every such read is stamped with the copy's age on screen.
 */
export async function forgetContextCopies(workspaceId: string): Promise<ForgetResult> {
  return withDeadline(clearContext(workspaceId), "leave", () => ({ verdict: "unmeasured" }));
}

async function clearContext(workspaceId: string): Promise<ForgetResult> {
  try {
    const store = openStore();
    await forgetWorkspace(store, workspaceId);
    if (!store.durable) return { verdict: "unmeasured" };
    // The same set the clear took, through the same function. A verification
    // with its own idea of which keys belong to this context is a verification
    // that reports `cleared` over records nothing looked at — which is the
    // failure this module's "never silently" stance exists to prevent.
    const left = keysForWorkspace(await store.keys(), workspaceId);
    if (left.length > 0) {
      warnLeftBehind("leave", left.length);
      return { verdict: "left-behind" };
    }
    return { verdict: "cleared" };
  } catch {
    warnStoreUnusable("leave");
    return { verdict: "unmeasured" };
  }
}

/**
 * What this device is holding that the bucket has never seen.
 *
 * Queued writes outside the context on screen, plus every draft. The console
 * knows its own queue and nothing about the others; sign-out discards all of
 * them. See `waitingOnDevice` for why the open context's queue is excluded
 * rather than re-counted, and for when the caller must stop excluding it.
 */
export async function unsentOnDevice(
  exceptQueueIn: string | null,
): Promise<OutboxCounts> {
  /*
    Bounded for the same reason the clear is, and the ordering is why it
    matters: `onSignOut` awaits this *first*, so an unbounded count would hang
    the button before the clear's own deadline could ever be reached. A store
    that throws was already handled below; a store that simply never answers is
    the other half, and on native these are bridge calls — `forget.ts` draws
    exactly that distinction one paragraph up and then this call ignored it.
  */
  try {
    return await withDeadline(
      waitingOnDevice(openStore(), exceptQueueIn),
      "the count of unsent work",
      () => NOTHING_WAITING,
    );
  } catch {
    // A count that could not be read is reported as nothing waiting rather
    // than as a fabricated number. It makes the warning a floor, which is the
    // direction the note census fails in too.
    return NOTHING_WAITING;
  }
}
