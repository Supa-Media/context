/**
 * Full Disk Access: attempted, never requested.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/permission.ts` and
 * reverting:
 *
 *   any `ChatDbUnreadable` (missing included) classified as `"denied"`   2 FAIL
 */

import {
  ChatDbUnreadable,
  FULL_DISK_ACCESS_SETTINGS_PATH,
  FULL_DISK_ACCESS_SETTINGS_URL,
  attemptChatDbRead,
  detectFullDiskAccess,
  fullDiskAccessNotice,
} from "../src/core/imessage/permission.ts";
import { defaultChatDbPath } from "../src/core/imessage/paths.ts";

export async function runImessagePermissionChecks(check) {
  check(
    "a successful attempt reports granted",
    (await detectFullDiskAccess(async () => "ok")) === "granted",
  );
  check(
    "a permission failure reports denied",
    (await detectFullDiskAccess(async () => {
      throw new ChatDbUnreadable("permission", "nope");
    })) === "denied",
  );
  check(
    "a missing-file failure reports unknown, NOT denied — Full Disk Access would not fix a file that does not exist",
    (await detectFullDiskAccess(async () => {
      throw new ChatDbUnreadable("missing", "no such file");
    })) === "unknown",
  );
  check(
    "any other failure reports unknown rather than denied",
    (await detectFullDiskAccess(async () => {
      throw new Error("locked database");
    })) === "unknown",
  );
  check(
    "a non-ChatDbUnreadable throw (a bug elsewhere) still reports unknown rather than crashing the caller",
    (await detectFullDiskAccess(async () => {
      throw "a string, not even an Error";
    })) === "unknown",
  );

  check(
    "the deep link opens the exact Full Disk Access pane",
    FULL_DISK_ACCESS_SETTINGS_URL === "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  );
  check(
    "the settings path names all three levels a person has to walk, in order",
    FULL_DISK_ACCESS_SETTINGS_PATH === "System Settings \u2192 Privacy & Security \u2192 Full Disk Access",
  );
  const notice = fullDiskAccessNotice("Context");
  check("the notice names the app", notice.includes("Context"));
  check("the notice names the exact System Settings path", notice.includes(FULL_DISK_ACCESS_SETTINGS_PATH));

  // The consent has to be honest in both directions: it must say macOS will
  // NOT put a dialog up (so nobody waits for one that is never coming), and it
  // must never imply this app can raise one — there is no
  // `NSFullDiskAccessUsageDescription` and no `askForFullDiskAccess`, so a
  // sentence promising a prompt is a sentence promising something impossible.
  check(
    "the notice says outright that macOS will not show a dialog for this one",
    notice.includes("will not show a permission dialog"),
  );
  check("...and says it has to be granted by hand", notice.includes("granted by hand"));
  const lowered = notice.toLowerCase();
  check(
    "...and never claims this app can ask for, request or prompt for the permission",
    !["click allow", "we will ask", "when prompted", "tap allow", "grant it when asked", "request access"].some((claim) =>
      lowered.includes(claim),
    ),
  );
  check(
    "...and states the two facts a person actually needs before deciding: nothing is read until it is granted, and nothing leaves their own context",
    notice.includes("Nothing is read until it is granted") && notice.includes("your own context"),
  );
  check(
    "the module offers no request() at all — there is nothing to request",
    typeof (await import("../src/core/imessage/permission.ts")).request === "undefined",
  );

  // -- attemptChatDbRead: real fs.access, exercised for real on any OS -------
  // A path that does not exist is the one shape this sandbox can prove without
  // a Mac: ENOENT must classify as "missing", never "permission".
  let missingClassifiedRight = false;
  try {
    await attemptChatDbRead("/definitely/does/not/exist/chat.db");
  } catch (error) {
    missingClassifiedRight = error instanceof ChatDbUnreadable && error.reason === "missing";
  }
  check("attemptChatDbRead classifies a nonexistent file as missing, not permission", missingClassifiedRight);

  check(
    "the default path is at least well-formed enough to attempt (does not itself throw synchronously)",
    typeof defaultChatDbPath() === "string" && defaultChatDbPath().endsWith("chat.db"),
  );

  const detectedFromRealAttempt = await detectFullDiskAccess(() => attemptChatDbRead("/definitely/does/not/exist/chat.db"));
  check("wired together, a missing chat.db reports unknown rather than denied", detectedFromRealAttempt === "unknown");
}
