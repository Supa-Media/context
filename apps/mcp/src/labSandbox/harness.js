/**
 * ONE TEST TEXT'S TURN IN A LAB TEST CHAT (Dev2, 2026-11-16: "send test messages to see how the new architecture
 * responds ... have all the changes sandboxed so it doesn't actually affect production"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * The turn is the real one: `handleAgent`, on the session a real texted turn in that chat would run on (read from the
 * chat's own grant by the control plane, without its token), with the draft's wiring (`graph/turnGraph.js`
 * `withDraft`). What it runs on is not: its env is `sandboxEnvOf` (no texting Worker, no jobs, no browser, analytics
 * that keep nothing), its objects answer through `wire.js` (reads from the real ones, every change into this test
 * chat's object), its control-plane calls through `policy.js` `controlPlaneAnswer` and its tools through `toolAnswer`.
 * The gate below is what those three ask, and the only thing that knows which text the turn is for.
 */

import { handleAgent } from "../agent/route.js";
import { eventEntry } from "../agent/ledger.js";
import { createControlPlane } from "../controlPlane.js";
import { attachContextOpener, onceEach } from "../http/contextOpener.js";
import { attachPinnedDoors } from "../http/pinnedDoors.js";
import { decorateRequestStore } from "../http/requestStore.js";
import { attachLinkCalls } from "../http/routing.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { sessionFromPayload, storeForSession } from "../session.js";
import { callSandbox } from "./object.js";
import { sandboxEnvOf } from "./policy.js";
import { sandboxNamespace } from "./wire.js";
import { askOf, SANDBOX_EVENT_CHAT } from "./inbound.js";

export { SANDBOX_EVENT_CHAT };
/** A turn that has not answered by then is stopped and said so on its row. */
export const TURN_LIMIT_MS = 4 * 60_000;
/** Work after the answer (the turn's own after-steps) is waited for this long before the row is closed. */
const AFTER_LIMIT_MS = 60_000;
/** The Lab's row keeps this much of a node's output. */
const OUT_CHARS = 600;

let counter = 0;
/** An event id as the log wants it: `<13-digit ms>-<6 digits>`. */
export function eventId(at) {
  counter = (counter + 1) % 1_000_000;
  return `${String(at).padStart(13, "0")}-${String(counter).padStart(6, "0")}`;
}

/** A turn id as the log wants it. */
const turnId = () => `lab${[...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** A node's output as the Lab's row shows it: its JSON, cut. */
function outOf(value) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > OUT_CHARS ? `${text.slice(0, OUT_CHARS)}…` : text;
}

/** The steps a text's turn ran, from the node entries its ledger kept (`ledger.js` `nodeEntry`), in order. */
export function stepsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.kind === "step" && entry.step === "node" && typeof entry.name === "string")
    .map((entry) => ({ node: entry.name, out: outOf(entry.output), ms: Number.isFinite(entry.ms) ? entry.ms : 0, ok: entry.ok !== false }));
}

/**
 * The gate one test text's turn carries (`policy.js` `LAB_SANDBOX_KEY`). `about` is the test chat (`route.js` `open`):
 * `owner` the real object's owner name the test chat's ledger stands in for (`person:<id>` or `chat:<key>`), and
 * `ledgerChat` that ledger's chat. Every call goes to the test chat's object; `flush()` waits for the ones not awaited.
 */
export function sandboxGate(stub, about, rowId, { config = null } = {}) {
  const pending = [];
  const call = (op, fields) => callSandbox(stub, op, fields);
  const later = (work) => void pending.push(Promise.resolve(work).catch(() => {}));
  const ours = (obj) => typeof obj === "string" && typeof about?.owner === "string" && obj.endsWith(`#${about.owner}`);
  const ops = new Set();
  let lastNode = null;
  return {
    config,
    ops,
    record(write) {
      later(call("write.add", { write: { kind: String(write?.kind ?? "Other"), summary: String(write?.summary ?? "").slice(0, 200), ...(write?.tool ? { tool: write.tool } : {}), by: rowId, at: Date.now() } }));
    },
    saw(op) {
      ops.add(op);
    },
    async kvGet(obj, key) {
      return (await call("kv.get", { obj, key })).found ?? null;
    },
    async kvPut(obj, key, record) {
      await call("kv.put", { obj, key, ...record, by: rowId });
    },
    async kvList(obj, prefix) {
      return (await call("kv.list", { obj, prefix })).keys ?? [];
    },
    ledger(obj, chat) {
      if (!ours(obj) || chat !== about.ledgerChat) return null;
      return {
        read: (options) => call("ledger.read", { chat, options }),
        oldest: async () => (await call("ledger.oldest", { chat })).oldest ?? null,
        append: (entries) => call("ledger.append", { entries, by: rowId }),
      };
    },
    onNode(run) {
      if (typeof run?.node !== "string" || run.node === lastNode) return;
      lastNode = run.node;
      later(call("meta", { key: "running", value: { msgId: rowId, node: run.node, at: Date.now() } }));
    },
    flush: () => Promise.allSettled(pending.splice(0)),
  };
}

