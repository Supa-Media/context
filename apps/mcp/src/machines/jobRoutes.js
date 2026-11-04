/**
 * A background job's part on a person's own computer, asked for by the
 * texting Worker's job object (docs/decisions/texting-assistant/machines.md).
 * Each route is reached with the job's own texting token, resolved as `/agent`
 * resolves it, and answers only a person's own 1:1 texting client with write
 * scope: a group's job reaches a machine only once groups are built, and then
 * through the owner's "who may ask" rules in the workspace object.
 *
 * - `POST /agent/machine/assign` `{ workspaceId, machineId, jobId, part, tool,
 *   folder, permission, brief, ... }` → `{ ok, runId, deadline, powers }` or
 *   `{ ok: false, code }`. The gateway mints the run id and a run grant for
 *   it (the control plane's `texMachineRunGrants`: the job's own grant, under
 *   `context_tex_machine_run`, never sending anything), then the workspace
 *   object checks the machine's rules and sends the assignment. A refused
 *   assignment takes its run grant back at once.
 * - `POST /agent/machine/run` `{ workspaceId, runId }` → `{ ok, run, online }`:
 *   the run's state, steps and result, read from the object. An ended run's
 *   grant is taken back here too, in case the part ended before it expired.
 * - `POST /agent/machine/cancel` `{ workspaceId, runId, reason? }` → `{ ok }`.
 * - `POST /agent/machine/deliver` `{ workspaceId, runId, messageId, text,
 *   interrupt? }` → `{ ok }`: a later text of theirs, into the running
 *   session, as the next message or (`interrupt`) stopping the current step.
 *
 * A run is only ever read, steered or stopped by the person whose job it is
 * (`askerId`); any other run id answers `unknown_run`, as a run that does not
 * exist would.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";

export const MACHINE_RUN_CLIENT_ID = "context_tex_machine_run";
const TEXTS_CLIENT_ID = "context_texts";
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

/** The workspace the body names, when this session reaches it as a member (never a group's home or setup row). */
function coveredWorkspace(session, workspaceId) {
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return null;
  const covered = (session.workspaces || []).find((entry) => entry.workspaceId === workspaceId);
  if (!covered || covered.homeOnly === true || covered.setupOnly === true) return null;
  return covered;
}

async function call(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
  return await response.json();
}

/** A run of this person's, or null: another person's run reads as no run. */
async function ownRun(env, session, workspaceId, runId) {
  const answer = await call(env, workspaceId, "ws.machine.run", { runId });
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

async function assign(request, env, session, controlPlane, origin, now) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = coveredWorkspace(session, body.workspaceId);
  if (covered === null) return refused("unknown_machine");
  if (typeof body.machineId !== "string" || !ID.test(body.machineId)) return invalid("machineId");
  if (typeof body.jobId !== "string" || !ID.test(body.jobId)) return invalid("jobId");
  const machine = await call(env, covered.workspaceId, "ws.machine.get", { id: body.machineId });
  if (machine === null) return json({ error: "machines_unavailable" }, 501);
  if (machine.ok !== true) return refused("unknown_machine");
  const at = now();
  const deadline = Math.min(Number.isSafeInteger(body.deadline) ? body.deadline : at + MAX_PART_MS, at + MAX_PART_MS);
  const runId = mintRunId();
  const runGrant = await controlPlane.texMachineRunGrant({ parentToken: session.accessToken, machineId: body.machineId, runId, expiresAt: deadline });
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
    brief: body.brief,
    doneWhen: body.doneWhen,
    advice: body.advice,
    resumeSession: body.resumeSession,
    deadline,
    chatName: body.chatName,
    computerUse: body.computerUse === true,
    // Who asked comes from the grant, never the body: the person's own chat, so their own machine is "from the owner".
    // One chat per person's own texts, so an owner's rule for one person's chat never covers another's.
    chat: `texts-${session.actorUserId}`,
    askerId: session.actorUserId,
    fromOwner: machine.machine.ownerId === session.actorUserId,
    grant: { token: runGrant.accessToken, expiresAt: Math.min(runGrant.expiresAt, deadline), mcpUrl: `${origin.replace(/\/+$/, "")}/mcp` },
  };
  const answer = await call(env, covered.workspaceId, "ws.machine.assign", fields).catch(() => null);
  if (answer?.ok !== true) {
    await controlPlane.texMachineRunRevoke(runId).catch(() => null);
    return refused(answer?.code ?? "server_error");
  }
  return json({ ok: true, runId: answer.runId, deadline: answer.deadline, powers: answer.powers });
}

async function readRun(request, env, session, controlPlane) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = coveredWorkspace(session, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  const answer = await ownRun(env, session, covered.workspaceId, body.runId);
  if (answer === null) return refused("unknown_run");
  // Ended before its grant ran out: the grant goes now, not at its expiry.
  if (answer.run.state === "ended") await controlPlane.texMachineRunRevoke(body.runId).catch(() => null);
  return json({ ok: true, run: shownRun(answer.run), online: answer.online === true });
}

async function cancel(request, env, session, controlPlane) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = coveredWorkspace(session, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  if ((await ownRun(env, session, covered.workspaceId, body.runId)) === null) return refused("unknown_run");
  const reason = CANCEL_REASONS.has(body.reason) ? body.reason : "stopped";
  const answer = await call(env, covered.workspaceId, "ws.machine.cancel", { runId: body.runId, reason });
  await controlPlane.texMachineRunRevoke(body.runId).catch(() => null);
  return json({ ok: answer?.ok === true });
}

async function deliver(request, env, session) {
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  const covered = coveredWorkspace(session, body.workspaceId);
  if (covered === null || typeof body.runId !== "string" || !RUN_ID.test(body.runId)) return refused("unknown_run");
  if (typeof body.messageId !== "string" || !ID.test(body.messageId)) return invalid("messageId");
  if (typeof body.text !== "string" || body.text.trim() === "") return invalid("text");
  if ((await ownRun(env, session, covered.workspaceId, body.runId)) === null) return refused("unknown_run");
  const text = body.text.trim().slice(0, 4000);
  // Their own words, from their own chat: the one sender who may interrupt (with Tex), checked by who holds this grant.
  const op = body.interrupt === true ? "ws.machine.interrupt" : "ws.machine.deliver";
  const answer = await call(env, covered.workspaceId, op, { runId: body.runId, messageId: body.messageId, kind: "note", from: "the person", text });
  return json({ ok: answer?.ok === true });
}

export const MACHINE_JOB_PATHS = new Set(["/agent/machine/assign", "/agent/machine/run", "/agent/machine/cancel", "/agent/machine/deliver"]);

/** One of `MACHINE_JOB_PATHS`, for a session already resolved from the job's texting token. */
export async function handleMachineJob(request, env, session, { path, controlPlane, origin, now = Date.now }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (session.actorClientId !== TEXTS_CLIENT_ID || !hasScope(session, SCOPE_WRITE)) return forbidden();
  if (!env.WORKSPACE_STORE) return json({ error: "machines_unavailable" }, 501);
  if (path === "/agent/machine/assign") return await assign(request, env, session, controlPlane, origin, now);
  if (path === "/agent/machine/run") return await readRun(request, env, session, controlPlane);
  if (path === "/agent/machine/cancel") return await cancel(request, env, session, controlPlane);
  if (path === "/agent/machine/deliver") return await deliver(request, env, session);
  return new Response(null, { status: 404 });
}
