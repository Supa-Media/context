/**
 * A background job's note, and the mail on it that connects the job, Tex and the advisor (decided by the owner,
 * 2026-11-05: "Tex creates a shared project note for each job first and connects the worker/minion, advisor and Tex
 * itself"; "every agent or worker [should] know what other agents it has access to"; the job note "should live in the
 * project or file that makes the most sense ... in the last case scenario, it can just keep it in its own text notes";
 * docs/decisions/texting-assistant/job-notes.md).
 *
 * Both routes are asked by the job's own object in the texting Worker (`apps/agent/src/jobNote.ts`), with the job's
 * own texting grant, as `/agent` is.
 *
 * - `POST /agent/job/note` `{ jobId, title, brief, doneWhen?, note? }` → `{ ok, path, context?, name, mailbox,
 *   advisor, roster }`. `note` is where Tex put the job (`{ path, context?, name }`, the project note it belongs to);
 *   with none, Tex's own notes in the person's workspace (`tex/jobs/`). A note that isn't there yet is written, its
 *   brief and finish line on top. Then the job joins its mail under its name, bound to the job so mail reaches it at
 *   once (`mail/deliver.js`), and Tex and the advisor join as `tex` and `advisor`. Mail a job sends to either is handed
 *   to that job's own object (`deliver.js` `toRosterAgent`), which tells the chat or asks the advisor. `roster` is what
 *   the job is told at its start: who is on the note and what each is for.
 * - `POST /agent/job/advise` `{ jobId, note: { path, context? }, advisor, from, question, title, brief, doneWhen? }` →
 *   `{ ok }`: the advisor reads the job's brief, finish line and note, answers the question, and its answer is sent
 *   on the note's mail to the job that asked. `say` in place of `question` sends that line as the advisor's (its
 *   verdict at the end of a part) without asking the model.
 *
 * Nothing here sends anything outside Context: a line on the note is a write to the note, and only Tex's own turn
 * ever texts the person.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { callToolForSession } from "../tools/session.js";
import { jobMailOf } from "./background.js";
import { jobTagged, storeLedger } from "./ledger.js";
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { readProductionSetup } from "./production.js";
import { adviseOnce, advisorRequest } from "./advisorRoles/core.js";
import { ADVISOR_MAIL_PROMPT } from "./advisorRoles/jobMail.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { builtinModel, canRunBuiltin } from "./builtin.js";

const TEXTS_CLIENT_ID = "context_texts";
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAILBOX = /^mb_[a-z0-9]{8,32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TEXT = 4_000;
const MAX_NOTE_SHOWN = 30_000;
/** The two agents every job note has besides its jobs. Their names are what a job mails them by. */
export const TEX_NAME = "tex";
export const ADVISOR_NAME = "advisor";

const forbidden = () => json({ error: "forbidden" }, 403);
const invalid = (detail) => json({ error: "invalid_request", error_description: detail }, 400);
const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

