/**
 * The unlock session: what "this note is open right now" is made of.
 *
 * A passphrase note is opened by 32 bytes that exist for as long as somebody is
 * working and not one second longer. This file is the state machine for that,
 * and it is a reducer rather than a hook for the reason the editor's own state
 * machine is: the interesting transitions — a lock arriving while a save is in
 * flight, a second unlock racing the first, an idle timer firing on a note that
 * has already been closed — are exactly the ones that are untestable inside a
 * component and trivial to test here.
 *
 * ## Four rules, and each is a decision rather than an implementation detail
 *
 * 1. **The key lives in memory and nowhere else.** Not `AsyncStorage`, not
 *    `SecureStore`, not a cookie, not the URL, not the offline draft queue, not
 *    a log line. `docs/decisions/encryption.md` says a passphrase is stored
 *    nowhere, and a key derived from it is the passphrase for every purpose an
 *    attacker cares about. `serializable()` exists so a test can assert that
 *    what this module would ever hand to persistence contains neither.
 * 2. **The passphrase itself is not kept at all**, not even in memory. It is
 *    consumed by the derivation and dropped; `unlocked()` takes the key.
 *    Changing a passphrase therefore asks for both, once, rather than
 *    remembering the old one from an unlock ten minutes ago.
 * 3. **Locking is instant and total.** `lock()` drops every key for every note,
 *    because a person who locks is answering a question about the room they are
 *    in, not about one file.
 * 4. **Idle auto-lock is time-based and checked, never trusted to a timer.**
 *    `sweep(now)` is what actually locks, so a suspended laptop, a backgrounded
 *    tab and a machine that slept through the timeout all lock on the next
 *    interaction rather than staying open because a `setTimeout` never fired.
 *    The UI calls `sweep` on a tick and on every action; the reducer never
 *    holds a timer of its own.
 */

/** How long an unlocked note stays unlocked without being touched. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export interface UnlockedNote {
  /** The key that opens this note. Never leaves this process. */
  key: Uint8Array;
  /** When it was last used, for the idle sweep. */
  touchedAt: number;
}

export interface SessionState {
  /** Path -> the key that opens it. Empty when everything is locked. */
  open: Record<string, UnlockedNote>;
  idleMs: number;
  /** Why the last lock happened, for the copy the person sees. */
  lastLock: "idle" | "manual" | null;
}

export type SessionAction =
  | { type: "unlocked"; path: string; key: Uint8Array; at: number }
  | { type: "touched"; path: string; at: number }
  | { type: "closed"; path: string }
  | { type: "lock"; reason?: "idle" | "manual" }
  | { type: "sweep"; at: number }
  | { type: "idleMs"; idleMs: number };

export const initialSessionState: SessionState = { open: {}, idleMs: DEFAULT_IDLE_MS, lastLock: null };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "unlocked":
      return {
        ...state,
        lastLock: null,
        open: { ...state.open, [action.path]: { key: action.key, touchedAt: action.at } },
      };

    case "touched": {
      const entry = state.open[action.path];
      // Touching a note that is not open is not an error and must not create an
      // entry: an idle sweep landing between a keystroke and its handler would
      // otherwise resurrect a note with no key in it.
      if (!entry) return state;
      return {
        ...state,
        open: { ...state.open, [action.path]: { ...entry, touchedAt: action.at } },
      };
    }

    case "closed": {
      if (!state.open[action.path]) return state;
      const open = { ...state.open };
      // Closing a tab drops that note's key. Keeping it "in case they come back"
      // is how an unlock outlives the intent behind it.
      zero(open[action.path]);
      delete open[action.path];
      return { ...state, open };
    }

    case "lock": {
      if (Object.keys(state.open).length === 0) {
        return { ...state, lastLock: action.reason ?? "manual" };
      }
      for (const entry of Object.values(state.open)) zero(entry);
      return { ...state, open: {}, lastLock: action.reason ?? "manual" };
    }

    case "sweep": {
      const stale = Object.entries(state.open).filter(
        ([, entry]) => action.at - entry.touchedAt >= state.idleMs,
      );
      if (stale.length === 0) return state;
      const open = { ...state.open };
      for (const [path, entry] of stale) {
        zero(entry);
        delete open[path];
      }
      return { ...state, open, lastLock: "idle" };
    }

    case "idleMs":
      return { ...state, idleMs: Math.max(1000, action.idleMs) };

    default:
      return state;
  }
}

/** Is this note open right now? */
export function isUnlocked(state: SessionState, path: string): boolean {
  return state.open[path] !== undefined;
}

/** The key for a note, or `null`. The only way out of this module. */
export function keyFor(state: SessionState, path: string): Uint8Array | null {
  return state.open[path]?.key ?? null;
}

/** How long until this note locks itself, in ms; `null` when it is already locked. */
export function msUntilLock(state: SessionState, path: string, now: number): number | null {
  const entry = state.open[path];
  if (!entry) return null;
  return Math.max(0, entry.touchedAt + state.idleMs - now);
}

/**
 * What this session would look like if anything ever persisted it.
 *
 * Nothing does, and this function is how that is *checked* rather than
 * asserted: `__tests__/passphraseSession.test.ts` locks a state full of keys
 * through here and greps the JSON for the key bytes and for the passphrase.
 * A future edit that starts storing the session — a draft queue, a devtools
 * snapshot, an error report — gets whatever this returns and no more.
 */
export function serializable(state: SessionState): { openPaths: string[]; idleMs: number } {
  return { openPaths: Object.keys(state.open), idleMs: state.idleMs };
}

/**
 * Overwrite a key's bytes before dropping the reference.
 *
 * Best effort in a garbage-collected runtime, and worth doing anyway: the
 * alternative is leaving the bytes that open somebody's note sitting in a heap
 * snapshot for as long as the tab lives.
 */
function zero(entry: UnlockedNote): void {
  entry.key.fill(0);
}
