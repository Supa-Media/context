/**
 * Where this app remembers how far it has read `chat.db`.
 *
 * One number: the highest `message.ROWID` this app has already turned into a
 * note. `sync.ts` reads only rows past it, which is the whole of what makes a
 * sync **incremental** rather than a re-read of the entire history every few
 * minutes. It is a JSON file in `userData`, on the same footing as
 * `DesktopSettings` — never the token store, and never a place that decides
 * what this app may read, only where it last stopped.
 *
 * `normalizeCursor` follows `normalizeSettings`'s rule for the same reason: a
 * cursor file that is missing, truncated, or written by a future version must
 * never crash the app or silently regress to "read everything again" in a way
 * that duplicates a year of notes — it resolves to zero, which is the safe
 * starting point a fresh install already has.
 */

export interface ImessageCursor {
  /** Bumped when the shape changes. */
  version: 1;
  /** The highest `message.ROWID` already synced. `0` means "nothing yet". */
  lastRowId: number;
}

export const CURSOR_VERSION = 1;

export const EMPTY_CURSOR: ImessageCursor = Object.freeze({ version: CURSOR_VERSION, lastRowId: 0 });

/** Repair whatever was on disk. Never throws. */
export function normalizeCursor(raw: unknown): ImessageCursor {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_CURSOR };
  const source = raw as Record<string, unknown>;
  if (source["version"] !== CURSOR_VERSION) return { ...EMPTY_CURSOR };
  const lastRowId = source["lastRowId"];
  if (typeof lastRowId !== "number" || !Number.isSafeInteger(lastRowId) || lastRowId < 0) {
    return { ...EMPTY_CURSOR };
  }
  return { version: CURSOR_VERSION, lastRowId };
}

/**
 * The cursor after a window ending at `maxRowIdSeen` was fully processed.
 *
 * Never moves backward: a cursor is only ever advanced past rows this app has
 * actually turned into notes, and a caller that (through a bug, or a
 * `chat.db` restored from an older backup) computes a smaller "new" value
 * must not be allowed to make the next sync re-read rows that were already
 * written — see `docs/decisions/communications.md` on idempotent upserts:
 * re-running this must change no bytes, and re-processing an already-synced
 * row through `write_note` again is exactly how "no bytes" would stop being
 * true if the day had since been hand-edited.
 */
export function advanceCursor(current: ImessageCursor, maxRowIdSeen: number): ImessageCursor {
  if (!Number.isSafeInteger(maxRowIdSeen) || maxRowIdSeen <= current.lastRowId) return current;
  return { version: CURSOR_VERSION, lastRowId: maxRowIdSeen };
}
