/**
 * Built-in folders: the five every workspace has, and the extras a workspace
 * can add. One module, read by the gateway, the control plane, the app and
 * the router, so "which folder is the archive" has one answer.
 *
 * ## A folder's job lives on its row, and starts from its name
 *
 * Each built-in folder's tree row carries its job in `role`, under the job's
 * original name (`inbox`, `projects`, ... `website`, `meetings`), so the
 * folder keeps its job when it is renamed or moved (decided by the owner,
 * 2026-10-18; `docs/decisions/app-and-console/folder-jobs.md`). A row is given
 * its job when it is made at the root under a job's name, or the first time a
 * folder that plays one by name is moved. Until then the name decides:
 * `1-projects`, `projects` and `2-Projects` all play the projects role, the
 * number only sorts (`folderRole`). `folderJobs` reads both.
 *
 * ## The five main folders cannot be removed; extras can
 *
 * Inbox, Projects, Areas, Resources and Archive are what every system prompt
 * and `archive_note` rely on, so they cannot be archived, trashed or deleted.
 * In a workspace whose notes are kept by id they can be renamed, moved and
 * nested like any folder (owner, 2026-10-18, replacing the 2026-10-08 lock).
 * Extras (Clients, Teams, Products) can be removed like any folder.
 *
 * ## Order
 *
 * A folder's `order` on its row, when somebody has set one; otherwise Inbox,
 * Projects, Areas, Resources, extras, Website, the person's own folders by
 * name, and Archive last, whatever the numbers say.
 */

const MAIN_ROLES = Object.freeze(["inbox", "projects", "areas", "resources", "archive"]);
const EXTRA_ROLES = Object.freeze(["clients", "teams", "products"]);

/** The name a new workspace gets for each role. Fixed, so it never drifts. */
const DEFAULT_FOLDER = Object.freeze({
  inbox: "0-inbox",
  projects: "1-projects",
  areas: "2-areas",
  resources: "3-resources",
  clients: "4-clients",
  teams: "5-teams",
  products: "6-products",
  archive: "9-archive",
});

/** The folder names a new workspace starts with, in order. */
const MAIN_FOLDERS = Object.freeze(MAIN_ROLES.map((role) => DEFAULT_FOLDER[role]));

const ROLE_LABEL = Object.freeze({
  inbox: "Inbox",
  projects: "Projects",
  areas: "Areas",
  resources: "Resources",
  archive: "Archive",
  clients: "Clients",
  teams: "Teams",
  products: "Products",
});

/**
 * One line per role: what belongs there, in the third person, because a
 * shared workspace has no single reader. It becomes the folder's README and its
 * line in `index.md`, which is what an AI reads when deciding where to file.
 */
const ROLE_DESCRIPTION = Object.freeze({
  inbox:
    "Unfiled captures. Anything that arrives before somebody has decided where it belongs. Empty it by moving notes out, not by deleting them.",
  projects:
    "Active work with a finish line, one folder per project. When a project is done it moves to Archive.",
  areas:
    "Ongoing responsibilities with no finish line, such as health, money or a team somebody runs.",
  resources:
    "Reference material worth finding again: how things work, decisions and why, notes on things read.",
  archive:
    "Finished, cancelled or superseded. Move things here rather than deleting them.",
  clients:
    "One folder per client or customer: who they are, what they need, what was promised and what happened.",
  teams:
    "One folder per team or function: what it owns, how it runs, and what somebody joining it needs.",
  products:
    "One folder per product made or sold: what it is, who it is for, and where it is going.",
});

/** Order in which roles are drawn; own folders sit between extras and archive. */
const ROLE_RANK = Object.freeze({
  inbox: 0,
  projects: 1,
  areas: 2,
  resources: 3,
  clients: 4,
  teams: 5,
  products: 6,
  archive: 9,
});
const OWN_FOLDER_RANK = 8;

const ROLE_PATTERN = /^(?:\d+-)?([a-z]+)$/i;

/**
 * The jobs a folder ROW can carry in `role`: the eight built-ins, the website
 * folder and the meetings folder, always under these original names.
 */
const ROW_ROLES = Object.freeze([...MAIN_ROLES, ...EXTRA_ROLES, "website", "meetings"]);

