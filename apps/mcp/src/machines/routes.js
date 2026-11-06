/**
 * The gateway's machine routes (docs/decisions/texting-assistant/machines.md):
 *
 * - `POST /machines/pair`: a runner asks to be paired. The gateway mints a
 *   short code the person compares on both screens and approves in the app.
 * - `POST /machines/pair/poll`: the runner, signing with its private key,
 *   collects its grant once the person approved. Only the machine that asked
 *   can: the signature is checked against the public key the pairing started
 *   with, and a grant is minted only then.
 * - `GET /machines/socket`: the runner's one WebSocket. The grant is resolved
 *   with the control plane, then the workspace object that owns the machine
 *   takes the socket and asks for a signed hello before reading anything.
 * - `POST /machines/register`: the Mac app, already signed in, registers its
 *   own Mac with its connection's session instead of a code. The machine still
 *   gets a grant of its own, bound to its own key.
 * - `POST /machines/leave`: a machine gives its own grant back, as a cloud VM
 *   does when its session ends. The grant is revoked and the workspace object
 *   drops the machine, so it leaves the devices list at once.
 *
 * The private key never leaves the machine, the control plane keeps only
 * hashes, and the plain grant is returned once, to the machine.
 */

import { createControlPlane } from "../controlPlane.js";
import { resolvePresentedSession } from "../http/presentedToken.js";
import { hasScope, SCOPE_WRITE, SessionRefusal } from "../session.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { callTexStore } from "../texStore/wire.js";
import { MACHINE_HEADER, verifyEd25519 } from "../workspaceStore/machineSockets.js";
import protocol from "../../../../packages/shared/src/machineProtocol.cjs";

const { invalid, pairSigningText } = protocol;

