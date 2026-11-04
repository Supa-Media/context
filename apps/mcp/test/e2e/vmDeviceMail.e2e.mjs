/**
 * End to end: a Claude Code cloud VM becomes a mail-only device, and mail sent
 * to it reaches the session running there
 * (docs/decisions/texting-assistant/machines.md, "A cloud VM as a mail-only device").
 *
 * Everything is the real code except the control plane (an in-memory stand-in
 * that keeps pairings and machines the way the Convex functions do; those have
 * their own tests in apps/convex/__tests__/texMachines.test.ts) and the network
 * between the runner and the gateway (a local HTTP server with a small
 * WebSocket shim that hands frames to the workspace object's real socket code):
 *
 *  - the real `context-machine` binary, driven only through the commands the
 *    repository's Claude Code hooks run (`hook session-start`, `hook prompt`,
 *    `hook stop`, `hook session-end`) and `mail wait`;
 *  - the gateway's real machine routes (`machines/routes.js`), the real
 *    `pair_device` tool (`tools/pairDevice.js`), the real mail delivery
 *    (`mail/deliver.js`), and the workspace object's real machine rows and
 *    sockets (`workspaceStore/machines.js`, `machineSockets.js`,
 *    `serveMachines.js`).
 *
 * The session's side is what Claude Code does with a hook's output: SessionStart
 * and UserPromptSubmit stdout is added to what the model reads, a Stop hook's
 * `{"decision":"block"}` keeps the turn going with its reason, and a background
 * command ending wakes the session.
 *
 * Needs the runner built (`cargo build` in apps/machine-runner). CI builds it
 * and runs this file (.github/workflows/machine-runner.yml); without the binary
 * the test is skipped locally and fails in CI.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { handleMachines } from "../../src/machines/routes.js";
import { toolPairDevice } from "../../src/tools/pairDevice.js";
import { deliverMail } from "../../src/mail/deliver.js";
import { workspaceMachines } from "../../src/workspaceStore/machines.js";
import { MACHINE_HEADER, machineSockets } from "../../src/workspaceStore/machineSockets.js";
import { serveMachineCall } from "../../src/workspaceStore/serveMachines.js";
import { opOf } from "../../src/texStore/move.js";

const require = createRequire(import.meta.url);
const protocol = require("../../../../packages/shared/src/machineProtocol.cjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CONTEXT_MACHINE_BIN ?? join(HERE, "../../../machine-runner/target/debug/context-machine");
const HAVE_BIN = existsSync(BIN);
if (!HAVE_BIN && process.env.CI) throw new Error(`the runner is not built at ${BIN}: run cargo build in apps/machine-runner first`);

const WORKSPACE = "ws_seyi";
const OWNER = "user_seyi";
/** The VM session's own Context connection: an MCP client's grant on the owner's personal workspace. */
const MCP_TOKEN = "cat_vm_session_token";

// ── The control plane, in memory ─────────────────────────────────────────────

