/**
 * What each built-in folder's job is for, in the words people and AI clients
 * read, which jobs a person may hand to another folder or take away, and the
 * guesses offered when a workspace's folders do not say their jobs (decided by
 * the owner, 2026-10-18, picking every board of `folder-jobs-marking`;
 * `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * One module, read by the control plane (Settings › Built-in folders, the
 * import picker, `folder_job`), the gateway (orient) and the app, so the line
 * a person reads in Settings is the line an agent reads in orient.
 *
 * ## Three groups
 *
 *  - **needed**: Inbox, Projects, Areas, Resources, Archive. Every workspace
 *    has one of each. Each can be given to another folder, never taken away.
 *  - **made**: Tex and Website, made by Context the first time the feature is
 *    used. Both can be renamed and nested anywhere (Website since 2026-10-21);
 *    Website's job stays with its own folder, which its site is published from.
 *  - **optional**: Clients, Teams, Products, added when useful and removable.
 *
 * Meetings is a job on rows (its folder follows the meetings setting) but is
 * shown as one of the Inbox's own folders, not a line of its own: the owner,
 * 2026-10-18, "fold under inbox". Routines live in Tex's folder
 * (`tex/routines/`), so they are part of Tex's line.
 */

const { DEFAULT_FOLDER, JOB_LABEL, MAIN_ROLES, EXTRA_ROLES, NO_JOB, ROW_ROLES, TEX_FOLDER, WEBSITE_FOLDER } = require("./folderRoles.cjs");

/** The jobs shown as lines, in the order they are drawn. */
const SHOWN_JOBS = Object.freeze([...MAIN_ROLES, "tex", "website", ...EXTRA_ROLES]);

const JOB_GROUP = Object.freeze({
  inbox: "needed",
  projects: "needed",
  areas: "needed",
  resources: "needed",
  archive: "needed",
  tex: "made",
  website: "made",
  meetings: "made",
  clients: "optional",
  teams: "optional",
  products: "optional",
});

const GROUP_LABEL = Object.freeze({ needed: "Needed", made: "Made when used", optional: "Optional" });

/** One line per job: what Context does with that folder. */
const JOB_LINE = Object.freeze({
  inbox: "Email, meetings and quick captures land here until they're filed.",
  projects: "Work with a finish line, one folder each. Status, owner and due date show here.",
  areas: "Ongoing responsibilities with no finish line.",
  resources: "Reference worth finding again.",
  archive: "Finished things. The Archive button files here.",
  tex: "What Tex remembers about you, its routines and its daily notes.",
  website: "Pages here are published to your site.",
  meetings: "Recordings and transcripts are saved here.",
  clients: "One folder per client: who they are and what was promised.",
  teams: "One folder per team: what it owns and how it runs.",
  products: "One folder per product: what it is and who it's for.",
});

/**
 * The folders Context itself files into inside the Inbox, by their exact
 * names one level down (the same list `folderIcons.cjs` draws defaults for).
 * They stay where they are: a person can add notes and folders of their own
 * beside them, but not rename or move these (owner, 2026-10-18).
 */
const INBOX_PARTS = Object.freeze([
  "calendar",
  "contacts",
  "email",
  "forms",
  "google-chat",
  "imessage",
  "meetings",
  "memories",
  "sessions",
]);

const INBOX_PART_LABEL = Object.freeze({
  calendar: "Calendar",
  contacts: "Contacts",
  email: "Email",
  forms: "Forms",
  "google-chat": "Google Chat",
  imessage: "iMessage",
  meetings: "Meetings",
  memories: "Memories",
  sessions: "Sessions",
});

/** A job a person or an agent may give to a folder they name. Website's stays with the folder its site is published from. */
function canGiveJob(job) {
  return SHOWN_JOBS.includes(job) && job !== "website";
}

/** A job that may be taken away, leaving no folder doing it. */
function canRemoveJob(job) {
  return EXTRA_ROLES.includes(job);
}

/** Jobs whose folder must sit at the top of the workspace. */
function topOnly(job) {
  return job === "archive";
}

/**
 * Whether `path` is one of the Inbox's own folders, given the path of the
 * folder doing the Inbox's job now (null: no Inbox, nothing is).
 */
function isInboxPart(path, inboxPath) {
  if (typeof path !== "string" || typeof inboxPath !== "string" || inboxPath === "") return false;
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (!clean.startsWith(`${inboxPath}/`)) return false;
  const rest = clean.slice(inboxPath.length + 1);
  return !rest.includes("/") && INBOX_PARTS.includes(rest);
}

/**
 * Tex's own folders, by their exact names one level inside Tex's folder
 * (owner, 2026-10-21, "Context icon set" board 4): Tex files into each by
 * name, so like the Inbox's own they stay where they are, are drawn with
 * Context's icons (`folderIcons.cjs`), and a person adds notes and folders of
 * their own beside them.
 */