/** The website folder's name when nothing has moved it (`DEFAULT_WEBSITE_ROOT`). */
const WEBSITE_FOLDER = "website";

const JOB_LABEL = Object.freeze({ ...ROLE_LABEL, website: "Website", meetings: "Meetings" });

/** Where each job is drawn among its siblings when no `order` is set, in steps of ten. */
const JOB_RANK = Object.freeze({ ...ROLE_RANK, website: 7, meetings: 7 });

function isRowRole(value) {
  return typeof value === "string" && ROW_ROLES.includes(value);
}

/**
 * The job a top-level folder NAME plays: a built-in role (`folderRole`), or
 * `website` for the website folder's own name.
 */
function jobOfName(name) {
  if (name === WEBSITE_FOLDER) return "website";
  return folderRole(name);
}

/**
 * The role a top-level folder name plays, or null. Takes a NAME, not a path:
 * pass the first segment. `Archive`, `archive`, `4-archive` and `9-archive`
 * are all `"archive"`; `old-archive` and `archive-2024` are nobody's.
 */
function folderRole(name) {
  if (typeof name !== "string") return null;
  const match = ROLE_PATTERN.exec(name);
  if (!match) return null;
  const word = match[1].toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, word) ? word : null;
}

/** The role of the folder a path names, when that folder is top-level. */
function topLevelRole(path) {
  if (typeof path !== "string") return null;
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed.includes("/")) return null;
  return folderRole(trimmed);
}

/**
 * Is this path one of the five protected folders itself (not something in
 * it)? `1-projects` and `1-projects/` are; `1-projects/foo` is not.
 */
function isMainFolder(path) {
  const role = topLevelRole(path);
  return role !== null && MAIN_ROLES.includes(role);
}

function isExtraRole(role) {
  return EXTRA_ROLES.includes(role);
}

/** Where a top-level folder is drawn among its siblings. */
function folderRank(name) {
  const job = jobOfName(name);
  return job === null ? OWN_FOLDER_RANK : JOB_RANK[job];
}

/**
 * Sort comparator for top-level folder NAMES: role order, then name. Use it
 * only on the workspace root; below it, folders are plain names.
 */
function compareTopLevelFolders(a, b) {
  const rank = folderRank(a) - folderRank(b);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}

/**
 * The one order a folder listing is drawn in, for every surface that sorts
 * one (the server, the offline mirror, optimistic rows): folders before files,
 * by name, except at the workspace root (`parent === ""`), where folders take
 * their role order and Archive goes last. Two surfaces that disagreed would be
 * a row that jumps when the refresh arrives.
 */
