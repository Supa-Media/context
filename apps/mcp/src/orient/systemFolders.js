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

import { MAIN_ROLES, ROLE_LABEL, compareTopLevelFolders, folderRole } from "../../../../packages/shared/src/folderRoles.cjs";

/** The order jobs are listed in: the main ones, the extras, the website and meetings, Archive last. */
const JOB_ORDER = Object.freeze([
  "inbox",
  "projects",
  "areas",
  "resources",
  "clients",
  "teams",
  "products",
  "website",
  "meetings",
  "archive",
]);

const LABEL = Object.freeze({ ...ROLE_LABEL, website: "Website", meetings: "Meetings" });

/** One line per job: what lands there and what Context does with it. */
const JOB_LINE = Object.freeze({
  inbox: "unfiled captures; email, texts, meetings and saved AI sessions land here until someone files them.",
  projects: "active work with a finish line, one folder per project; task statuses and boards live here, and a finished project moves to Archive.",
  areas: "ongoing responsibilities with no finish line, such as health, money or a team someone runs.",
  resources: "reference material worth finding again: how things work, decisions and why, notes on things read.",
  clients: "one folder per client: who they are, what they need, what was promised.",
  teams: "one folder per team or function: what it owns and how it runs.",
  products: "one folder per product: what it is, who it is for, where it is going.",
  website: "the workspace's website; its pages publish from here, so it keeps its name and place.",
  meetings: "where meeting notes and transcripts are saved.",
  archive: "finished, cancelled or superseded work; archive moves notes here, and nothing is deleted.",
});

/** Whether a workspace must have the folder: the five main ones can be renamed, moved and nested, never removed. */
const importance = (job) => (MAIN_ROLES.includes(job) ? "required" : "optional");

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
    lines.push(`- ${LABEL[job]} \`${paths[job]}/\` — ${importance(job)}: ${JOB_LINE[job]}`);
  }
  if (missing.length) {
    lines.push(
      `Required but not found by this connection: ${missing.join(", ")}. ` +
        '`manage` action `layout` with `folder` adds a missing one.'
    );
  }
  return lines.join("\n");
}
