/**
 * Full Disk Access: the one permission macOS will not let an app ask for.
 *
 * `~/Library/Messages/chat.db` is readable only by a process holding Full
 * Disk Access, and unlike the microphone or Screen Recording there is no
 * `NSFullDiskAccessUsageDescription`, no `systemPreferences.askForFullDiskAccess`,
 * and no system dialog this app can raise. The only way to find out whether it
 * has the permission is to **attempt the read and see what happens** — so this
 * module has no `request()`, on purpose, unlike
 * `core/capture/permissions.ts`'s microphone and screen broker: there is
 * nothing here to request.
 *
 * `detectFullDiskAccess` is a pure function over an injected attempt, for the
 * same reason every other macOS-only seam in this app is: `main/imessage.ts`
 * supplies the real attempt — one `sqlite3 -readonly` query against the real
 * database — and the suite supplies one that answers from a script.
 */

/** What the attempt found. */
export type FullDiskAccessStatus = "granted" | "denied" | "unknown";

/**
 * A distinguishable failure from the attempted read, so `classifyAttemptError`
 * can tell "this file exists and the OS refused to open it" (denied) from
 * "there is nothing to read yet" (unknown) without inspecting a message string
 * an OS could phrase differently release to release.
 */
export class ChatDbUnreadable extends Error {
  readonly reason: "permission" | "missing" | "other";

  constructor(reason: "permission" | "missing" | "other", message: string) {
    super(message);
    this.name = "ChatDbUnreadable";
    this.reason = reason;
  }
}

/**
 * Attempt the one read that answers "does this process have Full Disk
 * Access", and say what it found.
 *
 * `"denied"` only for a read that failed **for a permission reason** —
 * `ChatDbUnreadable("permission", …)`. Any other failure, including "the file
 * does not exist" (nobody has ever used Messages on this Mac, or it has been
 * deleted), answers `"unknown"` rather than `"denied"`: telling somebody to go
 * grant Full Disk Access for a problem that granting it would not fix is a
 * dead end dressed as an instruction, and this feature stays off either way
 * until an attempt actually succeeds.
 */
export async function detectFullDiskAccess(
  attempt: () => Promise<unknown>,
): Promise<FullDiskAccessStatus> {
  try {
    await attempt();
    return "granted";
  } catch (error) {
    if (error instanceof ChatDbUnreadable && error.reason === "permission") return "denied";
    return "unknown";
  }
}

/** The exact System Settings pane a person needs, as the deep link macOS honours. */
export const FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/** The exact menu path, for the sentence a person reads when the deep link is not available. */
export const FULL_DISK_ACCESS_SETTINGS_PATH = "System Settings → Privacy & Security → Full Disk Access";

/**
 * The real attempt: can this process even open `chat.db` for reading?
 *
 * `node:fs`'s `access` is enough to answer the TCC question and cheap enough
 * to run before every larger query, without ever reading a byte of message
 * content to find out — macOS's Full Disk Access gate blocks `open(2)`
 * itself, so an `EPERM`/`EACCES` here is the same refusal a `sqlite3` call
 * would hit, discovered without spawning a process to learn it.
 *
 * The three outcomes distinguished, and why each is what it is:
 *
 *  - **`ENOENT`** — the file does not exist. Nobody has ever used Messages on
 *    this Mac, or `chat.db` was moved. Full Disk Access would not fix this,
 *    so it is `"missing"`, which `detectFullDiskAccess` reads as `"unknown"`
 *    rather than `"denied"` — see that function's own doc for why the
 *    distinction matters to the sentence a person is shown.
 *  - **`EPERM` / `EACCES`** — the file exists and the OS refused to open it.
 *    This is Full Disk Access, exactly.
 *  - **anything else** — a locked database, a permissions bit nobody expects,
 *    a filesystem error. Also `"other"`, for the same reason `"missing"` is:
 *    there is no evidence here that granting Full Disk Access is the fix.
 */
export async function attemptChatDbRead(path: string): Promise<void> {
  const { access, constants } = await import("node:fs/promises");
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new ChatDbUnreadable("missing", "chat.db does not exist on this Mac yet");
    if (code === "EPERM" || code === "EACCES") {
      throw new ChatDbUnreadable("permission", "Full Disk Access has not been granted");
    }
    throw new ChatDbUnreadable("other", code ?? "chat.db could not be opened");
  }
}

/**
 * The notice shown when this Mac has not granted Full Disk Access.
 *
 * Names the exact place to go, in case the deep link this app offers to open
 * does not — a person on an older macOS release, a managed Mac whose settings
 * app is locked to a different pane — and says what to do once there,
 * because "Full Disk Access" alone does not say which of the two lists on
 * that screen or which switch to flip.
 */
export function fullDiskAccessNotice(appName: string): string {
  return (
    `${appName} needs Full Disk Access to read your iMessage history, and macOS will not show a ` +
    `permission dialog for this one — it has to be granted by hand. Open ${FULL_DISK_ACCESS_SETTINGS_PATH}, ` +
    `add ${appName} to the list (or turn its switch on if it is already there), then come back and try again. ` +
    "Nothing is read until it is granted, and no iMessage content is stored anywhere but your own context."
  );
}
