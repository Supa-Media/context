/**
 * The one process this app spawns to read iMessage history: `/usr/bin/sqlite3`.
 *
 * Electron 33 ships no SQLite binding, and this package takes no native
 * modules — so rather than a driver, this app shells out to the copy of
 * `sqlite3` every Mac already has, exactly as `platform/exec.ts` already does
 * for AppleScript. `-readonly` and `?mode=ro` both say the same thing twice on
 * purpose: `-readonly` is the CLI flag and the URI mode is the belt, so a
 * future edit that drops one still leaves this app unable to write to
 * somebody's Messages database even if it tried to.
 *
 * **The database is never copied.** Every call here opens
 * `~/Library/Messages/chat.db` in place, through a URI connection string that
 * WAL-mode SQLite already supports for a second, read-only reader while
 * Messages.app holds the database open.
 *
 * This file is the only place `/usr/bin/sqlite3` is spawned. Every query it
 * runs comes from `schema.ts`, which only ever splices validated digit
 * strings into SQL text — nothing here interpolates a path, a chat name, or
 * any other value a sender's own device chose the bytes of.
 */

import { run } from "../../platform/exec.ts";
import { ChatDbUnreadable } from "./permission.ts";
import { isAllowedChatDbPath } from "./paths.ts";

const SQLITE3_BINARY = "/usr/bin/sqlite3";

/** A `file:` URI opening `path` read-only, immune to the shell quoting that a bare `-readonly` path is not. */
function readOnlyUri(path: string): string {
  return `file:${encodeURI(path)}?mode=ro&immutable=0`;
}

/**
 * Run one query against `chat.db` and parse its `-json` output.
 *
 * @param path Must be `isAllowedChatDbPath` — see `paths.ts`. Refused rather
 *   than passed through, so a caller that somehow received a page-supplied
 *   path (there is no such channel today; this is the backstop if one is ever
 *   added by mistake) cannot turn this into an arbitrary-file reader.
 */
export async function queryChatDb(path: string, sql: string, maxBufferBytes?: number): Promise<unknown[]> {
  if (!isAllowedChatDbPath(path)) {
    throw new ChatDbUnreadable("other", "refused: not this Mac's own chat.db");
  }

  let stdout: string;
  try {
    stdout = await run(
      SQLITE3_BINARY,
      ["-readonly", "-json", "-cmd", ".timeout 3000", readOnlyUri(path), sql],
      { timeoutMs: 15_000, maxBuffer: maxBufferBytes ?? 16 * 1024 * 1024 },
    );
  } catch (error) {
    throw classifySqliteFailure(error);
  }

  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new ChatDbUnreadable("other", "chat.db answered with something that was not JSON");
  }
}

/**
 * `run`'s own rule is to drop every detail from the underlying error — a
 * `sqlite3` failure message can echo back a fragment of the query, and this
 * one is a database of somebody's messages. So this app cannot read *why*
 * `sqlite3` failed from the error text at all, only that it did, and the
 * permission question is answered by a **separate**, deliberately minimal
 * probe instead: `permission.ts`'s `attemptChatDbRead`, an `fs.access` check
 * that distinguishes "denied" from "missing" without spawning `sqlite3` at
 * all, run once before the sync loop starts and on every "try again".
 *
 * `run` failing here (after that probe already succeeded) is therefore always
 * classified as `"other"` — a timeout, a locked database, a corrupt file — and
 * never silently re-interpreted as a permission refusal it has no evidence
 * for.
 */
function classifySqliteFailure(error: unknown): ChatDbUnreadable {
  const message = error instanceof Error ? error.message : "sqlite3 failed";
  return new ChatDbUnreadable("other", message);
}
