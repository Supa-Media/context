/**
 * A path prior for search: how much a note's place in the workspace counts
 * against it, as a multiplier on its fused score (`meaning/serve.js`
 * `mergeHits`, `tools/search.js` `fuseEverywhere`).
 *
 * Logs and old material are real notes, and a question about them should
 * still find them, but a live note the query is about should rank above a
 * chat log that happens to use the same words. Production, 2026-11-03:
 * "2027 plan objectives owners" put an archived chat log first and the plan's
 * own overview eleventh; "gym weights" showed archived iMessage months and a
 * search-probe note. The multiplier only reorders: a log still shows when
 * nothing else matches, and meeting notes are not logs, so they keep 1.
 */

import { TEX_FOLDER, topLevelRole } from "../../../../packages/shared/src/folderRoles.cjs";

/** The multiplier for a log or archived note: half the score of an ordinary one with the same evidence. */
export const LOG_PRIOR = 0.5;

/** The Inbox's own folders that Context files communications into: the logs of a person's day. */
const INBOX_LOG_FOLDERS = Object.freeze(["sessions", "imessage", "email", "google-chat", "calendar"]);

/** Tex's folders that hold what Tex wrote down as it ran, not what Tex knows about the person. */
const TEX_LOG_FOLDERS = Object.freeze(["heartbeat", "dreams", "housekeeping", "handbacks", "attention", "transcripts"]);

/**
 * Folders at any depth that hold a running record rather than knowledge: Tex's review logs and retired AI setups.
 * Production, 2026-11-04: a search across workspaces put eleven `tex-reviews/` logs and `setups/retired/` copies
 * above the notes the words were about.
 */
const LOG_FOLDERS_ANYWHERE = Object.freeze(["tex-reviews", "retired"]);

/** The search-probe folder: benchmark tool notes whose fingerprint equals a query. */
const SEARCH_PROBE_FOLDER = "search-probes";

/** A path without its `@name/` workspace prefix, which a search across workspaces adds. */
function withoutWorkspace(path) {
  return path.replace(/^@[^/]+\//, "");
}

/**
 * The multiplier for a note at `path`: `LOG_PRIOR` for an archived note or a
 * log, else 1. Takes a workspace-relative path or one with `@name/` in front.
 *
 * @param {string} path
 * @returns {number}
 */
export function notePrior(path) {
  if (typeof path !== "string") return 1;
  const segments = withoutWorkspace(path).split("/");
  const [top, second] = segments;
  if (topLevelRole(top) === "archive") return LOG_PRIOR;
  if (topLevelRole(top) === "inbox" && INBOX_LOG_FOLDERS.includes(second?.toLowerCase())) return LOG_PRIOR;
  if (top === TEX_FOLDER && TEX_LOG_FOLDERS.includes(second)) return LOG_PRIOR;
  if (segments.slice(0, -1).some((segment) => LOG_FOLDERS_ANYWHERE.includes(segment.toLowerCase()))) return LOG_PRIOR;
  return 1;
}

/**
 * Is `path` a search probe: a note in a `search-probes/` folder at any depth,
 * which a benchmark writes with a fingerprint equal to a query. Such a note is
 * never shown as an answer.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isSearchProbe(path) {
  if (typeof path !== "string") return false;
  return withoutWorkspace(path).split("/").slice(0, -1).includes(SEARCH_PROBE_FOLDER);
}