/**
 * The `/agent` body a real text would send (`apps/agent/src/clients.ts` `askAgent` for a 1:1, `groupModelTurn.ts` for a
 * group): the question, or `ask` (`inbound.js` `askOf`: a reply's `quoted`/`replied`, a tapback's `tapback`), the
 * pictures as `attachments`, a 1:1's noted tapbacks as `reacted`, and a group's chat lines (`chat`, each `{ who, text }`;
 * the rows' people when not given).
 */
export function turnBody({ about, text, ask = null, as, eid, turn, rows, chat = null, attachments = [], reacted = [] }) {
  const asked = ask ?? { question: text };
  const question = String(asked.question ?? "");
  const reply = { ...(asked.quoted ? { quoted: asked.quoted } : asked.replied ? { replied: true } : {}), ...(asked.quoted && asked.tapback ? { tapback: asked.tapback } : {}) };
  const files = attachments.length > 0 ? { attachments } : {};
  const base = { question, covers: [eid], chat: SANDBOX_EVENT_CHAT, turn, arrivedAt: Date.now(), ...(about.timeZone ? { timeZone: about.timeZone } : {}) };
  if (about.kind !== "group") return { ...base, conversation: "texts", ...files, ...reply, ...(reacted.length > 0 ? { reacted } : {}) };
  const handles = (about.people ?? []).map((person) => person.handle).filter((handle) => typeof handle === "string" && /^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(handle));
  const from = handles.includes(as) ? as : "";
  const lines = chat ?? (rows ?? []).filter((row) => row.who !== "Tex").slice(-30).map((row) => ({ who: row.who, text: String(row.text ?? "") }));
  const said = lines.map((line) => ({ from: handles.includes(line.who) ? line.who : "", text: line.text }));
  return {
    ...base,
    group: {
      key: about.chatKey,
      members: about.members,
      from,
      people: handles,
      ...(from === "" ? { guests: [String(as).slice(0, 40)], asker: String(as).slice(0, 40) } : {}),
      chat: said,
      tagged: /@tex\b/i.test(question),
    },
    ...files,
    ...reply,
  };
}

/** One row's whole `/agent` body: what it asks (`askOf`, pictures downloaded with `fetch`) in the shape `turnBody` gives. */
export async function turnRequestBody({ about, row, rows, turn, fetch, images }) {
  const { ask, attachments, reacted, chat } = await askOf({ about, row, rows, ...(fetch ? { fetch } : {}), images });
  return turnBody({ about, ask, as: row.who, eid: row.eid, turn, rows, chat: about.kind === "group" ? chat : null, attachments, reacted });
}

/** Tex's reply as the Worker logs it once sent; `eid` its event id, which a later reply or tapback names. */
export function replyEvent({ at, text, turn, covers, eid = eventId(at) }) {
  return eventEntry({ id: eid, at, chat: SANDBOX_EVENT_CHAT, kind: "text", from: { kind: "tex" }, text, turn, covers, delivered: true });
}

