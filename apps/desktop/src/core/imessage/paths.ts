/**
 * Where `chat.db` lives, and the one path this app will ever read.
 *
 * There is no setting, no IPC argument and no bridge channel that names a
 * database path — `main/imessage.ts` never accepts one from the page, and this
 * module exists so that guarantee is a check rather than an intention. macOS
 * keeps a person's iMessage history at exactly one place per account, and
 * reading anything else is reading a file this feature was never asked about.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The only database this app will ever open. */
export function defaultChatDbPath(): string {
  return join(homedir(), "Library", "Messages", "chat.db");
}

/**
 * Is `candidate` the one path this app is allowed to read?
 *
 * Resolved before comparison, so `~/Library/Messages/../Messages/chat.db` and
 * a relative path that happens to land on the right file are accepted for the
 * right reason rather than by coincidence — and, symmetrically, so a `..`-
 * bearing path that resolves *outside* `~/Library/Messages` is refused for
 * being outside it, not merely for containing dots. Refuses anything that is
 * not a string, including `null`, `undefined`, and every other JS falsy value
 * a malformed call site could pass.
 */
export function isAllowedChatDbPath(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  return resolve(candidate) === resolve(defaultChatDbPath());
}

/** The refusal shown when something asks this app to read a different file. */
export const CHAT_DB_PATH_REFUSAL =
  "iMessage import only ever reads this Mac's own chat.db under ~/Library/Messages; nothing else is a valid source.";
