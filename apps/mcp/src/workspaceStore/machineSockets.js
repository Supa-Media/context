/**
 * A machine runner's one WebSocket, held by the workspace object that owns
 * the machine (docs/decisions/texting-assistant/machines.md).
 *
 * The gateway's `/machines/socket` route has already resolved the machine's
 * grant with the control plane and names the machine in one header. That is
 * not enough on its own: the first frame is a challenge, and nothing but a
 * `hello` signed with the machine's private key is read until it is
 * answered, so a copied grant without the key opens nothing. Every frame
 * passes the protocol's validator (`machineProtocol.cjs`) before a field of
 * it is read; one that fails closes the socket.
 *
 * A newer verified socket for the same machine replaces an older one. A
 * socket that closes leaves its runs where they are: the runner reconnects,
 * lists the runs it still holds, and the job carries on in the same session.
 * Sockets hibernate: a socket's machine, nonce and whether it was verified
 * are rows here, keyed by an id on its attachment.
 *
 * Events for jobs (a run accepted, refused, a step, a result, the machine
 * gone offline) go to `notify`, and every one is also kept on the run's row,
 * so a job that missed one reads it with `ws.machine.run`.
 */

import protocol from "../../../../packages/shared/src/machineProtocol.cjs";
import { rulesOf } from "./machines.js";

const { PROTOCOL_VERSION, parseRunnerFrame, helloSigningText } = protocol;

/** The header the machine arrives in; the gateway's route sets it on a request with no other header. */
export const MACHINE_HEADER = "x-machine";
const TAG = "machine";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A socket lives at most this long, then the runner reconnects through the gateway, which checks the grant again. */
export const MACHINE_SOCKET_MAX_MS = 60 * 60 * 1000;
export const CLOSE_PROTOCOL = 1008;
export const CLOSE_REAUTH = 4401;
export const CLOSE_GONE = 4410;
/** Steps kept on a run's row for the page and the job; the job also gets each one as it comes. */
const STEPS_KEPT = 40;

const SCHEMA = [`CREATE TABLE IF NOT EXISTS ws_machine_sockets (id TEXT PRIMARY KEY, machine TEXT NOT NULL, nonce TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL)`];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

