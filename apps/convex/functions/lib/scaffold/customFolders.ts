/**
 * Validating an owner's own root folders for a `custom` layout.
 *
 * Split out of `lib/scaffold.ts` — see that file's header for the scaffolder's
 * overall rules.
 */

import { INDEX_KEY, PRIVACY_KEY, type CustomFolder } from "./store";

/* -------------------------------------------------------------------------- */
/*                          caller-supplied root folders                      */
/* -------------------------------------------------------------------------- */

/**
 * Caps on a custom layout.
 *
 * `MAX_CUSTOM_FOLDERS` is a product judgement — a starting layout somebody can
 * hold in their head — and also a bound on how many objects one call writes
 * into a customer's bucket. `MAX_FOLDER_NAME_LENGTH` is well under the gateway's
 * 512-character path cap, because this is one *segment* of a path that will
 * have note names appended to it. `MAX_FOLDER_DESCRIPTION_LENGTH` is one line
 * of prose, which is what it is asked for as.
 *
 * Exported so a client can refuse the same input before a round trip, and so a
 * test can prove the boundary rather than a number near it.
 */
export const MAX_CUSTOM_FOLDERS = 12;
export const MAX_FOLDER_NAME_LENGTH = 64;
export const MAX_FOLDER_DESCRIPTION_LENGTH = 200;

/**
 * Why a proposed layout was refused. A closed set, so the caller can say
 * something specific without matching on English.
 */
export type FolderRejection =
  | "too-many"
  | "empty"
  | "untrimmed"
  | "too-long"
  | "control-character"
  | "backslash"
  | "not-a-single-segment"
  | "traversal"
  | "hidden"
  | "reserved"
  | "duplicate"
  | "description-empty"
  | "description-too-long"
  | "description-control-character";

export type FolderValidation =
  | { ok: true; folders: CustomFolder[] }
  | { ok: false; reason: FolderRejection; folder?: string };

/** Root keys the scaffold owns. A *folder* by either name would be confusing. */
const RESERVED_FOLDER_NAMES = new Set([INDEX_KEY, PRIVACY_KEY]);

/** C0 controls, DEL, and C1. `\n` and `\r` are in here, which is what keeps a one-line description one line. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Refuse, or hand back exactly what will be written.
 *
 * ## Why this is strict to the point of rudeness
 *
 * A folder name here becomes a **key prefix in somebody's own bucket**, and
 * that bucket is also mounted in Obsidian, synced by rclone, and listed by the
 * gateway. So the failure modes are not cosmetic: `..` is a traversal attempt
 * against the adapter's key builder, a leading `.` produces a folder the
 * gateway classifies as plumbing and hides from every client (a folder the
 * owner created and can never see), a backslash is a path separator on the
 * machine that syncs the bucket even though S3 treats it as an ordinary byte,
 * and a control character produces a key that is unaddressable in a URL and
 * unreadable in a listing.
 *
 * **Every one of these is a refusal, never a repair.** Silently rewriting
 * `../escape` to `escape` or stripping a newline gives the person a folder they
 * did not ask for, under a name they will not recognise, in a bucket we do not
 * own. The one exception is the *description*, which is prose destined for the
 * body of a README rather than for a key: surrounding whitespace there is
 * trimmed, because rejecting a trailing space in a sentence is user-hostile and
 * buys nothing.
 *
 * The scaffolder's own guards still stand behind this — `scaffoldContext`
 * refuses to run at all against a non-empty bucket, and `get`s every key before
 * it `put`s it — so a validation bug here cannot become an overwrite.
 */
export function validateCustomFolders(
  input: readonly { folder: string; description: string }[],
): FolderValidation {
  if (input.length > MAX_CUSTOM_FOLDERS) {
    return { ok: false, reason: "too-many" };
  }

  const folders: CustomFolder[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const folder = entry.folder;
    if (typeof folder !== "string" || folder.length === 0) {
      return { ok: false, reason: "empty" };
    }
    if (folder !== folder.trim()) {
      return { ok: false, reason: "untrimmed", folder };
    }
    if (CONTROL_CHARACTERS.test(folder)) {
      // Reported without echoing the name: a control character in an error
      // string is the same problem one step further along.
      return { ok: false, reason: "control-character" };
    }
    if (folder.length > MAX_FOLDER_NAME_LENGTH) {
      return { ok: false, reason: "too-long", folder };
    }
    if (folder.includes("\\")) {
      return { ok: false, reason: "backslash", folder };
    }
    // Checked before the `.`-prefix rule so traversal gets its own answer.
    if (folder === "." || folder === "..") {
      return { ok: false, reason: "traversal", folder };
    }
    if (folder.includes("/")) {
      return { ok: false, reason: "not-a-single-segment", folder };
    }
    if (folder.startsWith(".")) {
      return { ok: false, reason: "hidden", folder };
    }
    if (RESERVED_FOLDER_NAMES.has(folder.toLowerCase())) {
      return { ok: false, reason: "reserved", folder };
    }
    // Case-insensitive, because two folders differing only in case are a
    // permanent source of "why are my notes in the other one" on a bucket that
    // is also synced to case-insensitive filesystems.
    const fingerprint = folder.toLowerCase();
    if (seen.has(fingerprint)) {
      return { ok: false, reason: "duplicate", folder };
    }
    seen.add(fingerprint);

    const description =
      typeof entry.description === "string" ? entry.description.trim() : "";
    if (description.length === 0) {
      return { ok: false, reason: "description-empty", folder };
    }
    if (description.length > MAX_FOLDER_DESCRIPTION_LENGTH) {
      return { ok: false, reason: "description-too-long", folder };
    }
    // Newlines included: it is asked for as one line, and a multi-line value
    // here lands in a Markdown file where it can open a code fence or a
    // front-matter block that was not there before.
    if (CONTROL_CHARACTERS.test(description)) {
      return { ok: false, reason: "description-control-character", folder };
    }

    folders.push({ folder, description });
  }

  return { ok: true, folders };
}
