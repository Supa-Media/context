/**
 * The app's screens for a person's own computers
 * (docs/decisions/texting-assistant/machines.md), with the signed-in app's
 * own session (`context_console`):
 *
 * - `POST /machines/app/list` `{ workspaceId }` → `{ ok, machines }`: the
 *   workspace's computers, read from its object. Whoever runs a computer (its
 *   owner or the workspace's owner) sees its
 *   settings, online state, use and running parts; any other member sees only
 *   its name, system, owner and whether it is online.
 * - `POST /machines/app/set` `{ workspaceId, machineId, patch }` → `{ ok,
 *   machine }`: change its settings (name, folders, tools, limits, computer
 *   use, trusted repos, chat rules, what it is good at). The object refuses an
 *   unknown key, and tells the runner the new rules at once.
 * - `POST /machines/app/disconnect` `{ workspaceId, machineId }` → `{ ok,
 *   ended }`: the control plane revokes its grant (and its run grants), then
 *   the object says goodbye on its socket and ends its live runs, so it stops
 *   now and not when its socket next reconnects.
 *
 * Pairing a computer is approved in the control plane itself
 * (`approveTexMachinePairing`); the runner's poll then adds it to the object.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";

const CONSOLE_CLIENT_ID = "context_console";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const MACHINE_APP_PATHS = new Set(["/machines/app/list", "/machines/app/set", "/machines/app/disconnect"]);

const forbidden = () => json({ error: "forbidden" }, 403);
const invalid = (detail) => json({ error: "invalid_request", error_description: detail }, 400);
const refused = (code) => json({ ok: false, code });

async function bodyOf(request) {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** The workspace the body names, when this session is a live member of it (never a group's home or setup row). */
function memberOf(session, workspaceId) {
  if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return null;
  const row = (session.workspaces || []).find((entry) => entry.workspaceId === workspaceId);
  if (!row || row.homeOnly === true || row.setupOnly === true) return null;
  return row;
}

/**
 * Who runs a computer: its owner or the workspace's owner, as the control plane decides who may disconnect it
 * (`revokeMachineAs`). Never another editor: who may send work to a computer is its rules, and another editor
 * who could change them could let themselves onto somebody else's computer.
 */
export function runsMachine(session, row, machine) {
  return machine?.ownerId === session.actorUserId || row.role === "owner";
}

async function call(env, workspaceId, op, fields) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return null;
  const response = await callTexStore(stub, op, {}, new TextEncoder().encode(JSON.stringify({ workspaceId, ...fields })));
  return await response.json();
}

/** What another member sees of a computer they don't run. */
const glimpse = (machine) => ({ id: machine.id, name: machine.name, os: machine.os ?? null, ownerId: machine.ownerId, online: machine.online === true });

async function list(env, session, body) {
  const row = memberOf(session, body.workspaceId);
  if (row === null) return refused("unknown_workspace");
  const answer = await call(env, row.workspaceId, "ws.machine.list", {});
  if (answer === null) return json({ error: "machines_unavailable" }, 501);
  if (answer.ok !== true) return refused(answer.code ?? "server_error");
  return json({ ok: true, machines: answer.machines.map((machine) => (runsMachine(session, row, machine) ? { ...machine, runs: true } : glimpse(machine))) });
}

/** The computer, when this session may run it; null reads the same as no such computer. */
async function runnable(env, session, body) {
  const row = memberOf(session, body.workspaceId);
  if (row === null || typeof body.machineId !== "string" || !ID.test(body.machineId)) return null;
  const answer = await call(env, row.workspaceId, "ws.machine.get", { id: body.machineId });
  if (answer?.ok !== true || !runsMachine(session, row, answer.machine)) return null;
  return { row, machine: answer.machine };
}

async function set(env, session, body) {
  if (body.patch === null || typeof body.patch !== "object" || Array.isArray(body.patch)) return invalid("patch");
  const found = await runnable(env, session, body);
  if (found === null) return refused("unknown_machine");
  const answer = await call(env, found.row.workspaceId, "ws.machine.set", { id: found.machine.id, patch: body.patch });
  return answer?.ok === true ? json({ ok: true, machine: { ...answer.machine, runs: true } }) : refused(answer?.code ?? "server_error");
}

async function disconnect(env, session, body, controlPlane) {
  const found = await runnable(env, session, body);
  if (found === null) return refused("unknown_machine");
  // The control plane decides too (`revokeMachineAs`): its owner or the workspace's owner. Its grant goes first,
  // so a computer that is not told (offline, or the object unreachable) still can't reconnect.
  const revoked = await controlPlane.texMachineRevoke(found.machine.id, session.actorUserId);
  if (revoked === null || revoked.workspaceId !== found.row.workspaceId) return refused("not_allowed");
  const answer = await call(env, found.row.workspaceId, "ws.machine.remove", { id: found.machine.id, reason: "revoked" }).catch(() => null);
  return json({ ok: true, ended: answer?.ok === true ? answer.ended.length : 0 });
}

/** One of `MACHINE_APP_PATHS`, for a session already resolved from the app's own token. */
export async function handleMachineApp(request, env, session, { path, controlPlane }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (session.actorClientId !== CONSOLE_CLIENT_ID) return forbidden();
  if (path !== "/machines/app/list" && !hasScope(session, SCOPE_WRITE)) return forbidden();
  if (!env.WORKSPACE_STORE) return json({ error: "machines_unavailable" }, 501);
  const body = await bodyOf(request);
  if (body === null) return invalid("body");
  if (path === "/machines/app/list") return await list(env, session, body);
  if (path === "/machines/app/set") return await set(env, session, body);
  if (path === "/machines/app/disconnect") return await disconnect(env, session, body, controlPlane);
  return new Response(null, { status: 404 });
}
