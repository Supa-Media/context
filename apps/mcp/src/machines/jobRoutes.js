/**
 * A background job's part on a person's own computer, asked for by the
 * texting Worker's job object (docs/decisions/texting-assistant/machines.md).
 * Each route is reached with the job's own texting token, resolved as `/agent`
 * resolves it, and answers a person's own texting client, or a group chat's,
 * with write scope (`reach.js`): a group reaches only the computers lent to
 * it, and who there may send work is the owner's rule in the workspace object.
 *
 * - `POST /agent/machine/assign` `{ workspaceId, machineId, jobId, part, tool,
 *   folder, permission, brief, ... }` → `{ ok, runId, deadline, powers }` or
 *   `{ ok: false, code }`. The gateway mints the run id and a run grant for
 *   it (the control plane's `texMachineRunGrants`: the job's own grant, under
 *   `context_tex_machine_run`, never sending anything), then the workspace
 *   object checks the machine's rules and sends the assignment. A refused
 *   assignment takes its run grant back at once.
 * - `POST /agent/machine/run` `{ workspaceId, runId, seen?, waitMs? }` → `{ ok, run, online, version }` (held until the run moves
 *   past `seen`, at most 50 seconds: `workspaceStore/runWait.js`):
 *   the run's state, steps and result, read from the object. An ended run's
 *   grant is taken back here too, in case the part ended before it expired.
 * - `POST /agent/machine/cancel` `{ workspaceId, runId, reason? }` → `{ ok }`.
 * - `POST /agent/machine/deliver` `{ workspaceId, runId, messageId, text,
 *   interrupt?, mail? }` → `{ ok }`: a later text of theirs, into the running
 *   session, as the next message or (`interrupt`) stopping the current step;
 *   with `mail` `{ from, kind?, path? }`, a note mail line from that agent.
 *
 * - `POST /agent/machine/check` `{ workspaceId, runId, job }` → `{ ok, verdict?,
 *   advice?, unfinished?, exhausted?, idle? }`: the advisor's check of an ended
 *   part against the job's finish line (`agent/jobCheck.js`), as a cloud
 *   part's answer carries it. The steps and last words are read from the run
 *   in the object, never taken from the body.
 *
 * A run is only ever read, steered or stopped by the person whose job it is
 * (`askerId`); any other run id answers `unknown_run`, as a run that does not
 * exist would.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { checkJob, jobFields } from "../agent/jobCheck.js";
import { readComputerJobSettings, readProductionSetup } from "../agent/production.js";
import { storeLedger } from "../agent/ledger.js";
import { advisorRequest } from "../agent/advisor.js";
import { aiGatewayConfig } from "../agent/aiGateway.js";
import { builtinModel, canRunBuiltin } from "../agent/builtin.js";
import { jobChatOf, reachedWorkspace, TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID } from "./reach.js";
import { machineAskLine, ownerHandleIn } from "./groupAsk.js";
import { personHubUrl } from "../agent/hubLinks.js";
import { backgroundedBrief } from "./jobBackground.js";
import { MAX_RUN_WAIT_MS } from "../workspaceStore/runWait.js";

export const MACHINE_RUN_CLIENT_ID = "context_tex_machine_run";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^run_[0-9a-f]{24}$/;
/** A part never asks for longer than this; the object clamps to the machine's own longest run as well. */
const MAX_PART_MS = 30 * 60 * 1000;
const CANCEL_REASONS = new Set(["stopped", "limit", "superseded"]);

const forbidden = () => json({ error: "forbidden" }, 403);
const invalid = (detail) => json({ error: "invalid_request", error_description: detail }, 400);
const refused = (code) => json({ ok: false, code });

