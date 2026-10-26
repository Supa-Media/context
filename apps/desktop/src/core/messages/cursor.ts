/**
 * How far the Messages backup has read `chat.db`, kept between launches.
 *
 * Three positions, because the backup reads in three directions:
 *
 *  - `newest`: every row up to this ROWID has been sent. New texts are read
 *    forward from here.
 *  - `oldest`: every row from this ROWID up has been sent. History is read
 *    backward from here, a page at a time, so the newest years arrive first.
 *    `null` until the first pass has looked; `1` or less once all of it has
 *    gone.
 *  - `changesAfterNs`: edits and unsends after this Apple-epoch instant have
 *    been sent. An edit changes an old row without adding one, so ROWIDs
 *    alone never see it.
 *
 * The two digests say what was last sent of the chat list and the names, so
 * they are sent again only when they change.
 *
 * Pictures and documents have their own two positions, over `attachment`
 * ROWIDs rather than `message` ones (`files.ts`), read in the same two
 * directions; videos have two more, so either switch can be off for a while
 * and pick up where it stopped; and one running count of the bytes sent. A cursor
 * written before they existed has none, and its files start from a first
 * look while its texts carry on where they were.
 *
 * `chat.db` itself is the queue. A position moves only after the gateway has
 * kept what was read, so a failed upload, a closed lid or a crash means the
 * same rows are read and sent again, and the gateway folds them by id.
 *
 * Repaired, never trusted, like every file this app keeps: anything that is
 * not a cursor of this version reads as a fresh one, which costs one more
 * full copy (folded to the same records) and loses nothing.
 */

export interface BackupCursor {
  version: 1;
  newest: number;
  oldest: number | null;
  changesAfterNs: string;
  chatsDigest: string | null;
  peopleDigest: string | null;
  filesNewest: number;
  filesOldest: number | null;
  videosNewest: number;
  videosOldest: number | null;
  filesBytes: number;
}

export const BACKUP_CURSOR_VERSION = 1;

export const FRESH_BACKUP_CURSOR: BackupCursor = Object.freeze({
  version: BACKUP_CURSOR_VERSION,
  newest: 0,
  oldest: null,
  changesAfterNs: "0",
  chatsDigest: null,
  peopleDigest: null,
  filesNewest: 0,
  filesOldest: null,
  videosNewest: 0,
  videosOldest: null,
  filesBytes: 0,
});

function rowId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function normalizeBackupCursor(raw: unknown): BackupCursor {
  if (typeof raw !== "object" || raw === null) return { ...FRESH_BACKUP_CURSOR };
  const source = raw as Record<string, unknown>;
  if (source["version"] !== BACKUP_CURSOR_VERSION) return { ...FRESH_BACKUP_CURSOR };
  const newest = rowId(source["newest"]);
  const oldest = source["oldest"] === null ? null : rowId(source["oldest"]);
  const changes = typeof source["changesAfterNs"] === "string" && /^\d{1,20}$/.test(source["changesAfterNs"]) ? source["changesAfterNs"] : null;
  if (newest === null || changes === null || (source["oldest"] !== null && oldest === null)) return { ...FRESH_BACKUP_CURSOR };
  // A history position above the forward one is a file nobody wrote.
  if (oldest !== null && oldest > newest + 1) return { ...FRESH_BACKUP_CURSOR };
  return {
    version: BACKUP_CURSOR_VERSION,
    newest,
    oldest,
    changesAfterNs: changes,
    chatsDigest: digest(source["chatsDigest"]),
    peopleDigest: digest(source["peopleDigest"]),
    ...filesPositions(source),
  };
}

function filesPositions(source: Record<string, unknown>): Pick<BackupCursor, "filesNewest" | "filesOldest" | "videosNewest" | "videosOldest" | "filesBytes"> {
  const [filesNewest, filesOldest] = positions(source["filesNewest"], source["filesOldest"]);
  const [videosNewest, videosOldest] = positions(source["videosNewest"], source["videosOldest"]);
  return { filesNewest, filesOldest, videosNewest, videosOldest, filesBytes: rowId(source["filesBytes"]) ?? 0 };
}

/** One walk's two positions, or a fresh walk's when they are missing or make no sense. */
function positions(rawNewest: unknown, rawOldest: unknown): [number, number | null] {
  const newest = rowId(rawNewest);
  const oldest = rawOldest === null || rawOldest === undefined ? null : rowId(rawOldest);
  if (newest === null || (oldest === null && rawOldest !== null && rawOldest !== undefined)) return [0, null];
  if (oldest !== null && oldest > newest + 1) return [0, null];
  return [newest, oldest];
}

/** Whether the whole history has been sent. */
export function historyDone(cursor: BackupCursor): boolean {
  return cursor.oldest !== null && cursor.oldest <= 1;
}

/** The later of two Apple-epoch instants, as digit strings of any length. */
export function laterNs(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}
