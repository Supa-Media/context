/**
 * One folder's listing, answered by the workspace object from its own rows and
 * rules, for the app's live file tree (`workspaceStore/treeSockets.js`).
 *
 * **The same answer the Convex tree gives, by the same rules.** This is a port
 * of `listFolder` (`apps/convex/functions/lib/fileOps/listing.ts`) and
 * `listFolderFromNodes` (`apps/convex/functions/lib/nodes/listing.ts`), judged
 * by the gateway's own privacy engine (`privacy/engine.js`): `canSee` decides
 * every file, and a folder is shown exactly when `folderVisibleAtScope` would
 * show it. `apps/convex/__tests__/workspaceObjectListing.test.ts` runs both
 * over the same fixtures and fails on any difference, so neither may drift.
 *
 * The two refusals that matter are kept as they are there:
 * - a folder the caller cannot see answers exactly as an absent one: no
 *   entries, not truncated, the default of its nearest visible ancestor, and
 *   its children are read anyway, so the work does not depend on it;
 * - no rules held means nothing is shown (`manifestUsable: false`, no
 *   entries), failing closed as `readNotes` does.
 */

import {
  canSee,
  effectiveVisibility,
  isPlumbing,
  PRIVACY_KEY,
  readsAsGuest,
  sealedCovers,
  visibilityOf,
} from "../privacy/engine.js";
import { parsedRules } from "./serve.js";
import {
  compareListingEntries,
  folderJobs,
  isRowRole,
  jobAt,
} from "../../../../packages/shared/src/folderRoles.cjs";

/** Rows of one folder read before the listing calls itself short (`NODE_LISTING_ROWS`). */
export const LISTING_ROWS = 5_000;

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The same check `requireFolderPath` makes, returning `null` instead of throwing. */
export function folderPathOf(raw) {
  if (typeof raw !== "string" || raw.length > 1024 || raw.includes("\0")) return null;
  const path = raw.replace(/^\/+|\/+$/g, "");
  if (path === "") return "";
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return path;
}

/**
 * Is a folder worth showing at this clearance? `folderVisibleAtScope`, ported:
 * visible by its own default, or because a rule or exception beneath it opens
 * something to the caller (so a shared note in a private folder stays reachable).
 *
 * @param {string} folderPath
 * @param {{scope: "private"|"team", names: Set<string>}} clearance
 */
export function folderVisibleAtScope(folderPath, clearance, rules, overrides) {
  if (isPlumbing(folderPath)) return false;
  const sealed = sealedCovers(folderPath, rules);
  if (clearance.scope === "private" && !sealed) return true;
  const team = !readsAsGuest(clearance.names) && !sealed;
  const reaches = (visibility) => (visibility === "team" && team) || clearance.names.has(visibility);
  if (reaches(visibilityOf(folderPath, rules))) return true;
  for (const [path, visibility] of overrides) {
    if (reaches(visibility) && path.startsWith(`${folderPath}/`)) return true;
  }
  for (const rule of rules) {
    if (reaches(rule.vis) && rule.prefix.startsWith(`${folderPath}/`)) return true;
  }
  return false;
}

function nearestVisibleAncestor(folder, clearance, rules, overrides) {
  let at = parentOf(folder);
  while (at !== "" && !folderVisibleAtScope(at, clearance, rules, overrides)) at = parentOf(at);
  return at;
}

const isPrivacyKey = (key) => key.toLowerCase() === PRIVACY_KEY;

function describeFile(key, rules, overrides, extra) {
  const inherited = visibilityOf(key, rules);
  const visibility = effectiveVisibility(key, rules, overrides);
  return { kind: "file", path: key, name: baseName(key), visibility, inherited, exception: visibility !== inherited, readOnly: isPrivacyKey(key), ...extra };
}

/**
 * @typedef {{path: string, kind: "file"|"folder", size?: number|null, uploaded?: number|null, role?: string|null, order?: number|null, archiveOf?: string|null}} TreeRow
 * @typedef {{scope: "private"|"team", names: Set<string>}} Clearance
 */

/**
 * One folder at `clearance`.
 *
 * @param {{
 *   folder: string,
 *   clearance: Clearance,
 *   held: object|null,            // the rules as `rows.rules()` holds them (`HeldRules`), or null
 *   children: TreeRow[],          // the folder's live child rows
 *   more: boolean,                // more children than `children` holds
 *   own: TreeRow|null,            // the folder's own live row, or null
 *   roots: TreeRow[],             // the live top-level folders and every row with a job, for `folderJobs`
 * }} input
 */
export function listFolderFromRows({ folder, clearance, held, children, more, own, roots }) {
  const manifestUsable = held !== null && held !== undefined;
  const { rules, overrides } = manifestUsable ? parsedRules(held) : { rules: [], overrides: new Map() };
  const withheld = !manifestUsable || (folder !== "" && !folderVisibleAtScope(folder, clearance, rules, overrides));

  const prefix = folder === "" ? "" : `${folder}/`;
  const entries = [];
  const seenFolders = new Set();
  // Every row is judged whether or not the folder is withheld, so a withheld folder costs what a visible one does.
  for (const row of children) {
    if (row.path === prefix || !row.path.startsWith(prefix) || row.path.slice(prefix.length).includes("/")) continue;
    if (row.kind === "file") {
      if (!canSee(row.path, clearance.scope, rules, overrides, clearance.names)) continue;
      entries.push(
        describeFile(row.path, rules, overrides, {
          ...(Number.isFinite(row.size) ? { size: row.size } : {}),
          ...(Number.isFinite(row.uploaded) ? { updatedAt: row.uploaded } : {}),
        }),
      );
      continue;
    }
    if (seenFolders.has(row.path) || !folderVisibleAtScope(row.path, clearance, rules, overrides)) continue;
    seenFolders.add(row.path);
    const inherited = visibilityOf(row.path, rules);
    entries.push({ kind: "folder", path: row.path, name: baseName(row.path), visibility: inherited, inherited, exception: false, readOnly: false });
  }

  // Folder jobs: the row's own, else at the root the one its name gives (`withFolderJobs`).
  const jobs = folderJobs(
    roots.map((row) => ({ path: row.path, name: baseName(row.path), role: row.role ?? undefined, top: !row.path.includes("/") })),
  );
  const byPath = new Map(children.filter((row) => row.kind === "folder").map((row) => [row.path, row]));
  const drawn = entries.map((entry) => {
    if (entry.kind !== "folder") return entry;
    const row = byPath.get(entry.path);
    const role = isRowRole(row?.role) ? row.role : folder === "" ? jobAt(jobs, entry.path) : null;
    return {
      ...entry,
      ...(role === null ? {} : { role }),
      ...(Number.isFinite(row?.order) ? { order: row.order } : {}),
      ...(isRowRole(row?.archiveOf) ? { archiveOf: row.archiveOf } : {}),
    };
  });
  drawn.sort((a, b) => compareListingEntries(folder, a, b));

  const ownJob =
    folder === "" || own === null || own.kind !== "folder"
      ? null
      : isRowRole(own.role)
        ? own.role
        : folder.includes("/")
          ? null
          : jobAt(jobs, folder);
  const showOwn = !withheld && ownJob !== null;

  return {
    path: folder,
    folderDefault: withheld
      ? visibilityOf(manifestUsable ? nearestVisibleAncestor(folder, clearance, rules, overrides) : "", rules)
      : visibilityOf(folder, rules),
    entries: withheld ? [] : drawn,
    truncated: withheld ? false : more,
    manifestUsable,
    ...(showOwn ? { role: ownJob } : {}),
  };
}
