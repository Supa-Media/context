/**
 * A workspace object's machine side with a fake runner, for tests: real
 * Ed25519 keys, the real validator, an in-memory SQLite, and sockets that
 * record what they were sent. `world.connect()` pairs a runner's socket and
 * answers the challenge the way the Rust runner does.
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { workspaceMachines } from "../src/workspaceStore/machines.js";
import { MACHINE_HEADER, machineSockets } from "../src/workspaceStore/machineSockets.js";
import { serveMachineCall } from "../src/workspaceStore/serveMachines.js";

const require = createRequire(import.meta.url);
export const protocol = require("../../../packages/shared/src/machineProtocol.cjs");

function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        const rows = statement.all(...binds);
        return { toArray: () => rows };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

export function fakeSocket() {
  return {
    sent: [],
    closed: null,
    readyState: 1,
    attachment: null,
    send(frame) {
      this.sent.push(JSON.parse(frame));
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
    },
    serializeAttachment(value) {
      this.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return this.attachment;
    },
    last() {
      return this.sent[this.sent.length - 1];
    },
  };
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

export async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { publicKey, sign: async (text) => b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(text)))) };
}

export const FACTS = { os: "linux", arch: "x86_64", memoryMb: 8192, cores: 4, tools: [{ name: "claude", installed: true, signedIn: true }] };

export function machineWorld({ workspaceId = "ws_a", clock = { at: 1_793_770_000_000 } } = {}) {
  const sql = sqlite();
  const accepted = [];
  const events = [];
  const state = { acceptWebSocket: (ws) => accepted.push(ws), getWebSockets: () => accepted.filter((ws) => ws.readyState === 1) };
  const now = () => clock.at;
  const machines = workspaceMachines(sql, { now });
  const sockets = machineSockets(state, sql, machines, { now, pair: () => [fakeSocket(), fakeSocket()], upgraded: (client) => ({ status: 101, webSocket: client }), notify: (event) => void events.push(event) });
  const store = { machines, machineSockets: sockets };
  const call = async (op, fields) => await (await serveMachineCall(store, op, fields)).json();

  const world = {
    workspaceId,
    clock,
    machines,
    sockets,
    events,
    call,
    accepted,
    /** A machine the control plane paired, added the way the gateway adds it. */
    async add(id = "mch_1", fields = {}) {
      const keys = await keyPair();
      const answer = await call("ws.machine.add", { machine: { id, name: id, os: "linux", ownerId: "user_owner", publicKey: keys.publicKey, folders: ["/srv/code"], ...fields } });
      if (!answer.ok) throw new Error(`add refused: ${answer.code}`);
      return { id, keys };
    },
    /** Opens a socket the gateway resolved for `machineId`; returns the server end, which holds what was sent to the runner. */
    open(machineId, named = { machineId, workspaceId }) {
      const response = sockets.accept({ headers: new Headers({ [MACHINE_HEADER]: JSON.stringify(named) }) });
      if (response.status !== 101) return { response, server: null };
      return { response, server: accepted[accepted.length - 1] };
    },
    async frame(server, message) {
      await sockets.message(server, typeof message === "string" ? message : JSON.stringify(message));
    },
    /** Pairs a socket and answers its challenge; `runs` are the runs the runner says it still holds. */
    async connect(machine, { runs = [], sign = machine.keys.sign, hello = {} } = {}) {
      const { server } = world.open(machine.id);
      const challenge = server.sent[0];
      const signature = await sign(protocol.helloSigningText(machine.id, challenge.nonce));
      await world.frame(server, { type: "hello", protocol: 1, machineId: machine.id, signature, runner: "0.1.0", facts: FACTS, slots: protocol.slotCounts(FACTS.memoryMb, FACTS.cores), runs, ...hello });
      return server;
    },
    grant: () => ({ token: "run-grant-0000000000000000", expiresAt: clock.at + 900000, mcpUrl: "https://mcp.example.test/mcp" }),
    /** An assignment as the job object sends it. */
    assignment(machineId, fields = {}) {
      return { machineId, jobId: "job_1", part: 1, chat: "chat_owner", fromOwner: true, askerId: "user_owner", tool: "claude", folder: "/srv/code", permission: "edits", brief: "Fix the flaky test.", doneWhen: "It passes.", grant: world.grant(), deadline: clock.at + 900000, ...fields };
    },
  };
  return world;
}