function controlPlane() {
  const pairings = new Map();
  const machines = new Map();
  const grants = new Map([[MCP_TOKEN, { id: "grant_vm", userId: OWNER, workspaceId: WORKSPACE, clientId: "claude_code", active: true }]]);
  let next = 0;
  const live = (m) => m && !m.revoked && (m.pairedByGrant === undefined || grants.get(m.pairedByGrant)?.active === true);
  return {
    pairings,
    machines,
    grants,
    async texMachinePairStart({ code, publicKey, name, os, facts }) {
      if ([...pairings.values()].some((p) => p.code === code)) return { taken: true };
      const pairingId = `pair_${(next += 1)}`;
      pairings.set(pairingId, { code, publicKey, name, os, facts, status: "waiting" });
      return { pairingId, expiresAt: Date.now() + 600_000 };
    },
    async texMachinePairRead(pairingId) {
      const p = pairings.get(pairingId);
      return p ? { status: p.status, publicKey: p.publicKey, expired: false, name: p.name, os: p.os, facts: p.facts } : null;
    },
    /** What `approveTexMachinePairingFromGrant` does: the grant's own person and workspace, always mail-only. */
    async texMachinePairApproveFromGrant(accessToken, workspaceId, code) {
      const grant = grants.get(accessToken);
      if (!grant?.active || grant.workspaceId !== workspaceId) return { refused: "unauthorized" };
      const pairing = [...pairings.values()].find((p) => p.code.replace("-", "") === String(code).toUpperCase().replace(/[^A-Z0-9]/g, "") && p.status === "waiting");
      if (!pairing) return { refused: "PAIRING_NOT_FOUND" };
      Object.assign(pairing, { status: "approved", workspaceId, ownerId: grant.userId, mailOnly: true, pairedByGrant: accessToken });
      return { approved: { name: pairing.name, os: pairing.os } };
    },
    async texMachinePairClaim(pairingId, grant) {
      const p = pairings.get(pairingId);
      if (p?.status !== "approved") return { refused: 409 };
      p.status = "claimed";
      const machineId = `mch_${(next += 1)}`;
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      machines.set(grant, { machineId, workspaceId: p.workspaceId, ownerId: p.ownerId, name: p.name, revoked: false, mailOnly: p.mailOnly === true, pairedByGrant: p.pairedByGrant, expiresAt });
      return { machineId, workspaceId: p.workspaceId, ownerId: p.ownerId, name: p.name, workspaceHandle: "seyi", mailOnly: p.mailOnly === true, expiresAt };
    },
    async texMachineResolve(grant) {
      const m = machines.get(grant);
      return live(m) ? { machineId: m.machineId, workspaceId: m.workspaceId, ownerId: m.ownerId, mailOnly: m.mailOnly } : null;
    },
    async texMachineLeave(grant) {
      const m = machines.get(grant);
      if (!live(m)) return null;
      m.revoked = true;
      return { machineId: m.machineId, workspaceId: m.workspaceId };
    },
    async texMachineRevoke(machineId) {
      for (const m of machines.values()) if (m.machineId === machineId) m.revoked = true;
      return { revoked: true };
    },
  };
}

// ── The workspace object's machine side, over a real socket ──────────────────

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

/**
 * One workspace object. Its sockets are the hibernation API's shape; each one
 * the object accepts is bridged to the real TCP connection the runner opened.
 */
function workspaceObject() {
  const sql = sqlite();
  const accepted = [];
  let bridging = null;
  const state = { acceptWebSocket: (ws) => accepted.push(ws), getWebSockets: () => accepted.filter((ws) => ws.readyState === 1) };
  const machines = workspaceMachines(sql);
  const sockets = machineSockets(state, sql, machines, { pair: () => [null, bridging], upgraded: () => ({ status: 101 }) });
  const store = { machines, machineSockets: sockets };
  return {
    machines,
    sockets,
    store,
    /** The next socket the object accepts is this bridge. */
    bridgeNext(bridge) {
      bridging = bridge;
    },
  };
}

function objects() {
  const object = workspaceObject();
  const namespace = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(request) {
        assert.equal(name, `workspace:${WORKSPACE}`, "every call reaches the owner's own workspace object");
        if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return object.sockets.accept(request);
        return await serveMachineCall(object.store, opOf(request), JSON.parse(await request.text()));
      },
    }),
  };
  return { object, env: { WORKSPACE_STORE: namespace } };
}

// ── A small WebSocket server (RFC 6455 text frames), enough for one runner ───

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frameOf(text, opcode = 1) {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]) : null;
  if (head === null) throw new Error("frame too long for this shim");
  return Buffer.concat([head, payload]);
}

/** Reads client frames off `socket`, unmasking them; calls `onText` per text frame and `onClose` once. */
function readFrames(socket, { onText, onClose }) {
  let buffered = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const opcode = buffered[0] & 0x0f;
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (buffered[1] & 0x80) !== 0;
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] ^= buffered[maskAt + (i % 4)];
      buffered = buffered.subarray(offset + length);
      if (opcode === 1) onText(payload.toString("utf8"));
      else if (opcode === 8) {
        socket.end();
        close();
      } else if (opcode === 9) socket.write(frameOf(payload.toString("utf8"), 10));
    }
  });
  socket.on("close", close);
  socket.on("error", close);
}

// ── The gateway, served on loopback ──────────────────────────────────────────