async function bodyOf(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** A job's name on the mail, from its title: what the person would call it, short. */
export function jobName(title) {
  const words = clip(title, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return NAME.test(words) && words !== TEX_NAME && words !== ADVISOR_NAME && words !== "everyone" ? words : "job";
}

/**
 * Where a job with no project goes, one note a job: a person's in Tex's own notes in their workspace; a group chat's in
 * `projects/tex-jobs/` of the workspace its grant writes to, where everyone in the chat can follow it. A group's job
 * had no note at all before 2026-11-06, so no mail, no advisor and no way to Tex: job 350eddce answered in one part
 * and spent two more looking for a page that was never made.
 */
export function fallbackPath(title, jobId, { group = false } = {}) {
  const slug = clip(title, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "job";
  return `${group ? "projects/tex-jobs" : "tex/jobs"}/${slug}-${jobId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase()}.md`;
}

/** What every job is told at its start: who is on its note's mail and what each is for (the owner, 2026-11-05). */
export function rosterText({ path, context, name, mailbox, others = [] }) {
  const where = `${path}${context ? ` in ${context}` : ""}`;
  const send = `write action mail on ${path}${context ? ` (context ${context})` : ""}, args { text, to }, with mailbox "${mailbox}"`;
  return (
    `Your job note is ${where}. You are "${name}" on its mail, already joined: mail sent to you there reaches you at once, ` +
    `marked as mail. Send with ${send}. Who you can reach there, and what each is for:\n` +
    `- "${TEX_NAME}": Tex, the only one who can reach the person. Nobody else contacts them. Mail Tex anything they must see or ` +
    "do now (a sign-in link and its one-time code, a question only they can answer, news that can't wait), then keep working: " +
    "their answer comes back to you.\n" +
    `- "${ADVISOR_NAME}": your advisor, a much stronger model that is always listening. It reads this note and your brief. Mail it ` +
    "(kind \"ask\", with wait: 120) when you are stuck, unsure what to do next, or before you call the job finished. It also " +
    "judges whether you finished.\n" +
    (others.length > 0 ? `- ${others.map((other) => `"${other}"`).join(", ")}: other jobs on parts of the same ask. Tell them what changes their part; ask them rather than guess.\n` : "") +
    `To work with agents on another note's mail, join it with write action mail on that note, args { join: "${name}" }: you always join as "${name}". ` +
    "Never look for a saved login or password: a sign-in runs as a one-time link and code you hand to Tex while you wait."
  );
}

/** One tool call under the job's grant, as the job's turn would make it. */
const callAs = (store, session) => (name, args) => callToolForSession({ name, arguments: args }, store, session, { legacy: true });

const textOf = (result) => (Array.isArray(result?.content) ? result.content.map((part) => part?.text ?? "").join("\n") : "");

async function join(call, store, note, name, job) {
  const before = store.mailTurn;
  // Bound to the job only for its own name: mail to "tex" and "advisor" goes to the sender's job (`deliver.js`).
  store.mailTurn = job ? { role: "job", job } : null;
  try {
    const result = await call("write_note", { path: note.path, ...(note.context ? { context: note.context } : {}), mail: { join: name } });
    return result?.isError ? null : (textOf(result).match(/mb_[a-z0-9]{8,32}/)?.[0] ?? null);
  } finally {
    store.mailTurn = before;
  }
}

/** Every name that joined the note's mail, from the note itself. */
function joinedNames(noteText) {
  const names = new Set();
  for (const match of String(noteText).matchAll(/^- \S+ ([a-z0-9][a-z0-9-]{0,23}) \([^)]*\) joined$/gm)) names.add(match[1]);
  return [...names];
}

async function readNote(call, note) {
  const read = await call("read_note", { path: note.path, ...(note.context ? { context: note.context } : {}) });
  return read?.isError ? null : textOf(read);
}

async function noteRoute(request, store, session, call) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  if (typeof body.jobId !== "string" || !JOB_ID.test(body.jobId)) return invalid("jobId");
  const title = clip(body.title, 200);
  const brief = clip(body.brief, MAX_TEXT);
  if (title === "" || brief === "") return invalid("title and brief");
  const given = jobMailOf(body.note);
  // With no project of its own, a person's job keeps its note in Tex's own notes, a group's in its workspace's projects.
  if (given === null && session.actorClientId !== TEXTS_CLIENT_ID && session.actorClientId !== TEXTS_GROUP_CLIENT_ID) return json({ ok: false, code: "no_note" });
  // A job never takes the name of an agent on the roster, so no line it gets can pass for Tex's or the advisor's.
  const named = given && (given.name === TEX_NAME || given.name === ADVISOR_NAME) ? { ...given, name: jobName(title) } : given;
  const note = named ?? { path: fallbackPath(title, body.jobId, { group: session.actorClientId === TEXTS_GROUP_CLIENT_ID }), name: jobName(title) };
  let existing = await readNote(call, note);
  if (existing === null) {
    const doneWhen = clip(body.doneWhen, 600);
    const written = await call("write_note", {
      path: note.path,
      ...(note.context ? { context: note.context } : {}),
      content: `# ${title}\n\n${brief}\n${doneWhen ? `\nDone when: ${doneWhen}\n` : ""}`,
      summary: "the job's note, made when Tex started it",
    });
    if (written?.isError) return json({ ok: false, code: "unwritable" });
    existing = "";
  }
  const mailbox = await join(call, store, note, note.name, body.jobId);
  if (mailbox === null) return json({ ok: false, code: "mail" });
  await join(call, store, note, TEX_NAME, null);
  const advisor = await join(call, store, note, ADVISOR_NAME, null);
  const others = joinedNames((await readNote(call, note)) ?? existing).filter((name) => ![note.name, TEX_NAME, ADVISOR_NAME].includes(name));
  return json({
    ok: true,
    path: note.path,
    ...(note.context ? { context: note.context } : {}),
    name: note.name,
    mailbox,
    ...(advisor ? { advisor } : {}),
    roster: rosterText({ ...note, mailbox, others }),
  });
}


// Its instructions live in `advisorRoles/jobMail.js`, beside the other roles' (`advisorRoles/core.js`).
export { ADVISOR_MAIL_PROMPT };

/**
 * What the advisor on the mail reads: the job, who is on its mail, its note and the question. The role's replay cases
 * (`bench/advisor/job-mail.json`) read the same.
 */
export function jobMailBrief({ title, brief, doneWhen, from, noteText, question }) {
  return (
    `Job: ${clip(title, 200)}\nBrief: ${clip(brief, MAX_TEXT)}\n` +
    (clip(doneWhen, 600) ? `Done when: ${clip(doneWhen, 600)}\n` : "") +
    `On its mail: ${[from, TEX_NAME, ADVISOR_NAME, ...joinedNames(noteText).filter((name) => ![from, TEX_NAME, ADVISOR_NAME].includes(name))].map((name) => `"${name}"`).join(", ")}\n` +
    `\n<job_note>\n${noteText.replaceAll("</job_note>", "")}\n</job_note>\n\n${from} asks: ${question}`
  );
}

async function adviseRoute(request, env, store, session, controlPlane, advise, call) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  if (typeof body.jobId !== "string" || !JOB_ID.test(body.jobId)) return invalid("jobId");
  // The note read as a job's mail note is (`background.js` `jobMailOf`), its name the advisor's own.
  const note = jobMailOf({ ...(body.note && typeof body.note === "object" ? body.note : {}), name: ADVISOR_NAME });
  if (note === null) return invalid("note");
  if (typeof body.advisor !== "string" || !MAILBOX.test(body.advisor)) return invalid("advisor");
  const from = typeof body.from === "string" && NAME.test(body.from) ? body.from : null;
  if (from === null) return invalid("from");
  const send = async (text) => {
    store.mailTurn = null;
    const sent = await call("write_note", { path: note.path, ...(note.context ? { context: note.context } : {}), mailbox: body.advisor, mail: { text: text.slice(0, MAX_TEXT), to: from } });
    return sent?.isError !== true;
  };
  const say = clip(body.say, MAX_TEXT);
  if (say !== "") return json({ ok: await send(say) });
  const question = clip(body.question, MAX_TEXT);
  if (question === "") return invalid("question");
  const noteText = ((await readNote(call, note)) ?? "").slice(-MAX_NOTE_SHOWN);
  const production = await readProductionSetup(store, session, { texting: true });
  // The Advisor on job mail is a node on the graph, run over the job -> mailadv wire and logged by the runner to the job's
  // chat under the job (`graph/nodes/mailadv.js`): what the job asked, what it was told.
  const record = jobTagged(storeLedger(store, session), { id: body.jobId, title: typeof body.title === "string" ? body.title : undefined });
  const advised = await gatewayGraph({ writer: record }).fire(
    "job",
    "mailadv",
    { jobId: body.jobId, title: clip(body.title, MAX_TEXT), brief: clip(body.brief, MAX_TEXT), doneWhen: clip(body.doneWhen, MAX_TEXT), from, question, noteText },
    { mailadv: { production, env, controlPlane, session, ...(advise ? { request: advise } : {}) } },
  );
  await record?.flush();
  if (advised.model === "") return json({ ok: await send("I can't look at this right now. Use your best judgement and carry on.") });
  const words = advised.words;
  const ok = await send(words || "I can't look at this right now. Use your best judgement and carry on.");
  return json({ ok });
}

export const JOB_NOTE_PATHS = new Set(["/agent/job/note", "/agent/job/advise"]);

/** One of `JOB_NOTE_PATHS`, for a session resolved from the job's texting token. */
export async function handleJobNote(request, env, session, { path, store, controlPlane, advise = null, call = null }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if ((session.actorClientId !== TEXTS_CLIENT_ID && session.actorClientId !== TEXTS_GROUP_CLIENT_ID) || !hasScope(session, SCOPE_WRITE)) return forbidden();
  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // Tests hand in the tool calls; a real request makes them under the job's own grant.
  const calls = call ?? callAs(store, session);
  if (path === "/agent/job/note") return await noteRoute(request, store, session, calls);
  if (path === "/agent/job/advise") return await adviseRoute(request, env, store, session, controlPlane, advise, calls);
  return new Response(null, { status: 404 });
}
