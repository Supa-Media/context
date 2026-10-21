/**
 * The "System folders" lines of a workspace's block in `orient`: each folder
 * Context treats specially, what it is for, whether the workspace must have
 * it, and where it is now. A folder's job lives on its tree row, so the path
 * here is wherever the person renamed, moved or nested it (`survey.jobs`, the
 * tree's `ask: "jobs"` answer); an agent files by this path and never by a
 * folder's default name ([folder-jobs](../../../../docs/decisions/app-and-console/folder-jobs.md)).
 *
 * Only folders this connection can see are named: the tree answers a hidden
 * folder's job as null, so a job not found is said as not found by this
 * connection, never as absent.
 */

import { JOB_LABEL, MAIN_ROLES, compareTopLevelFolders, folderRole } from "../../../../packages/shared/src/folderRoles.cjs";
import { GROUP_LABEL, INBOX_PARTS, INBOX_PART_LABEL, JOB_GROUP } from "../../../../packages/shared/src/folderJobInfo.cjs";

/** The order jobs are listed in: the main ones, the extras, the website and meetings, Archive last. */
const JOB_ORDER = Object.freeze([
  "inbox",
  "projects",
  "areas",
  "resources",
  "clients",
  "teams",
  "products",
  "tex",
  "website",
  "meetings",
  "archive",
]);

const LABEL = JOB_LABEL;

/** One line per job: what lands there and what Context does with it. */
const JOB_LINE = Object.freeze({
  inbox: "unfiled captures; email, texts, meetings and saved AI sessions land here until someone files them.",
  projects: "active work with a finish line, one folder per project; task statuses and boards live here, and a finished project moves to Archive.",
  areas: "ongoing responsibilities with no finish line, such as health, money or a team someone runs.",
  resources: "reference material worth finding again: how things work, decisions and why, notes on things read.",
  clients: "one folder per client: who they are, what they need, what was promised.",
  teams: "one folder per team or function: what it owns and how it runs.",
  products: "one folder per product: what it is, who it is for, where it is going.",
  tex: "Tex's own folder: what it knows about the person (about-me.md), its routines (routines/) and its daily notes. A path written as tex/... lands here.",
  website: "the workspace's website; its pages publish from here, wherever it is nested, and a path written as website/... lands here.",
  meetings: "where meeting notes and transcripts are saved.",
  archive: "finished, cancelled or superseded work; archive moves notes here, and nothing is deleted.",
});

/**
 * Needed (the five main ones: renamed, moved and nested, never removed), made
 * when used (Tex, Website, Meetings), or optional (owner, 2026-10-18).
 */
const importance = (job) => GROUP_LABEL[JOB_GROUP[job]].toLowerCase();

/** The Inbox's own folders, said once on its line rather than a line each (owner, 2026-10-18). */
const INBOX_OWN =
  ` Its own folders ${INBOX_PARTS.map((part) => INBOX_PART_LABEL[part]).join(", ")} stay where they are (never rename or move them);` +
  " add notes and folders beside them.";

const folderName = (folder) => folder.prefix.replace(/\/+$/, "");

/** Which folder does each job, from the tree when it answered, else from the top-level folders' names. */
function jobPaths(survey) {
  if (survey.jobs) return survey.jobs;
  const paths = {};
  for (const folder of [...survey.folders].sort((a, b) => compareTopLevelFolders(folderName(a), folderName(b)))) {
    const role = folderRole(folderName(folder));
    if (role !== null && paths[role] === undefined) paths[role] = folderName(folder);
  }
  return paths;
}

/**
 * The section's lines, or "" when this connection sees no system folder and
 * none is missing to say.
 *
 * @param {{jobs?: Record<string, string|null>, folders: {prefix: string}[]}} survey
 */
export function systemFoldersSection(survey) {
  const paths = jobPaths(survey);
  const found = JOB_ORDER.filter((job) => typeof paths[job] === "string" && paths[job] !== "");
  const missing = MAIN_ROLES.filter((job) => !found.includes(job)).map((job) => LABEL[job]);
  if (!found.length && !missing.length) return "";
  const lines = ["System folders (find each by the path here, wherever it is nested, never by its usual name):"];
  for (const job of found) {
    // Meetings in the Inbox's own `meetings` folder are said on the Inbox's line.
    if (job === "meetings" && typeof paths.inbox === "string" && paths.meetings === `${paths.inbox}/meetings`) continue;
    const own = job === "inbox" ? INBOX_OWN : "";
    lines.push(`- ${LABEL[job]} \`${paths[job]}/\` — ${importance(job)}: ${JOB_LINE[job]}${own}`);
  }
  if (missing.length) {
    lines.push(
      `Needed but not found by this connection: ${missing.join(", ")}. ` +
        "`manage` action `folder_job` with `job` and `path` names the folder that does it (an import's own Inbox, say), " +
        "or `job` alone makes one."
    );
  }
  return lines.join("\n");
}