async function gateway() {
  const plane = controlPlane();
  const { object, env } = objects();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    const response = await handleMachines(request, env, { path: new URL(request.url).pathname, origin }, { controlPlane: plane });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const upgraded = new Set();
  server.on("upgrade", async (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const bridge = {
      readyState: 1,
      attachment: null,
      sent: [],
      open: false,
      held: [],
      send(text) {
        this.sent.push(JSON.parse(text));
        // The object sends its challenge while accepting, before the 101 is written: held until then.
        if (this.open) socket.write(frameOf(text));
        else this.held.push(text);
      },
      close() {
        this.readyState = 3;
        try {
          socket.write(Buffer.from([0x88, 0]));
          socket.end();
        } catch {
          // Already gone.
        }
      },
      serializeAttachment(value) {
        this.attachment = structuredClone(value);
      },
      deserializeAttachment() {
        return this.attachment;
      },
    };
    object.bridgeNext(bridge);
    const request = new Request(`${origin}${req.url}`, { headers: req.headers });
    const response = await handleMachines(request, env, { path: new URL(request.url).pathname, origin }, { controlPlane: plane });
    if (response.status !== 101) {
      socket.end(`HTTP/1.1 ${response.status} No\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    bridge.open = true;
    for (const text of bridge.held.splice(0)) socket.write(frameOf(text));
    readFrames(socket, {
      onText: (text) => void object.sockets.message(bridge, text),
      onClose: () => {
        bridge.readyState = 3;
        void object.sockets.closed(bridge);
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  /** The VM session's own Context tools: what its MCP connection reaches for this person. */
  const session = {
    pairDevice: (code) => plane.texMachinePairApproveFromGrant(MCP_TOKEN, WORKSPACE, code),
  };
  const close = async () => {
    for (const socket of upgraded) socket.destroy();
    server.closeAllConnections();
    server.close();
  };
  return { plane, object, env, endpoint, session, close };
}

// ── The runner, as the repository's hooks run it ─────────────────────────────

function runner(dir, endpoint) {
  const env = { ...process.env, CONTEXT_MACHINE_DIR: dir, CONTEXT_MACHINE_ENDPOINT: endpoint, HOME: dir, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const run = (args, { input = "", timeoutMs = 20_000 } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(BIN, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`context-machine ${args.join(" ")} took over ${timeoutMs} ms\n${stderr}`));
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  /** A hook, with the JSON Claude Code writes on its stdin. */
  const hook = (event, extra = {}) => run(["hook", event], { input: JSON.stringify({ session_id: "sess_1", hook_event_name: event, ...extra }) });
  return { run, hook };
}

async function until(what, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const CODE = /\b([A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3})\b/;

test("a Claude Code VM pairs through its own Context connection, shows up mail-only, gets mail at once, and leaves at the end", { skip: !HAVE_BIN && "the runner is not built" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vm-device-"));
  const gw = await gateway();
  const vm = runner(dir, gw.endpoint);
  t.after(async () => {
    await vm.hook("SessionEnd").catch(() => {});
    await gw.close();
    if (!process.env.KEEP_E2E_DIR) rmSync(dir, { recursive: true, force: true });
  });

  // 1. Session start: the hook starts pairing and tells Claude the code and the tool to approve it with.
  const start = await vm.hook("SessionStart", { source: "startup" });
  assert.equal(start.code, 0, start.stderr);
  const code = CODE.exec(start.stdout)?.[1];
  assert.ok(code, `the session is told a pairing code:\n${start.stdout}`);
  assert.match(start.stdout, /pair_device/, "and which Context action approves it");

  // 2. Claude calls the Context tool with the code, from the connection it already has.
  const tool = await toolPairDevice({ pairDevice: gw.session.pairDevice }, { code });
  assert.notEqual(tool.isError, true, tool.content?.[0]?.text);
  assert.match(tool.content[0].text, /mail only/i);

  // 3. The runner collects its own grant and connects; the device is in the workspace object, online, mail-only.
  const device = await until(`the device to come online (daemon log: ${join(dir, "daemon.log")})`, () => {
    const held = gw.object.machines.list()[0];
    return held && gw.object.sockets.online(held.id) ? held : null;
  });
  assert.equal(device.mailOnly, true);
  assert.deepEqual(device.tools, [], "a mail-only device offers Tex no coding tool");
  assert.equal(gw.object.machines.admit(device.id, { chat: "texts-user_seyi", fromOwner: true, askerId: OWNER, tool: "claude", folder: "/root/work" }, true)?.code, "mail_only", "and never takes a job");
  const status = JSON.parse((await vm.run(["status", "--json"])).stdout);
  assert.equal(status.machineId, device.id);

  // 4. The next prompt tells Claude its device id, so it can join mail as this device.
  const prompt = await vm.hook("UserPromptSubmit", { prompt: "carry on" });
  assert.match(prompt.stdout, new RegExp(device.id));

  // 5. Claude keeps `mail wait` running in the background; mail sent to the device ends it at once with the text.
  const waiting = vm.run(["mail", "wait", "--timeout", "15"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sentAt = Date.now();
  const boxes = async () => [{ mailboxId: "mb_vm1", name: "vm-builder", machineId: device.id }];
  const line = { path: "projects/tex/vm-network.md", at: new Date().toISOString(), from: "lead", app: "Claude", to: "vm-builder", mailKind: "ask", text: "Did the API types move?" };
  const delivered = await deliverMail(gw.env, { jobMailboxes: boxes, workspaceId: WORKSPACE }, line);
  assert.deepEqual(delivered, ["vm-builder"], "the sender is told it was delivered");
  const woke = await waiting;
  assert.equal(woke.code, 0, woke.stderr);
  assert.match(woke.stdout, /Did the API types move\?/);
  assert.match(woke.stdout, /from lead/);
  assert.match(woke.stdout, /projects\/tex\/vm-network\.md/, "with the note that holds the record");
  assert.ok(Date.now() - sentAt < 3000, "within seconds");

  // 6. Mail that arrives with no waiter is not lost: the Stop hook keeps the turn going until Claude has seen it.
  await deliverMail(gw.env, { jobMailboxes: boxes, workspaceId: WORKSPACE }, { ...line, at: new Date().toISOString(), mailKind: "note", text: "Merged #3001." });
  const stop = await until("the runner to hold the second mail", async () => {
    const answer = await vm.hook("Stop", { stop_hook_active: false });
    return answer.stdout.trim() ? answer : null;
  });
  const blocked = JSON.parse(stop.stdout);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /Merged #3001\./);
  // Shown once: the next prompt and the next stop carry nothing more.
  assert.equal((await vm.hook("Stop", { stop_hook_active: true })).stdout.trim(), "");
  assert.doesNotMatch((await vm.hook("UserPromptSubmit", { prompt: "ok" })).stdout, /Merged/);

  // 7. A third mail reaches Claude on its next prompt as well.
  await deliverMail(gw.env, { jobMailboxes: boxes, workspaceId: WORKSPACE }, { ...line, at: new Date().toISOString(), mailKind: "note", text: "Third one." });
  const third = await until("the third mail on a prompt", async () => {
    const answer = await vm.hook("UserPromptSubmit", { prompt: "next" });
    return /Third one\./.test(answer.stdout) ? answer : null;
  });
  assert.match(third.stdout, /Third one\./);

  // 8. Session end: the device revokes its own grant and leaves the workspace object.
  const end = await vm.hook("SessionEnd", { reason: "exit" });
  assert.equal(end.code, 0, end.stderr);
  await until("the device to leave", () => gw.object.machines.list().length === 0);
  assert.ok([...gw.plane.machines.values()].every((m) => m.revoked), "its grant is revoked");
  assert.equal(await deliverMail(gw.env, { jobMailboxes: boxes, workspaceId: WORKSPACE }, line).then((names) => names.length), 0, "mail to a device that left is kept in the note only");
});

test("revoking the AI connection that paired a VM ends the device", { skip: !HAVE_BIN && "the runner is not built" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vm-device-"));
  const gw = await gateway();
  const vm = runner(dir, gw.endpoint);
  t.after(async () => {
    await vm.hook("SessionEnd").catch(() => {});
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = await vm.hook("SessionStart", { source: "startup" });
  const code = CODE.exec(start.stdout)?.[1];
  await toolPairDevice({ pairDevice: gw.session.pairDevice }, { code });
  const device = await until("the device to come online", () => gw.object.machines.list().find((m) => gw.object.sockets.online(m.id)));
  gw.plane.grants.get(MCP_TOKEN).active = false;
  // The grant no longer resolves, so the next socket is refused before the object.
  const response = await handleMachines(new Request(`${gw.endpoint}/machines/socket`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${[...gw.plane.machines.keys()][0]}` } }), gw.env, { path: "/machines/socket", origin: gw.endpoint }, { controlPlane: gw.plane });
  assert.equal(response.status, 401);
  assert.ok(device);
});

test("a code nobody is showing, or a connection to another workspace, approves nothing", async () => {
  const plane = controlPlane();
  const answer = await toolPairDevice({ pairDevice: (code) => plane.texMachinePairApproveFromGrant(MCP_TOKEN, WORKSPACE, code) }, { code: "ABC-DEF" });
  assert.equal(answer.isError, true);
  assert.equal((await toolPairDevice({ pairDevice: () => null }, { code: "nope" })).isError, true);
  assert.equal((await toolPairDevice({}, { code: "ABC-DEF" })).isError, true);
});
