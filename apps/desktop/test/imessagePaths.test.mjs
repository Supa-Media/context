/**
 * The one path this app is allowed to read, and nothing else.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/paths.ts` and reverting:
 *
 *   `isAllowedChatDbPath` weakened to accept any string               11 FAIL
 *     (6 here; 3 in `imessageSqlite.test.mjs`, which refuses a readable
 *     database outside the folder and one reached by traversing out of it;
 *     and 2 in `imessageService.test.mjs`, where the service is handed a
 *     `chatDbPath` naming somebody else's database and must read nothing
 *     from it)
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
