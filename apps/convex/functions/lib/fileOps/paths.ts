/**
 * Path validation and the small path arithmetic every operation shares.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { MAX_PATH_LENGTH } from "./store";
import { FileOpError } from "./errors";

/* -------------------------------------------------------------------------- */
/*                                    paths                                   */
/* -------------------------------------------------------------------------- */

/**
 * Clean a caller-supplied path, or `null` if it is not addressable.
 *
 * Mirrors the gateway's `normalizePath`: a trailing slash is stripped rather
 * than rejected (naming a folder `1-projects/` is natural), and `..` is
 * refused outright rather than resolved. The storage adapter refuses these
 * again at its own boundary; two independent checks is deliberate.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string") return null;
  const clean = input
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!clean || clean.length > MAX_PATH_LENGTH) return null;
  if (clean.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  // No control characters, and a newline is the one that mattered.
  //
  // `privacy.md` is a line-oriented format and `renderPrivacyRulesBlock`
  // interpolates a path into it unescaped, so a path carrying `\n` wrote its
  // own extra rules. Measured on this door before the fix: one
  // `setFolderVisibility` declaring **private** for
  // `2-areas/hr: team\n  1-projects/junk` published `2-areas/hr` to the whole
  // team, and one `setVisibility` declaring **private** for
  // `2-areas/salaries.md: team\n  1-projects/junk.md` left
  // `note_overrides` holding that note twice — `private` then `team`, the
  // later winning. The call declared `private` both times, so the console
  // asked for no publish confirmation.
  //
  // The hostile input is a KEY IN THE BUCKET, not the owner's typing:
  // `writableAsRule`'s own docstring says a newline is a legal S3 key
  // character and names this exact escalation. Obsidian sync, rclone and the
  // provider console all write keys directly.
  //
  // Rejected here, where every path argument arrives, rather than escaped at
  // the renderer: a path with a control character in it is not a path worth
  // preserving. `#422` did this in the gateway; this is the same fix on the
  // other engine.
  if (/[\u0000-\u001F\u007F]/.test(clean)) return null;
  return clean;
}

export function requirePath(input: string): string {
  const path = normalizePath(input);
  if (path === null) throw new FileOpError("PATH_INVALID", "That path is not valid.");
  return path;
}

/** The empty string is the bucket root, which normalizePath cannot express. */
export function requireFolderPath(input: string): string {
  const trimmed = input.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (trimmed === "") return "";
  return requirePath(trimmed);
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}

/** `2026-08-26T09-14-02-113Z`. Same shape the gateway stamps history with. */
export function timestampSlug(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}
