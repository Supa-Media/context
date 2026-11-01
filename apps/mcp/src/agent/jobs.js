/**
 * TEX'S JOBS ARE TASK NOTES PEOPLE CAN SEE (owner, 2026-10-14).
 *
 * "Tex's state lives in Context, where people can see it, never in a
 * framework's hidden store": a job that takes several steps is a task note in
 * the projects folder of the workspace it belongs to, with a status, an owner
 * ("@maya's Tex") and a checklist, so it shows on that project's board, and
 * the next text picks it up from the first unticked step. Which jobs are open
 * is `tex/jobs.md` in the person's own workspace, one link per job, read into
 * every texted turn the way `tex/about-me.md` is (`aboutMe.js`).
 *
 * Read, never written, here: the notes change only through tool calls the
 * model makes, attributed and kept in history like any other write.
 */

import { readAboutMe, readTexNote } from "./aboutMe.js";
import { texterIdentity } from "./identity.js";

export const JOBS_PATH = "tex/jobs.md";

/** How much of the list a turn is shown. Open jobs are a handful; past this, it needs tidying. */
export const MAX_JOBS_LINES = 60;

/**
 * `{ aboutMe, jobs, identity }` for a texted turn, read side by side: the two
 * notes, and who they are by their account when `account` (`{ controlPlane,
 * session }`) is given (`identity.js`). Never throws (`readTexNote`).
 */
export async function readTexNotes(callTool, account = null, desk = {}, identityPart = (read) => read()) {
  // `desk`: the notes the person's object answered with the history (`texDesk.js`); one it didn't is read as a note.
  // `identityPart`: who they are by their account, from the warm copy when it has it (`warmCopy.js`), never About me.
  const [aboutMe, jobs, identity] = await Promise.all([
    typeof desk.about === "string" ? desk.about : readAboutMe(callTool),
    typeof desk.jobs === "string" ? desk.jobs : readTexNote(callTool, JOBS_PATH),
    account === null ? null : identityPart(() => texterIdentity(account.controlPlane, account.session)),
  ]);
  return { aboutMe, jobs, identity };
}

const HOW =
  "A job that takes more than a few steps, or that you can't finish in this text (a lookup and a write-up, " +
  "a site to work through, a plan with parts), is a task note, so they can watch it on their board. " +
  "Write it in the projects folder of the workspace it belongs to, beside that project's notes (make a project " +
  "folder if none fits), with status: in progress and owner: their handle's Tex (their personal workspace's name, " +
  "like @maya's Tex) between --- lines at the top, using the status words that folder's other tasks use, and a " +
  `checklist of the steps. Add a line for it to ${JOBS_PATH} in their own workspace: - [Title](@workspace/path.md). ` +
  "Tick each step in the note as you finish it. When the job is done, set its status to done and take its line out " +
  `of ${JOBS_PATH}. A question you answer straight away is never a job.`;

/** What the system prompt says about jobs, given the list's text and whether this turn may write. */
export function jobsPrompt(text, { edits }) {
  if (!edits) return "";
  const body = typeof text === "string" ? text.trim() : "";
  if (body.length === 0) return `\n\nJobs. ${HOW}`;
  const lines = body.split("\n");
  const shown =
    lines.length > MAX_JOBS_LINES
      ? `${lines.slice(0, MAX_JOBS_LINES).join("\n")}\n[cut: ${lines.length - MAX_JOBS_LINES} more lines; tidy the list]`
      : body;
  return [
    "",
    "",
    `Jobs. ${HOW}`,
    "",
    `Your open jobs, from ${JOBS_PATH}. When a text carries one on, read its task note first and pick up from the first unticked step:`,
    shown,
  ].join("\n");
}
