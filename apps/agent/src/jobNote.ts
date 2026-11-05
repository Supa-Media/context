/**
 * A background job's note, and the two agents on its mail besides the job (decided by the owner, 2026-11-05: "Tex
 * creates a shared project note for each job first and connects the worker/minion, advisor and Tex itself"; "Tex is
 * ultimately the one who can contact the user"; docs/decisions/texting-assistant/job-notes.md).
 *
 * - `openJobNote`: before its first part the job's object asks the gateway for its note (`/agent/job/note`,
 *   `apps/mcp/src/agent/jobNote.js`): the project note Tex put it in, or one in Tex's own notes. The job joins its
 *   mail, Tex and the advisor join as `tex` and `advisor`, and the job is told who is there (`roster`).
 * - A line the job mails to `tex` reaches this object (`apps/mcp/src/mail/deliver.js`) and goes to the chat's own
 *   turn as the job's word on its way, the one turn that texts the person (`mailToTex`). Their answer comes back to
 *   the job as their later text does.
 * - A line it mails to `advisor` is answered by the advisor on the note (`/agent/job/advise`), at most
 *   `MAX_ADVISOR_ASKS` a job, a limit the job is never told (`mailToAdvisor`).
 */

import { post, type Fetch } from "./clients";
import { RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import type { InboxStorage } from "./inbox";
import type { MailDelivery } from "./jobMail";

/** Where the job's note is and who it is there. */
export type JobNote = { path: string; context?: string; name: string; mailbox: string; advisor?: string; roster: string };

/** Asks one job may put to its advisor by mail. */
export const MAX_ADVISOR_ASKS = 10;
const ASKS_KEY = "jobadvisorasks";
const MAILBOX = /^mb_[a-z0-9]{8,32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const CONTEXT = /^@[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ROSTER = 4_000;

type NoteDeps = { fetch: Fetch; gatewayOrigin: string };

/** The gateway's answer read strictly; null for anything else. */
export function readJobNote(value: unknown): JobNote | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ok, path, context, name, mailbox, advisor, roster } = value as Record<string, unknown>;
  if (ok !== true || typeof path !== "string" || path === "" || path.length > 1024 || /[\u0000-\u001f]/.test(path)) return null;
  if (typeof name !== "string" || !NAME.test(name) || typeof mailbox !== "string" || !MAILBOX.test(mailbox)) return null;
  if (typeof roster !== "string" || roster.trim() === "") return null;
  return {
    path,
    name,
    mailbox,
    roster: roster.slice(0, MAX_ROSTER),
    ...(typeof context === "string" && CONTEXT.test(context) ? { context } : {}),
    ...(typeof advisor === "string" && MAILBOX.test(advisor) ? { advisor } : {}),
  };
}

/** The job's note, made and joined by the gateway; null when it couldn't be, and the job runs as it did before. */
export async function openJobNote(deps: NoteDeps, token: string, run: JobRun): Promise<JobNote | null> {
  const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/job/note`, token, {
    jobId: run.id,
    title: run.title,
    brief: run.brief,
    ...(run.doneWhen ? { doneWhen: run.doneWhen } : {}),
    ...(run.mail ? { note: run.mail } : {}),
  }).catch(() => ({ status: 0, json: null }));
  return status === 200 ? readJobNote(json) : null;
}

/**
 * A line the job mailed to Tex: the chat's own turn is handed it as the job's word on its way, and texts it to them
 * (`apps/mcp/src/agent/jobReport.js`). Its own pass, named by the line, so it is one report however often it comes.
 */
export async function mailToTex(storage: InboxStorage, delivery: MailDelivery, report: (inbox: string, update: JobUpdate) => Promise<boolean>): Promise<boolean> {
  const run = await storage.get<JobRun>(RUN_KEY);
  if (run === undefined) return false;
  const asked = run.origin.kind === "phone" ? { from: run.origin.phone, text: run.origin.question } : { from: run.origin.message.from, text: run.origin.message.text };
  const text = delivery.mail.text;
  return await report(run.inbox, { id: run.id, pass: `mail-${Date.parse(delivery.mail.at)}`, first: 0, state: "running", status: text.slice(0, 280), texts: [text], asked }).catch(() => false);
}

/** A line the job mailed to its advisor: answered on the note, to the job, while asks last. */
export async function mailToAdvisor(storage: InboxStorage, delivery: MailDelivery, deps: NoteDeps, token: () => Promise<string | null>): Promise<boolean> {
  const run = await storage.get<JobRun & { note?: JobNote }>(RUN_KEY);
  if (run === undefined || run.note?.advisor === undefined || delivery.mail.from !== run.note.name) return false;
  const asks = (await storage.get<number>(ASKS_KEY)) ?? 0;
  const minted = await token();
  if (minted === null) return false;
  const over = asks >= MAX_ADVISOR_ASKS;
  if (!over) await storage.put(ASKS_KEY, asks + 1);
  const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/job/advise`, minted, {
    jobId: run.id,
    note: { path: run.note.path, ...(run.note.context ? { context: run.note.context } : {}) },
    advisor: run.note.advisor,
    from: run.note.name,
    title: run.title,
    brief: run.brief,
    ...(run.doneWhen ? { doneWhen: run.doneWhen } : {}),
    // Past the limit it answers without asking the model, and never says why.
    ...(over ? { say: "I can't look at this right now. Use your best judgement and carry on." } : { question: delivery.mail.text }),
  }).catch(() => ({ status: 0, json: null }));
  return status === 200 && (json as { ok?: unknown } | null)?.ok === true;
}

/** The advisor's verdict on a part, said on the note to the job, so everyone on it sees how the part was judged. */
export async function advisorVerdict(run: JobRun & { note?: JobNote }, deps: NoteDeps, token: string, words: string): Promise<void> {
  if (run.note?.advisor === undefined || words.trim() === "") return;
  await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/job/advise`, token, {
    jobId: run.id,
    note: { path: run.note.path, ...(run.note.context ? { context: run.note.context } : {}) },
    advisor: run.note.advisor,
    from: run.note.name,
    title: run.title,
    brief: run.brief,
    say: words.slice(0, 4_000),
  }).catch(() => null);
}