function compareListingEntries(parent, a, b) {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  if (a.kind === "folder") {
    const rank = listingRank(parent, a) - listingRank(parent, b);
    if (rank !== 0 && !Number.isNaN(rank)) return rank;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Where a folder entry is drawn: its row's `order` when set, else its job's
 * rank (the row's `role`, or at the root its name's), else own folders at the
 * root after the extras and below it by name alone.
 */
function listingRank(parent, entry) {
  if (typeof entry.order === "number" && Number.isFinite(entry.order)) return entry.order;
  const job = isRowRole(entry.role) ? entry.role : parent === "" ? jobOfName(entry.name) : null;
  if (job !== null) return JOB_RANK[job] * 10;
  return parent === "" ? OWN_FOLDER_RANK * 10 : Number.MAX_SAFE_INTEGER;
}

/**
 * The first top-level folder of each role among `names`, or null. When two
 * folders claim one role (`4-archive` and `9-archive`), the one sorting first
 * by name wins, so the answer does not depend on listing order.
 */
function rolesIn(names) {
  const roles = {};
  for (const role of Object.keys(ROLE_RANK)) roles[role] = null;
  for (const name of [...names].sort()) {
    const role = folderRole(name);
    if (role !== null && roles[role] === null) roles[role] = name;
  }
  return roles;
}

/**
 * Is this path the protected folder for its role, given the workspace's
 * top-level folder names?
 *
 * One folder per main role is protected: the one `rolesIn` picks, which is
 * the one orient and `archive_note` file into. A second folder
 * claiming the same role (an agent's `projects` beside `Projects`, a
 * `9-archive` beside `4-archive`) is an ordinary folder, so it can be emptied
 * into the real one and removed (decided by the owner, 2026-10-14).
 *
 * `names` should be what the caller can see. A role-mate the caller cannot
 * see is left out, which only ever keeps a folder protected: the safe side.
 */
function isProtectedFolder(path, names) {
  if (!isMainFolder(path)) return false;
  const name = path.replace(/^\/+|\/+$/g, "");
  const role = topLevelRole(name);
  return rolesIn([...names, name])[role] === name;
}

/**
 * Characters that draw as nothing: zero-width spaces and joiners, the soft
 * hyphen, the byte-order mark, and the direction marks and isolates
 * (`displayText.cjs` adds isolates around names it draws).
 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Dashes that draw as a hyphen: the Unicode hyphens (an AI client writing
 * "kings‑1" with a non-breaking hyphen is the case that found this,
 * 2026-10-14), the figure, en and em dashes, the minus sign, and their
 * small and fullwidth forms.
 */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

/**
 * How sibling names are compared: as a person reads them. Case-blind, blind
 * to how an accent was typed, blind to compatibility forms (fullwidth
 * letters), to characters that draw as nothing, and to which dash was used.
 * Two names that fold alike look like one name in the tree, and the second is
 * refused (`siblingTwin`).
 */
function foldName(name) {
  return String(name).normalize("NFKC").replace(INVISIBLE, "").replace(DASHES, "-").toLowerCase();
}

/**
 * The existing sibling a new name would sit beside as a twin, or null.
 *
 * Two names in one folder that differ only by case read as one folder to a
 * person and are two to the bucket, so the second is refused (decided by the
 * owner, 2026-10-14). At the workspace root a new folder also may not claim a
 * built-in role another folder already plays: `1-projects` beside `Projects`
 * is the same twin by its other spelling. The name itself never twins itself.
 *
 * @param {string} name the new name (one segment)
 * @param {Iterable<string>} siblings names already in that folder
 * @param {{ topLevelFolder?: boolean }} [options] the new name is a folder at the root
 */
function siblingTwin(name, siblings, options = {}) {
  const folded = foldName(name);
  const role = options.topLevelFolder ? folderRole(name) : null;
  for (const sibling of siblings) {
    if (sibling === name) continue;
    if (foldName(sibling) === folded) return sibling;
    if (role !== null && folderRole(sibling) === role) return sibling;
  }
  return null;
}

/**
 * The refusal both engines give a twin, so an agent reads one rule whichever
 * door it used: what is already there, and the path to write instead.
 */
function twinMessage(name, twin, instead, topLevel) {
  const role = topLevel ? folderRole(twin) : null;
  if (role !== null && foldName(name) !== foldName(twin)) {
    return `${twin} is already this workspace's ${ROLE_LABEL[role]} folder, so use ${instead} instead of making ${name}.`;
  }
  return `${twin} is already here, and names in one folder can't differ only by case. Use ${instead} instead.`;
}

/**
 * Which folder does each job, from folder rows `{path, name, role?, top}`
 * (`top`: the row sits at the root): `{jobs, roots}`, where `jobs[job]` is
 * the path of the folder doing it, or null, and `roots` the root's folder
 * names. A row's own `role` wins wherever the folder now is; a job no row
 * claims falls to the root folder named for it (`rolesIn`, plus `website`).
 * Two rows claiming one job (never written by us) resolve to the first path.
 */
function folderJobs(rows) {
  const jobs = {};
  for (const job of ROW_ROLES) jobs[job] = null;
  const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const row of sorted) {
    if (isRowRole(row.role) && jobs[row.role] === null) jobs[row.role] = row.path;
  }
  const claimed = new Set(sorted.filter((row) => isRowRole(row.role)).map((row) => row.path));
  const unclaimedRoots = sorted.filter((row) => row.top && !claimed.has(row.path)).map((row) => row.name);
  const byName = rolesIn(unclaimedRoots);
  for (const role of Object.keys(byName)) {
    if (jobs[role] === null && byName[role] !== null) jobs[role] = byName[role];
  }
  if (jobs.website === null && unclaimedRoots.includes(WEBSITE_FOLDER)) jobs.website = WEBSITE_FOLDER;
  return { jobs, roots: sorted.filter((row) => row.top).map((row) => row.name) };
}

/** The job the folder at `path` does, given `folderJobs`'s answer, or null. */
function jobAt(folderJobsAnswer, path) {
  if (!folderJobsAnswer || typeof path !== "string") return null;
  const clean = path.replace(/^\/+|\/+$/g, "");
  for (const job of ROW_ROLES) if (folderJobsAnswer.jobs[job] === clean) return job;
  return null;
}

/**
 * A path written under a job's name, carried to the folder doing that job
 * now: `0-inbox/memories/a.md` is `Capture/memories/a.md` once the Inbox is
 * called Capture. Only the first segment is read, only when it names a job
 * (`jobOfName`), and never when a root folder really has that name, so a
 * folder somebody made wins over the rule. Everything else is returned as
 * given. This is what keeps every writer that names a built-in folder by its
 * default name (email, meetings, memories, sessions) and every AI client that
 * guesses `0-inbox/` landing in the real folder after a rename.
 */
function jobPath(folderJobsAnswer, path) {
  if (!folderJobsAnswer || typeof path !== "string" || path === "") return path;
  const slash = path.indexOf("/");
  const first = slash < 0 ? path : path.slice(0, slash);
  const job = jobOfName(first);
  if (job === null) return path;
  if (folderJobsAnswer.roots.includes(first)) return path;
  const home = folderJobsAnswer.jobs[job];
  if (typeof home !== "string" || home === "" || home === first) return path;
  return slash < 0 ? home : `${home}${path.slice(slash)}`;
}

/** The main roles a workspace's top-level folders do not cover yet. */
function missingMainRoles(names) {
  const roles = rolesIn(names);
  return MAIN_ROLES.filter((role) => roles[role] === null);
}

/**
 * Which notes a search index fills first (decided by the owner, 2026-10-08;
 * the admin console names them T0, T1, T2):
 * everything else is 1, the Inbox 2 because it changes so much, the Archive 3,
 * "whenever we can get to it". Read from the note's TOP-LEVEL folder, so
 * `0-inbox/a.md` is 2 and `1-projects/inbox/a.md` is 1; a note at the root is 1.
 * It decides order and the per-priority counts the admin console shows, never
 * whether a note is indexed at all.
 */
const INDEXING_PRIORITIES = Object.freeze([1, 2, 3]);

function indexingPriority(path) {
  if (typeof path !== "string") return 1;
  const slash = path.indexOf("/");
  if (slash <= 0) return 1;
  const role = folderRole(path.slice(0, slash));
  if (role === "inbox") return 2;
  if (role === "archive") return 3;
  return 1;
}

/** Indexing order: priority, then path, so a walk resumes where it stopped. */
function compareIndexingOrder(a, b) {
  const rank = indexingPriority(a) - indexingPriority(b);
  if (rank !== 0) return rank;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Notes counted per priority: `[{priority, indexed, pending}]`, one entry for
 * each priority in order. `isIndexed(path)` decides a census path's column;
 * `extraPending` (removals not yet applied, say) are counted by their own path.
 */
function countByIndexingPriority(paths, isIndexed, extraPending = []) {
  const counts = INDEXING_PRIORITIES.map((priority) => ({ priority, indexed: 0, pending: 0 }));
  for (const path of paths) {
    const entry = counts[indexingPriority(path) - 1];
    if (isIndexed(path)) entry.indexed += 1;
    else entry.pending += 1;
  }
  for (const path of extraPending) counts[indexingPriority(path) - 1].pending += 1;
  return counts;
}

module.exports = {
  ROW_ROLES,
  WEBSITE_FOLDER,
  JOB_LABEL,
  isRowRole,
  jobOfName,
  folderJobs,
  jobAt,
  jobPath,
  MAIN_ROLES,
  EXTRA_ROLES,
  DEFAULT_FOLDER,
  MAIN_FOLDERS,
  ROLE_LABEL,
  ROLE_DESCRIPTION,
  folderRole,
  topLevelRole,
  isMainFolder,
  isExtraRole,
  folderRank,
  compareTopLevelFolders,
  compareListingEntries,
  rolesIn,
  missingMainRoles,
  isProtectedFolder,
  foldName,
  siblingTwin,
  twinMessage,
  INDEXING_PRIORITIES,
  indexingPriority,
  compareIndexingOrder,
  countByIndexingPriority,
};