/** Ed25519 over `text`, with a raw 32-byte public key; false on anything malformed. */
export async function verifyEd25519(publicKey, text, signature) {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64url(signature), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

/** The machine the gateway named, or null. Never anything the runner sent. */
export function machineHeaderOf(raw) {
  let named;
  try {
    named = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!named || typeof named !== "object") return null;
  if (typeof named.machineId !== "string" || !ID.test(named.machineId)) return null;
  if (typeof named.workspaceId !== "string" || !ID.test(named.workspaceId)) return null;
  return { machineId: named.machineId, workspaceId: named.workspaceId };
}

/**
 * @param {{acceptWebSocket: Function, getWebSockets: Function}} state
 * @param {{exec: Function}} sql
 * @param {ReturnType<import("./machines.js").workspaceMachines>} machines
 * @param {{now?: () => number, pair?: () => [WebSocket, WebSocket], upgraded?: (client: WebSocket) => Response, nonce?: () => string, verify?: typeof verifyEd25519, notify?: (event: object) => Promise<void> | void}} [deps]
 */
export function machineSockets(state, sql, machines, deps = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const now = deps.now ?? (() => Date.now());
  const pair = deps.pair ?? (() => {
    const made = new WebSocketPair();
    return [made[0], made[1]];
  });
  const upgraded = deps.upgraded ?? ((client) => new Response(null, { status: 101, webSocket: client }));
  const nonce = deps.nonce ?? (() => base64url(crypto.getRandomValues(new Uint8Array(32))));
  const verify = deps.verify ?? verifyEd25519;
  const notify = async (event) => {
    try {
      await deps.notify?.(event);
    } catch {
      // Kept on the run's row; the job reads it with `ws.machine.run`.
    }
  };

  const socketId = (ws) => {
    try {
      const held = ws.deserializeAttachment();
      return held && held.machine === true && typeof held.id === "string" ? held.id : null;
    } catch {
      return null;
    }
  };
  const socketRow = (id) => all(sql.exec("SELECT id, machine, nonce, verified, deadline FROM ws_machine_sockets WHERE id = ?", id))[0] ?? null;
  const forget = (id) => sql.exec("DELETE FROM ws_machine_sockets WHERE id = ?", id);
  const send = (ws, message) => {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  const close = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  };
  const openSockets = () => state.getWebSockets(TAG).filter((ws) => ws.readyState === undefined || ws.readyState === 1);
  /** The verified socket a machine is connected on now, or null. */
  const socketFor = (machineId) => {
    for (const ws of openSockets()) {
      const id = socketId(ws);
      const row = id ? socketRow(id) : null;
      if (row && row.machine === machineId && row.verified === 1 && row.deadline > now()) return ws;
    }
    return null;
  };
  const runEvent = async (machineId, runId, event, patch = {}, nextState) => {
    const held = machines.run(runId);
    if (!held || held.machineId !== machineId) return null;
    // An ending keeps the rest of its patch too (the session a later part resumes), not only the result.
    const { result, ...rest } = patch;
    if (nextState === "ended" && Object.keys(rest).length > 0) machines.update(runId, rest);
    const updated = nextState === "ended" ? machines.end(runId, result ?? {}) : machines.update(runId, patch, nextState);
    if (updated) await notify({ ...event, machineId, runId, jobId: held.jobId });
    return updated;
  };

  async function hello(ws, row, message) {
    const machine = machines.get(row.machine);
    if (!machine || message.machineId !== row.machine || !(await verify(machine.publicKey, helloSigningText(row.machine, row.nonce), message.signature))) {
      send(ws, { type: "goodbye", reason: "bad_signature" });
      close(ws, CLOSE_PROTOCOL, "bad signature");
      forget(row.id);
      return;
    }
    // One socket per machine: an older one is told it was replaced.
    for (const other of openSockets()) {
      const otherId = socketId(other);
      if (otherId === null || otherId === row.id) continue;
      const otherRow = socketRow(otherId);
      if (otherRow?.machine !== row.machine) continue;
      send(other, { type: "goodbye", reason: "replaced" });
      close(other, CLOSE_GONE, "replaced");
      forget(otherId);
    }
    sql.exec("UPDATE ws_machine_sockets SET verified = 1 WHERE id = ?", row.id);
    const seen = machines.seen(row.machine, { facts: message.facts, slotCounts: message.slots });
    // The runs both sides still hold carry on; ours it lost are ended, and its own we no longer want it cancels.
    const held = new Map(message.runs.map((reported) => [reported.runId, reported]));
    const keepRuns = [];
    for (const live of machines.liveRuns(row.machine)) {
      const reported = held.get(live.runId);
      if (reported) {
        keepRuns.push(live.runId);
        const patch = {};
        if (reported.session) patch.session = reported.session;
        if (Number.isSafeInteger(reported.lastStep)) patch.lastStep = Math.max(live.lastStep ?? 0, reported.lastStep);
        await runEvent(row.machine, live.runId, { kind: "resumed", alive: reported.alive, session: patch.session ?? live.session ?? null }, patch);
      } else {
        await runEvent(row.machine, live.runId, { kind: "result", outcome: "lost", session: live.session ?? null }, { result: { outcome: "lost", session: live.session ?? null } }, "ended");
      }
    }
    send(ws, { type: "welcome", machineId: row.machine, name: seen.name, rules: rulesOf(seen, now()), keepRuns });
    // A mail-only device's recent mail again: a line sent while it was between sockets reaches it now, and one it already
    // has it keeps once by its id.
    for (const frame of machines.heldMail?.(row.machine) ?? []) send(ws, frame);
    await notify({ kind: "online", machineId: row.machine });
  }

  async function verified(ws, row, message) {
    const machineId = row.machine;
    switch (message.type) {
      case "hello":
        // A second hello on a verified socket is a confused runner.
        close(ws, CLOSE_PROTOCOL, "hello twice");
        return;
      case "accept":
        await runEvent(machineId, message.runId, { kind: "accepted" }, {}, "running");
        return;
      case "refuse":
        await runEvent(machineId, message.runId, { kind: "refused", code: message.code, until: message.until ?? null }, { result: { outcome: "failed", error: `refused: ${message.code}`, refused: message.code, wallMs: 0 } }, "ended");
        return;
      case "session":
        await runEvent(machineId, message.runId, { kind: "session", session: message.session }, { session: message.session });
        return;
      case "step": {
        const held = machines.run(message.runId);
        if (!held || held.machineId !== machineId || message.seq <= (held.lastStep ?? 0)) return; // a resend after a reconnect
        const step = { seq: message.seq, tool: message.tool, action: message.action ?? null, target: message.target ?? null, at: message.at };
        await runEvent(machineId, message.runId, { kind: "step", step }, { lastStep: message.seq, steps: [...(held.steps ?? []), step].slice(-STEPS_KEPT) });
        return;
      }
      case "usage": {
        const machine = machines.get(machineId);
        if (message.planLimited === true && machine?.limits.pauseNearPlanLimit) {
          machines.seen(machineId, { pausedUntil: Number.isSafeInteger(message.planResetsAt) ? message.planResetsAt : now() + 60 * 60 * 1000 });
        }
        await runEvent(machineId, message.runId, { kind: "usage", wallMs: message.wallMs, planLimited: message.planLimited === true }, { wallMs: message.wallMs, tokens: message.tokens ?? null });
        return;
      }
      case "result": {
        const result = { outcome: message.outcome, answer: message.answer ?? "", session: message.session ?? null, lastStep: message.lastStep ?? null, wallMs: message.wallMs, error: message.error ?? null, branch: message.branch ?? null };
        await runEvent(machineId, message.runId, { kind: "result", ...result }, { result, ...(result.session ? { session: result.session } : {}) }, "ended");
        return;
      }
      case "status":
        machines.seen(machineId, { status: { ready: message.ready, notReady: message.notReady ?? null, busy: message.busy, freeMemoryMb: message.freeMemoryMb, tools: message.tools ?? null }, ...(message.pausedUntil !== undefined ? { pausedUntil: message.pausedUntil } : {}) });
        return;
      case "signInState": {
        // Only the sign-in this machine's owner started last: an old or unknown id changes nothing.
        const held = machines.get(machineId)?.signIn;
        if (!held || held.id !== message.signInId || held.tool !== message.tool || held.state === "done" || held.state === "failed") return;
        machines.signIn(machineId, { id: held.id, tool: held.tool, state: message.state, ...(message.url ? { url: message.url } : {}), ...(message.userCode ? { userCode: message.userCode } : {}), ...(message.error ? { error: message.error } : {}) });
        return;
      }
      case "installState": {
        // Only the install this machine's owner started last: an old or unknown id changes nothing.
        const held = machines.get(machineId)?.install;
        if (!held || held.id !== message.installId || held.tool !== message.tool || held.state === "done" || held.state === "failed") return;
        machines.install(machineId, { id: held.id, tool: held.tool, state: message.state, step: message.step, percent: message.percent, version: message.version, error: message.error });
        return;
      }
      default:
        close(ws, CLOSE_PROTOCOL, "unknown frame");
    }
  }

  return {
    owns: (ws) => socketId(ws) !== null,
    online: (machineId) => socketFor(machineId) !== null,

    /** A socket the gateway already resolved the grant of; the challenge goes first. */
    accept(request) {
      const named = machineHeaderOf(request.headers.get(MACHINE_HEADER));
      if (named === null) return new Response("bad machine", { status: 400 });
      if (machines.get(named.machineId) === null) return new Response("unknown machine", { status: 404 });
      // A mail-only device past its time is dropped here, before it is let back in.
      if (machines.leaving(() => false).includes(named.machineId) && this.prune()) return new Response("unknown machine", { status: 404 });
      const [client, server] = pair();
      state.acceptWebSocket(server, [TAG]);
      // Rows of sockets no longer held (a hibernated object woke without them) are dropped as new ones come.
      const held = new Set(openSockets().map(socketId).filter(Boolean));
      for (const row of all(sql.exec("SELECT id FROM ws_machine_sockets"))) if (!held.has(row.id)) forget(row.id);
      const id = crypto.randomUUID();
      const challenge = nonce();
      sql.exec("INSERT INTO ws_machine_sockets (id, machine, nonce, verified, deadline) VALUES (?, ?, ?, 0, ?)", id, named.machineId, challenge, now() + MACHINE_SOCKET_MAX_MS);
      server.serializeAttachment({ machine: true, id });
      send(server, { type: "challenge", protocol: PROTOCOL_VERSION, nonce: challenge });
      return upgraded(client);
    },

    async message(ws, raw) {
      const id = socketId(ws);
      const row = id ? socketRow(id) : null;
      if (!row) return close(ws, CLOSE_PROTOCOL, "unknown socket");
      if (row.deadline <= now()) {
        forget(id);
        return close(ws, CLOSE_REAUTH, "reconnect");
      }
      const parsed = parseRunnerFrame(typeof raw === "string" ? raw : null);
      if (!parsed.ok) return close(ws, CLOSE_PROTOCOL, parsed.error.slice(0, 100));
      if (row.verified !== 1) {
        if (parsed.message.type !== "hello") return close(ws, CLOSE_PROTOCOL, "hello first");
        return await hello(ws, row, parsed.message);
      }
      return await verified(ws, row, parsed.message);
    },

    async closed(ws) {
      const id = socketId(ws);
      const row = id ? socketRow(id) : null;
      if (id) forget(id);
      // When it went offline is when it was last seen: a mail-only device leaves on its own 15 minutes later.
      if (row?.verified === 1) machines.seen(row.machine, {});
      // Only the verified socket going means the machine is offline; its runs wait for it to come back.
      if (row?.verified === 1 && socketFor(row.machine) === null) await notify({ kind: "offline", machineId: row.machine });
    },

    /**
     * Mail-only devices whose time is up or whose session is gone (`machines.leaving`), removed with a goodbye.
     * Run before anything lists, mails or lets one in, so a gone device is never shown or written to. True when one went.
     */
    prune() {
      const gone = machines.leaving((machineId) => socketFor(machineId) !== null);
      for (const machineId of gone) {
        this.goodbye(machineId, "revoked");
        machines.remove(machineId);
      }
      return gone.length > 0;
    },

    /** Sends a server frame to a machine's verified socket; false when it is offline. */
    send(machineId, message) {
      const ws = socketFor(machineId);
      return ws !== null && send(ws, message);
    },

    /** The owner changed the rules: the runner takes them for new assignments. */
    rulesChanged(machineId) {
      const machine = machines.get(machineId);
      return machine !== null && this.send(machineId, { type: "rules", rules: rulesOf(machine, now()) });
    },

    /** Disconnected or revoked: told, closed, and not to come back. */
    goodbye(machineId, reason = "revoked") {
      for (const ws of openSockets()) {
        const id = socketId(ws);
        if (!id || socketRow(id)?.machine !== machineId) continue;
        send(ws, { type: "goodbye", reason });
        close(ws, CLOSE_GONE, reason);
        forget(id);
      }
    },
  };
}
