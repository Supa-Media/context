/**
 * The one path this app is allowed to read, and nothing else.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/paths.ts` and reverting:
 *
 *   `isAllowedChatDbPath` weakened to accept any string                7 FAIL
 *     (6 here, plus 1 more in `imessageSqlite.test.mjs` — the refusal message
 *     `queryChatDb` throws before it ever spawns `sqlite3`)
 */

import { defaultChatDbPath, isAllowedChatDbPath } from "../src/core/imessage/paths.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export function runImessagePathsChecks(check) {
  const expected = join(homedir(), "Library", "Messages", "chat.db");
  check("defaultChatDbPath is under this user's home", defaultChatDbPath() === expected);

  check("the default path is allowed", isAllowedChatDbPath(defaultChatDbPath()));
  check(
    "a path that resolves to the same file via .. segments is still allowed",
    isAllowedChatDbPath(join(homedir(), "Library", "Messages", "..", "Messages", "chat.db")),
  );

  check("a sibling file in the same folder is refused", !isAllowedChatDbPath(join(homedir(), "Library", "Messages", "chat.db-wal")));
  check("a path elsewhere on disk is refused", !isAllowedChatDbPath("/etc/passwd"));
  check("a path claiming to be relative to the real one but escaping it is refused", !isAllowedChatDbPath(join(homedir(), "Library", "Messages", "..", "..", "chat.db")));
  check("a page-supplied absolute-looking string naming another user's file is refused", !isAllowedChatDbPath("/Users/someone-else/Library/Messages/chat.db"));

  check("null is refused", !isAllowedChatDbPath(null));
  check("undefined is refused", !isAllowedChatDbPath(undefined));
  check("a number is refused", !isAllowedChatDbPath(42));
  check("an empty string is refused", !isAllowedChatDbPath(""));
  check("whitespace is refused", !isAllowedChatDbPath("   "));
  check("an object is refused", !isAllowedChatDbPath({ path: defaultChatDbPath() }));
}
