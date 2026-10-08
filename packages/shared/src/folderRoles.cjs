/**
 * Built-in folders: the five every workspace has, and the extras a workspace
 * can add. One module, read by the gateway, the control plane, the app and
 * the router, so "which folder is the archive" has one answer.
 *
 * ## A folder's role lives in its name
 *
 * `1-projects`, `projects` and `2-Projects` all play the projects role: the
 * word decides, the number in front only sorts. So nothing outside the bucket
 * records which folder is which, an older workspace whose archive is
 * `4-archive` is read correctly without renaming anything, and an AI client
 * that reads the bucket without reading our docs sees the same structure we
 * do. Only TOP-LEVEL folders have a role: `1-projects/clients` is a project
 * called clients.
 *
 * ## The five main folders are protected; extras are not
 *
 * Inbox, Projects, Areas, Resources and Archive are what every system prompt,
 * the organizer and `archive_note` rely on, so they cannot be renamed, moved
 * or deleted through the product (decided by the owner, 2026-10-08). What is
 * inside them is the person's to move. Extras (Clients, Teams, Products) are
 * offered, not required, and can be removed like any folder.
 *
 * ## Order
 *
 * Inbox, Projects, Areas, Resources, then extras, then the person's own
 * folders by name, and Archive last, whatever its number says. New workspaces
 * get names whose numbers already sort that way in any other app (`9-archive`,
 * extras at fixed numbers 4–6), so the app's order and Obsidian's agree there;
 * an older `4-archive` is still drawn last here.
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
  const role = folderRole(name);
  return role === null ? OWN_FOLDER_RANK : ROLE_RANK[role];
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
  if (parent === "" && a.kind === "folder") return compareTopLevelFolders(a.name, b.name);
  return a.name.localeCompare(b.name);
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

/** The main roles a workspace's top-level folders do not cover yet. */
function missingMainRoles(names) {
  const roles = rolesIn(names);
  return MAIN_ROLES.filter((role) => roles[role] === null);
}

module.exports = {
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
};