export const MACHINE_PATHS = new Set(["/machines/pair", "/machines/pair/poll", "/machines/socket", "/machines/register", "/machines/leave"]);
/** Codes avoid 0/O and 1/I, so one read aloud or retyped is the same code. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const POLL_MS = 3000;
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function randomFrom(alphabet, length) {
  // 256 is a multiple of 32: no modulo bias.
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => alphabet[byte % alphabet.length]).join("");
}

export function mintPairingCode() {
  const raw = randomFrom(CODE_ALPHABET, 6);
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

/** A machine grant: 32 random bytes, never logged, returned once. */
export function mintMachineGrant() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `cmg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function appOrigin(env, origin) {
  const configured = typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN.startsWith("https://") ? env.APP_ORIGIN : null;
  return (configured ?? origin).replace(/\/+$/, "");
}

/** Adds a just-claimed machine to its workspace object; true when the object took it. */
async function addToObject(env, claimed, started) {
  const stub = workspaceStub(env, claimed.workspaceId);
  if (stub === null) return false;
  const machine = { id: claimed.machineId, ownerId: claimed.ownerId, publicKey: started.publicKey, name: claimed.name ?? started.name, os: started.os ?? started.facts?.os, facts: started.facts ?? null };
  // A device a session paired through its own Context connection takes mail and never jobs, and leaves by a time (`pair_device`).
  if (claimed.mailOnly === true) Object.assign(machine, { mailOnly: true, ...(Number.isSafeInteger(claimed.expiresAt) ? { expiresAt: claimed.expiresAt } : {}) });
  const response = await callTexStore(stub, "ws.machine.add", {}, new TextEncoder().encode(JSON.stringify({ workspaceId: claimed.workspaceId, machine })));
  return (await response.json())?.ok === true;
}

async function pairStart(request, env, deps, origin) {
  const fields = await body(request);
  const why = invalid("PairStart", fields);
  if (why !== null) return json({ error: "bad_request", why }, 400);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  for (let tries = 0; tries < 3; tries += 1) {
    const code = (deps.mintCode ?? mintPairingCode)();
    const started = await controlPlane.texMachinePairStart({ code, publicKey: fields.publicKey, name: fields.name, os: fields.facts.os, facts: fields.facts });
    if (started.taken) continue;
    if (started.refused) return json({ error: "refused" }, started.refused === 429 ? 429 : 400);
    const answer = { pairingId: started.pairingId, code, approveUrl: `${appOrigin(env, origin)}/tex?view=machines&code=${encodeURIComponent(code)}`, expiresAt: started.expiresAt, pollMs: POLL_MS };
    return json(answer);
  }
  return json({ error: "busy" }, 503);
}

async function pairPoll(request, env, deps, origin) {
  const fields = await body(request);
  const why = invalid("PairPoll", fields);
  if (why !== null) return json({ error: "bad_request", why }, 400);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  const read = await controlPlane.texMachinePairRead(fields.pairingId);
  // Unknown and unsigned look the same: nobody learns a pairing exists without its key.
  if (read === null || !(await (deps.verify ?? verifyEd25519)(read.publicKey, pairSigningText(fields.pairingId), fields.signature))) {
    return json({ error: "unknown_pairing" }, 404);
  }
  if (read.status === "declined") return json({ status: "declined" });
  if (read.expired || read.status === "claimed") return json({ status: "expired" });
  if (read.status !== "approved") return json({ status: "waiting" });
  const grant = (deps.mintGrant ?? mintMachineGrant)();
  const claimed = await controlPlane.texMachinePairClaim(fields.pairingId, grant);
  if (claimed.refused) return json({ status: "expired" });
  if (!(await addToObject(env, claimed, { publicKey: read.publicKey, name: read.name, os: read.os, facts: read.facts }).catch(() => false))) {
    // The object never took it: the grant is taken back, and the runner pairs again.
    await controlPlane.texMachineRevoke(claimed.machineId, claimed.ownerId).catch(() => null);
    return json({ error: "try_again" }, 503);
  }
  return json({ status: "approved", machineId: claimed.machineId, workspace: claimed.workspaceHandle, grant, socketUrl: socketUrlFor(origin) });
}

async function socket(request, env, deps) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("expected a websocket upgrade", { status: 426 });
  const grant = grantOf(request);
  if (grant === null) return json({ error: "unauthorized" }, 401);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  const machine = await controlPlane.texMachineResolve(grant);
  if (machine === null) return json({ error: "unauthorized" }, 401);
  const stub = workspaceStub(env, machine.workspaceId);
  if (stub === null) return json({ error: "machines_unavailable" }, 501);
  // The object trusts only this header, rebuilt here from the control plane's answer; nothing the runner sent.
  const forwarded = new Request("https://workspace-store.internal/machine", {
    headers: { Upgrade: "websocket", [MACHINE_HEADER]: JSON.stringify({ machineId: machine.machineId, workspaceId: machine.workspaceId }) },
  });
  return await stub.fetch(forwarded);
}

async function register(request, env, deps, origin) {
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let session;
  try {
    session = await (deps.resolveSession ?? resolvePresentedSession)(request, { pathToken: null, path: "/machines/register", slug: null, controlPlane });
  } catch (error) {
    if (error instanceof SessionRefusal) return json({ error: "unauthorized" }, error.status === 403 ? 403 : 401);
    throw error;
  }
  if (!hasScope(session, SCOPE_WRITE) || typeof session.actorUserId !== "string") return json({ error: "forbidden" }, 403);
  const fields = await body(request);
  const why = invalid("PairStart", fields);
  if (why !== null) return json({ error: "bad_request", why }, 400);
  const grant = (deps.mintGrant ?? mintMachineGrant)();
  const registered = await controlPlane.texMachineRegister({ userId: session.actorUserId, workspaceId: session.workspaceId, grant, publicKey: fields.publicKey, name: fields.name, os: fields.facts.os });
  if (registered.refused) return json({ error: "refused" }, registered.refused === 403 ? 403 : 400);
  if (!(await addToObject(env, registered, fields).catch(() => false))) {
    await controlPlane.texMachineRevoke(registered.machineId, registered.ownerId).catch(() => null);
    return json({ error: "try_again" }, 503);
  }
  return json({ machineId: registered.machineId, workspace: registered.workspaceHandle, grant, socketUrl: socketUrlFor(origin) });
}

/** The grant a runner presents as `Authorization: Bearer cmg_…`, or null. */
const grantOf = (request) => /^Bearer (cmg_[0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "")?.[1] ?? null;

/**
 * A machine leaving: its grant is revoked first, then its workspace object drops it and says goodbye on its socket.
 * Unknown and already-revoked grants answer the same 401, so a guess learns nothing.
 */
async function leave(request, env, deps) {
  const grant = grantOf(request);
  if (grant === null) return json({ error: "unauthorized" }, 401);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  const left = await controlPlane.texMachineLeave(grant);
  if (!left?.machineId) return json({ error: "unauthorized" }, 401);
  const stub = workspaceStub(env, left.workspaceId);
  if (stub !== null) await callTexStore(stub, "ws.machine.remove", {}, new TextEncoder().encode(JSON.stringify({ workspaceId: left.workspaceId, id: left.machineId, reason: "left" }))).catch(() => null);
  return json({ left: true });
}

// https → wss in every deployment; http → ws only ever answers a loopback gateway in a test, which the runner alone accepts.
const socketUrlFor = (origin) => `${origin.replace(/^http(s?):/, "ws$1:").replace(/\/+$/, "")}/machines/socket`;

/** One of `MACHINE_PATHS`, answered. */
export async function handleMachines(request, env, { path, origin }, deps = {}) {
  if (!env.WORKSPACE_STORE && !deps.allowWithoutObjects) return json({ error: "machines_unavailable" }, 501);
  try {
    if (path === "/machines/socket") return await socket(request, env, deps);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (path === "/machines/pair") return await pairStart(request, env, deps, origin);
    if (path === "/machines/pair/poll") return await pairPoll(request, env, deps, origin);
    if (path === "/machines/register") return await register(request, env, deps, origin);
    if (path === "/machines/leave") return await leave(request, env, deps);
  } catch {
    // Never relay a control-plane failure: the caller is a program on the open internet.
    return json({ error: "server_error" }, 503);
  }
  return new Response(null, { status: 404 });
}