const TEX_PARTS = Object.freeze(["attention", "dreams", "heartbeat", "housekeeping", "routines", "skills", "transcripts"]);

/**
 * Whether `path` is one of Tex's own folders, given the path of the folder
 * doing Tex's job now (null: no Tex folder, nothing is).
 */
function isTexPart(path, texPath) {
  if (typeof path !== "string" || typeof texPath !== "string" || texPath === "") return false;
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (!clean.startsWith(`${texPath}/`)) return false;
  const rest = clean.slice(texPath.length + 1);
  return !rest.includes("/") && TEX_PARTS.includes(rest);
}

/**
 * Words a folder's name may use for a job, besides the job's own name. Kept
 * short on purpose: a guess the person has to untick costs more than one
 * they have to pick.
 */
const SYNONYMS = Object.freeze({
  inbox: ["inbox", "capture", "captures", "intake", "unsorted", "unfiled"],
  projects: ["projects", "project", "active projects"],
  areas: ["areas", "area", "areas of responsibility", "responsibilities"],
  resources: ["resources", "resource", "reference", "references", "library"],
  archive: ["archive", "archives", "archived"],
  clients: ["clients", "client", "customers"],
  teams: ["teams", "team"],
  products: ["products", "product"],
  tex: ["tex"],
});

/** A folder name as words: no leading number, emoji or punctuation, lower case. */
function nameWords(name) {
  return String(name)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^\d+\s*/, "")
    .replace(/\s+/g, " ");
}

/** What a name says it is, and how plainly: `own` (its job's name), `synonym`, or null. */
function nameSays(name) {
  const words = nameWords(name);
  if (words === "") return null;
  for (const job of Object.keys(SYNONYMS)) {
    const index = SYNONYMS[job].indexOf(words);
    if (index < 0) continue;
    return { job, own: index === 0 || words === JOB_LABEL[job].toLowerCase() };
  }
  return null;
}

/** Folders deeper than this are never guessed: past it, a name is somebody's own sub-topic. */
const GUESS_DEPTH = 3;

/**
 * For each shown job no folder does yet (`jobs.jobs[job] === null`), the
 * folder whose name most plainly says it, with why: `{job, path, why}`.
 * `folders` are the folders the caller can see, `{path}`; a folder already
 * doing a job, or one a person said does none (`role: "none"`), is never
 * guessed. Shallower beats deeper, the job's own word beats another word,
 * then the path that sorts first, so the answer does not depend on listing
 * order. Archive is guessed only at the top.
 */
function guessFolderJobs(folders, jobs) {
  const taken = new Set(Object.values(jobs?.jobs ?? {}).filter((path) => typeof path === "string"));
  const best = {};
  for (const folder of folders) {
    const path = typeof folder?.path === "string" ? folder.path.replace(/^\/+|\/+$/g, "") : "";
    if (path === "" || taken.has(path) || folder.role === NO_JOB || ROW_ROLES.includes(folder.role)) continue;
    const segments = path.split("/");
    if (segments.length > GUESS_DEPTH) continue;
    const said = nameSays(segments[segments.length - 1]);
    if (said === null || !SHOWN_JOBS.includes(said.job) || jobs?.jobs?.[said.job] !== null) continue;
    if (topOnly(said.job) && segments.length > 1) continue;
    const rank = [segments.length, said.own ? 0 : 1, path];
    const held = best[said.job];
    if (held === undefined || compareRank(rank, held.rank) < 0) best[said.job] = { rank, said, path, depth: segments.length };
  }
  const guesses = [];
  for (const job of SHOWN_JOBS) {
    const held = best[job];
    if (held === undefined) continue;
    const label = JOB_LABEL[job];
    const why = held.said.own ? (held.depth > 1 ? `nested, name says ${label}` : `name says ${label}`) : `another word for ${label}`;
    guesses.push({ job, path: held.path, why });
  }
  return guesses;
}

function compareRank(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/** The name a job's folder gets when Context makes it at the top. */
function defaultFolderName(job) {
  if (job === "website") return WEBSITE_FOLDER;
  if (job === "tex") return TEX_FOLDER;
  return DEFAULT_FOLDER[job] ?? null;
}

/** The jobs Context offers by name, for an answer to somebody asking for one it does not have. */
function jobNames() {
  return SHOWN_JOBS.join(", ");
}

module.exports = {
  SHOWN_JOBS,
  JOB_GROUP,
  GROUP_LABEL,
  JOB_LINE,
  INBOX_PARTS,
  INBOX_PART_LABEL,
  canGiveJob,
  canRemoveJob,
  topOnly,
  isInboxPart,
  TEX_PARTS,
  isTexPart,
  nameWords,
  nameSays,
  guessFolderJobs,
  defaultFolderName,
  jobNames,
};