/** A promise that gives up after `ms`, answering `fallback`; its timer never outlives the work. */
function within(work, ms, fallback) {
  let timer;
  return Promise.race([work, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Runs one test text's turn and writes what it gave into the test chat. `payload` is the control plane's session for
 * the chat (`texLabSandbox.ts` `session`); `token` the caller's own, carried for the store's opens as a real turn
 * carries its own. Never throws: a turn that fails says so on its reply row.
 */
export async function runSandboxTurn({ env, stub, about, row, payload, token, config, origin }) {
  const gate = sandboxGate(stub, about, row.id, { config });
  const sandboxEnv = sandboxEnvOf(env, { gate, workspaces: sandboxNamespace(env.WORKSPACE_STORE, gate), tex: sandboxNamespace(env.TEX_STORE, gate) });
  const controlPlane = createControlPlane(sandboxEnv);
  const after = [];
  const ctx = { waitUntil: (work) => void after.push(Promise.resolve(work).catch(() => {})) };
  const turn = turnId();
  const started = Date.now();
  const replyId = `${row.id}r`;
  try {
    await callSandbox(stub, "meta", { key: "running", value: { msgId: row.id, node: null, at: started } });
    const session = sessionFromPayload(payload, null, token);
    Object.defineProperty(session, "labSandbox", { value: gate, enumerable: false });
    const state = await callSandbox(stub, "state", {});
    // The pictures are downloaded now, at answer time, as the Worker does (`reply.ts`), with the deployment's `IMAGES`.
    const body = await turnRequestBody({ about, row, rows: state.rows ?? [], turn, images: env.IMAGES });
    const request = new Request(`${origin}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const store = await storeForSession(session, sandboxEnv, controlPlane);
    decorateRequestStore(store, { session, env: sandboxEnv, controlPlane, ctx, request, origin });
    const openOnce = onceEach((target) => storeForSession(target, sandboxEnv, controlPlane));
    attachContextOpener(store, session, { env: sandboxEnv, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
    attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, sandboxEnv, controlPlane), (opened, sibling) => attachLinkCalls(opened, sibling, controlPlane, sandboxEnv));
    const response = await within(handleAgent(request, sandboxEnv, store, session, controlPlane), TURN_LIMIT_MS, null);
    if (response === null) throw new Error(`no answer in ${TURN_LIMIT_MS / 60_000} minutes`);
    const answer = await response.json().catch(() => ({}));
    await within(Promise.allSettled(after), AFTER_LIMIT_MS, null);
    await gate.flush();
    const text = typeof answer?.answer === "string" ? answer.answer : "";
    const quiet = answer?.quiet === true || text === "";
    const at = Date.now();
    const eid = eventId(at);
    if (!quiet) await callSandbox(stub, "ledger.append", { entries: [replyEvent({ at, text, turn, covers: [row.eid], eid })], by: row.id }).catch(() => {});
    const steps = stepsOf((await callSandbox(stub, "ledger.of", { by: row.id })).entries);
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text, at, prod: false, ...(quiet ? { quiet: true } : { eid }), ms: at - started, steps, ...(response.ok ? {} : { error: `the turn answered ${response.status}` }) } });
    console.log(JSON.stringify({ event: "lab_sandbox_turn", ok: response.ok, ms: at - started, steps: steps.length, quiet, ops: gate.ops.size }));
  } catch (error) {
    await gate.flush();
    const at = Date.now();
    const steps = await callSandbox(stub, "ledger.of", { by: row.id }).then((read) => stepsOf(read.entries)).catch(() => []);
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text: "", at, prod: false, quiet: true, ms: at - started, steps, error: String(error?.message ?? "the turn failed").slice(0, 200) } }).catch(() => {});
    console.log(JSON.stringify({ event: "lab_sandbox_turn", ok: false, ms: at - started, reason: String(error?.name ?? "error").slice(0, 40) }));
  } finally {
    await callSandbox(stub, "meta", { key: "running", value: null }).catch(() => {});
  }
}