export function mintRunId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `run_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function bodyOf(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function call(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
  return await response.json();
}

/** A run of this person's, or null: another person's run reads as no run. */
async function ownRun(env, session, workspaceId, runId, held = null) {
  // `held`: the reader's last version and how long it may wait for the next (`workspaceStore/runWait.js`); the
  // object checks whose run it is before it waits.
  const answer = await call(env, workspaceId, "ws.machine.run", { runId, ...(held === null ? {} : { seen: held.seen, waitMs: held.waitMs, askerId: session.actorUserId }) });
  if (answer?.ok !== true || answer.run?.askerId !== session.actorUserId) return null;
  return answer;
}

const shownRun = (run) => ({
  runId: run.runId,
  machineId: run.machineId,
  jobId: run.jobId,
  part: run.part,
  state: run.state,
  startedAt: run.startedAt,
  deadline: run.deadline,
  session: run.session ?? null,
  lastStep: run.lastStep ?? 0,
  steps: run.steps ?? [],
  result: run.result ?? null,
});

async function assign(request, env, session, controlPlane, origin, now, store) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  if (typeof body.machineId !== "string" || !ID.test(body.machineId)) return invalid("machineId");
  const covered = await reachedWorkspace(session, controlPlane, body.workspaceId, body.machineId);
  if (covered === null) return refused("unknown_machine");
  if (typeof body.jobId !== "string" || !ID.test(body.jobId)) return invalid("jobId");
  const machine = await call(env, covered.workspaceId, "ws.machine.get", { id: body.machineId });
  if (machine === null) return json({ error: "machines_unavailable" }, 501);
  if (machine.ok !== true) return refused("unknown_machine");
  const at = now();
  const deadline = Math.min(Number.isSafeInteger(body.deadline) ? body.deadline : at + MAX_PART_MS, at + MAX_PART_MS);
  const runId = mintRunId();
  const runGrant = await controlPlane.texMachineRunGrant({ parentToken: session.accessToken, machineId: body.machineId, runId, jobId: body.jobId, expiresAt: deadline });
  if (runGrant === null) return refused("grant");
  const fields = {
    runId,
    machineId: body.machineId,
    jobId: body.jobId,
    part: body.part,
    title: body.title,
    tool: body.tool,
    folder: body.folder,
    repo: body.repo,
    permission: body.permission,
    // Who the part works for and where it was started from, from this grant, ahead of the job's own words (`jobBackground.js`).
    brief: typeof body.brief === "string" && body.brief.trim() !== "" ? backgroundedBrief(session, body.brief, { machineName: machine.machine.name, fromOwner: machine.machine.ownerId === session.actorUserId }) : body.brief,
    doneWhen: body.doneWhen,
    advice: body.advice,
    resumeSession: body.resumeSession,
    deadline,
    // The model, the wait after an answer and the runner's prompt, from the production note, so they change without a
    // runner release (`production.js` `readComputerJobSettings`); sent only to a runner that takes them.
    settings: store ? await readComputerJobSettings(store, session) : {},
    chatName: body.chatName,
    computerUse: body.computerUse === true,
    // Who asked comes from the grant, never the body: in their own texts the person, in a group the one who tagged Tex.
    // One chat per person's own texts and one per group, so an owner's rule for one chat never covers another.
    chat: jobChatOf(session),
    // A group's full key, so the owner's ask card can name who asked among the chat's people (`appRoutes.js`).
    ...(typeof session.texChatId === "string" ? { chatKey: session.texChatId } : {}),
    askerId: session.actorUserId,
    fromOwner: machine.machine.ownerId === session.actorUserId,
    grant: { token: runGrant.accessToken, expiresAt: Math.min(runGrant.expiresAt, deadline), mcpUrl: `${origin.replace(/\/+$/, "")}/mcp` },
  };
  const answer = await call(env, covered.workspaceId, "ws.machine.assign", fields).catch(() => null);
  if (answer?.ok !== true) {
    await controlPlane.texMachineRunRevoke(runId).catch(() => null);
    // "Ask me first": the ask waiting for the owner's yes, so the job can say it is waiting and try again. Made just
    // now in a group chat, the job also gets the line the chat is asked in, the owner's 👍 there being the yes.
    const asking = answer?.code === "ask_first" && answer.fresh === true && session.actorClientId === TEXTS_GROUP_CLIENT_ID;
    const askLine = asking ? machineAskLine({ title: body.title, machineName: machine.machine.name, ownerHandle: await ownerHandleIn(controlPlane, session, machine.machine.ownerId) }) : null;
    const fixAt = fixLink(env, session, machine.machine, answer?.code);
    return json({ ok: false, code: answer?.code ?? "server_error", ...(typeof answer?.askId === "string" ? { askId: answer.askId } : {}), ...(askLine ? { askLine } : {}), ...fixAt });
  }
  return json({ ok: true, runId: answer.runId, deadline: answer.deadline, powers: answer.powers });
}

/**
 * A computer whose coding tool signed out, in its own owner's texts: why, and the computer's page on their hub, where
 * they sign it back in (the owner, 2026-11-05). Never in a group, where the hub is the group's and the computer isn't.
 */
function fixLink(env, session, machine, code) {
  if (code !== "not_ready" || session.actorClientId !== TEXTS_CLIENT_ID || machine.ownerId !== session.actorUserId) return {};
  const why = machine.status?.notReady === "signed_out" ? "signed_out" : null;
  const hub = personHubUrl(env, session);
  return { ...(why ? { why } : {}), ...(hub && typeof machine.id === "string" ? { fixAt: `${hub}/machine?machine=${encodeURIComponent(machine.id)}` } : {}) };
}

async function readRun(request, env, session, controlPlane, store) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = await reachedWorkspace(session, controlPlane, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  const held = typeof body.seen === "string" && body.seen.length <= 200 && Number.isFinite(body.waitMs) ? { seen: body.seen, waitMs: Math.min(MAX_RUN_WAIT_MS, Math.max(0, body.waitMs)) } : null;
  const answer = await ownRun(env, session, covered.workspaceId, body.runId, held);
  if (answer === null) return refused("unknown_run");
  // Ended before its grant ran out: the grant goes now, not at its expiry.
  if (answer.run.state === "ended") await controlPlane.texMachineRunRevoke(body.runId).catch(() => null);
  // Written only when the run moved: a held read that timed out on the same version has nothing new for the record.
  if (held === null || answer.version !== held.seen) await ledgerSteps(store, session, answer.run, typeof answer.machineName === "string" ? answer.machineName : null);
  return json({ ok: true, run: shownRun(answer.run), online: answer.online === true, ...(typeof answer.version === "string" ? { version: answer.version } : {}) });
}

/**
 * The part's work on the computer, in the chat's one record (Dev2, 2026-11-05: "we can't show any logs or history?",
 * and "we should be logging any claude code or codex turns, thoughts etc ... making sure we say what computer is
 * running it"): its steps as the job's tool calls, what the tool said and thought as `said` and `thinking`, and how
 * the part ended, each naming the computer. The job's object reads the run every few seconds; each entry is written
 * once, its id made from the run and its number, so a read again or a restarted pass adds nothing
 * (`texStore/ledger.js` keeps one copy of an id). A step is what the runner sends: the tool, an action, a target,
 * never a result, which stays on the computer, so a step's entry claims no outcome (`ok` left out). Never in the way
 * of the read: the writer never throws.
 */
async function ledgerSteps(store, session, run, machineName) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const said = Array.isArray(run.said) ? run.said : [];
  const ended = run.state === "ended" && run.result && typeof run.result === "object";
  const writer = (steps.length > 0 || said.length > 0 || ended) && typeof run.jobId === "string" ? storeLedger(store, session) : null;
  if (writer === null) return;
  const runKey = run.runId.replace(/[^A-Za-z0-9]/g, "").slice(-40);
  const where = { computer: run.machineId, ...(machineName ? { computerName: machineName.slice(0, 100) } : {}), jobId: run.jobId };
  const entries = steps
    .filter((step) => Number.isSafeInteger(step?.seq) && typeof step.tool === "string" && step.tool !== "")
    .map((step) => ({
      v: 1,
      id: `mr${runKey}s${step.seq}`,
      at: Number.isFinite(step.at) ? step.at : Date.now(),
      kind: "tool",
      name: step.tool.slice(0, 64),
      args: { ...(step.action ? { action: String(step.action).slice(0, 200) } : {}), ...(step.target ? { target: String(step.target).slice(0, 200) } : {}) },
      ms: 0,
      ...where,
    }));
  for (const line of said) {
    if (!Number.isSafeInteger(line?.seq) || typeof line.text !== "string" || line.text === "") continue;
    entries.push({ v: 1, id: `mr${runKey}s${line.seq}`, at: Number.isFinite(line.at) ? line.at : Date.now(), kind: line.kind === "thinking" ? "thinking" : "said", text: line.text.slice(0, 4000), ...where });
  }
  if (ended) {
    // How the part ended, with the computer's own reason when it gave one (a short code, never the tool's text).
    const { outcome, error } = run.result;
    entries.push({
      v: 1,
      id: `mr${runKey}end`,
      at: Number.isFinite(run.endedAt) ? run.endedAt : Date.now(),
      kind: "tool",
      name: "computer_part",
      args: { outcome: typeof outcome === "string" ? outcome.slice(0, 32) : "unknown", ...(typeof error === "string" && error !== "" ? { error: error.slice(0, 300) } : {}) },
      ok: outcome === "finished",
      ms: Number.isFinite(run.wallMs) ? run.wallMs : 0,
      ...where,
    });
  }
  writer.write(entries);
  await writer.flush();
}

async function cancel(request, env, session, controlPlane) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = await reachedWorkspace(session, controlPlane, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  if ((await ownRun(env, session, covered.workspaceId, body.runId)) === null) return refused("unknown_run");
  const reason = CANCEL_REASONS.has(body.reason) ? body.reason : "stopped";
  const answer = await call(env, covered.workspaceId, "ws.machine.cancel", { runId: body.runId, reason });
  await controlPlane.texMachineRunRevoke(body.runId).catch(() => null);
  return json({ ok: answer?.ok === true });
}

async function deliver(request, env, session, controlPlane) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = await reachedWorkspace(session, controlPlane, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  if (typeof body.messageId !== "string" || !ID.test(body.messageId)) return invalid("messageId");
  if (typeof body.text !== "string" || body.text.trim() === "") return invalid("text");
  if ((await ownRun(env, session, covered.workspaceId, body.runId)) === null) return refused("unknown_run");
  const text = body.text.trim().slice(0, 4000);
  // Note mail from another agent, handed on by the job: said as that agent's, never as the person's (2026-11-06: a
  // reviewer's mail reached a MacBook part as "Mail from the person"). A name can never read "the person".
  const mail = body.mail === undefined ? null : mailFrom(body.mail);
  if (body.mail !== undefined && (mail === null || body.interrupt === true)) return invalid("mail");
  // Their own words, from their own chat: the one sender who may interrupt (with Tex), checked by who holds this grant.
  const op = body.interrupt === true ? "ws.machine.interrupt" : "ws.machine.deliver";
  const answer = await call(env, covered.workspaceId, op, { runId: body.runId, messageId: body.messageId, kind: mail?.kind ?? "note", from: mail?.from ?? "the person", text, ...(mail?.path ? { path: mail.path } : {}) });
  return json({ ok: answer?.ok === true });
}

/** A mail line's sender as `/agent/machine/deliver` takes it: a joined name or an `@handle`, its kind, and its note. */
const MAIL_FROM = /^@?[a-z0-9][a-z0-9_.-]{0,39}$/i;
export function mailFrom(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.from !== "string" || !MAIL_FROM.test(value.from)) return null;
  const kind = value.kind === undefined || value.kind === "note" || value.kind === "interrupt" ? "note" : value.kind === "ask" ? "ask" : null;
  if (kind === null) return null;
  if (value.path !== undefined && (typeof value.path !== "string" || value.path === "" || value.path.length > 512 || /[\u0000-\u001f]/.test(value.path))) return null;
  return { from: value.from, kind, ...(value.path ? { path: value.path } : {}) };
}

const MAX_JOB_TEXT = 4_000;
const words = (value, max = MAX_JOB_TEXT) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The job as the advisor reads it, from the Worker's own record of it (sent with the job's own grant). */
function jobOfBody(job) {
  if (job === null || typeof job !== "object" || Array.isArray(job)) return null;
  const title = words(job.title, 200);
  const brief = words(job.brief);
  if (title === "" || brief === "") return null;
  const followUps = Array.isArray(job.followUps) ? job.followUps.map((text) => words(text, 1_000)).filter(Boolean).slice(-8) : [];
  const asked = Array.isArray(job.asked) ? job.asked.map((text) => words(text, 1_000)).filter(Boolean).slice(-8) : [];
  const attempt = Number.isSafeInteger(job.attempt) && job.attempt > 0 ? Math.min(job.attempt, 999) : 1;
  return { title, brief, doneWhen: words(job.doneWhen, 1_000), attempt, asked, followUps, advice: words(job.advice, 1_000), roster: words(job.roster, 4_000) };
}

/** What the part did, as the advisor's transcript: each step a tool call (the tool's results stay on the computer). */
function stepsAsTranscript(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => ({
    role: "assistant",
    text: "",
    toolCalls: [{ name: typeof step?.tool === "string" ? step.tool : "a tool", args: { ...(step?.action ? { action: step.action } : {}), ...(step?.target ? { target: step.target } : {}) } }],
  }));
}

const MACHINE_PART_NOTE =
  "This part ran in a coding tool (Claude Code or Codex) on the person's own computer, not in Tex. Only its tool calls are listed; " +
  "their results stayed on the computer, so judge the finish line by the steps it took and its last words.";

async function check(request, env, session, controlPlane, store, advise) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = await reachedWorkspace(session, controlPlane, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  const job = jobOfBody(body.job);
  if (job === null) return invalid("job");
  const answer = await ownRun(env, session, covered.workspaceId, body.runId);
  if (answer === null) return refused("unknown_run");
  const run = answer.run;
  if (run.state !== "ended" || (run.result?.outcome !== "finished" && run.result?.outcome !== "limit")) return refused("not_ended");
  const exhausted = run.result.outcome === "limit";
  const production = await readProductionSetup(store, session, { texting: true });
  const model = [production?.advisor, production?.model, builtinModel(env)].find((name) => typeof name === "string" && canRunBuiltin(name, env));
  const started = Date.now();
  const meter = async (usage, failed, used = model) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        model: typeof used === "string" ? used : model,
        decision: 0,
        failed,
        ms: Date.now() - started,
        background: true, // a job's check, like a job's turn, is never on the daily cap
      });
    } catch {
      // A meter that could not be reached costs us a report, not the job its check.
    }
  };
  const verdict = await checkJob({
    job,
    live: { system: MACHINE_PART_NOTE, messages: stepsAsTranscript(run.steps) },
    answer: words(run.result.answer, 20_000),
    exhausted,
    model,
    effort: production?.efforts?.[model],
    request: advise ?? advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "job-check" } }),
    meter,
  });
  // A part on a computer read whatever the coding tool read there: its words are never trusted as the person's.
  const fields = jobFields(verdict, { exhausted, unfinished: false, untrusted: true });
  const { thinking: _thinking, ...shown } = fields;
  return json({ ok: true, ...shown, ...((run.steps ?? []).length === 0 ? { idle: true } : {}) });
}

export const MACHINE_JOB_PATHS = new Set(["/agent/machine/assign", "/agent/machine/run", "/agent/machine/cancel", "/agent/machine/deliver", "/agent/machine/check"]);

/** One of `MACHINE_JOB_PATHS`, for a session already resolved from the job's texting token. */
export async function handleMachineJob(request, env, session, { path, controlPlane, origin, store = null, now = Date.now, advise = null }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // A person's own texts, or a group chat's turn on the computers lent to it (`reach.js`).
  if ((session.actorClientId !== TEXTS_CLIENT_ID && session.actorClientId !== TEXTS_GROUP_CLIENT_ID) || !hasScope(session, SCOPE_WRITE) || jobChatOf(session) === null) return forbidden();
  if (!env.WORKSPACE_STORE) return json({ error: "machines_unavailable" }, 501);
  if (path === "/agent/machine/assign") return await assign(request, env, session, controlPlane, origin, now, store);
  if (path === "/agent/machine/run") return await readRun(request, env, session, controlPlane, store);
  if (path === "/agent/machine/cancel") return await cancel(request, env, session, controlPlane);
  if (path === "/agent/machine/deliver") return await deliver(request, env, session, controlPlane);
  if (path === "/agent/machine/check") return await check(request, env, session, controlPlane, store, advise);
  return new Response(null, { status: 404 });
}
