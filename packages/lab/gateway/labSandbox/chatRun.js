/**
 * ONE TEST TEXT, FROM "A TEXT ARRIVES" (Dev2, 2026-11-16: "just sent a test message in sandbox and expected it to go
 * through the "A text arrives" node end to end, but it looks like it skipped straight to front door"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * A test text is handed to the texting Worker's own chat object (`packages/tex/worker/chatObject.ts` `SenderInbox`, the
 * same class the gateway's TexChat runs), exactly as a real text is: its route takes it in (node `text`), asks Old
 * number? (`oldLine`), queues it, and its alarm runs Triage, Decide and the queue (`lanes`) before it asks the
 * gateway's `/agent` for the turn and sends what comes back. Nothing in that path is copied or skipped here; what
 * changes is only what the object reaches outside itself, all of it handed in as its `env`:
 *
 *  - its storage is in memory, kept in the test chat's object between texts (`chatObject` meta), never the real chat's;
 *  - the gateway it calls (`/agent`, `/agent/events`, the `TexTexts` routes) is this gateway's own handlers on the test
 *    chat's sandboxed env and session (`harness.js`), reached with a token minted for this one text and known only
 *    here; nothing else answers it;
 *  - the control plane it calls is answered here from what the control plane already told the Lab for this chat
 *    (`texLabSandbox.ts` `session`): a group's people and settings, the old-number setting, and a decide gate that is
 *    always open; anything that would change something there is refused and listed as a change it tried;
 *  - its line (sending, typing, read, tapbacks, members) is a line that keeps what Tex sent as the reply row, and texts
 *    nobody; its other objects (a job's, a chat's directory entry) are refused and listed;
 *  - it is never given the Worker's secret or a real token.
 *
 * The chat is addressed by made-up numbers (`addressOf`): a group's key and members, which the real chat's ledger and
 * home are found by, are the real ones, put back on the turn's body at the `/agent` hop.
 */

import { JOB_PART_END_PATH, handleJobPartEnd } from "../fromGateway/agent_jobPartEndRoute.js";
import { handleAgent } from "../fromGateway/agent_route.js";
import { TEXTING_ROUTES } from "../fromGateway/agent_textingRoutes.js";
import { streamTurn, wantsProgress } from "../fromGateway/agent_progress.js";
import { WORLD_SOURCE, worldAddress, worldControl, worldPayload } from "./world.js";
import { chatForTexts, decideForTexts, eventsForTexts, TEXTS_CHAT_PATH, TEXTS_DECIDE_PATH, TEXTS_EVENTS_PATH, TEXTS_RECHECK_PATH } from "../fromGateway/agent_textsDecide.js";
import { oldLineForTexts, TEXTS_OLD_LINE_PATH } from "../fromGateway/agent_textsOldLine.js";
import { editForTexts, TEXTS_EDIT_PATH } from "../fromGateway/agent_textsEdit.js";
import { gatewayGraph } from "../fromGateway/agent_graph_gatewayGraph.js";
import { TEX_CONFIG, withDraft } from "../fromGateway/agent_texConfig.js";
import { createControlPlane } from "../fromGateway/controlPlane.js";
import { attachContextOpener, onceEach } from "../fromGateway/http_contextOpener.js";
import { attachPinnedDoors } from "../fromGateway/http_pinnedDoors.js";
import { decorateRequestStore } from "../fromGateway/http_requestStore.js";
import { attachLinkCalls } from "../fromGateway/http_routing.js";
import { PINNED_CONTEXT_NAME } from "../fromGateway/orient_globalNote.js";
import { sessionFromPayload, storeForSession } from "../fromGateway/session.js";
import { callSandbox, SANDBOX_TTL_MS } from "./object.js";
import { sandboxEnvOf } from "../fromGateway/labSandbox_policy.js";
import { sandboxNamespace } from "./wire.js";
import { sandboxGate, stepsOf, TURN_LIMIT_MS } from "./harness.js";
import { attachmentsOf, pictureFetch } from "./inbound.js";
import { hold, lineOf, rowLine } from "./line.js";
import { boxNode, JOB_LIMIT_MS, runJobs, sandboxInboxes } from "./jobs.js";
import { boxStub, openRun } from "./jobBox.js";
import { assetId, assetUrl } from "../fromGateway/labSandbox_sandboxTools.js";
import { fitSteps } from "./steps.js";

/** The made-up addresses the chat object calls; no request to either leaves this file. */
export const LAB_GATEWAY = "https://lab-gateway.invalid";
export const LAB_CONTROL_PLANE = "https://lab-control-plane.invalid";
/** The secret the chat object signs control-plane calls with here: never the Worker's. */
export const LAB_WORKER_SECRET = "lab-sandbox-no-secret";
/**
 * Tex's line in a test chat when no line is named (tests), and the numbers its people text from: reserved fiction
 * numbers (555-01xx). A test text runs on its test chat's line (`line.js`), Tex's new Photon number.
 */
export const LAB_LINE = "+15555550100";
/** The chat object's storage is kept between texts up to this size; a bigger one starts the next text fresh. */
const KEEP_BYTES = 1_500_000;
/** Work after the answer (the object's own after-steps) is waited for this long. */
const AFTER_LIMIT_MS = 60_000;
/** An alarm further off than this is not this text's: it is kept for the next one. */
const ALARM_NEAR_MS = 30_000;
/** The worker's step names, by the config node each belongs to (`apps/mobile/.../stepLogs.ts` `STEP_ALIAS`). */
const WORKER_STEPS = new Set(["text", "oldLine", "triage", "decide", "recheck", "lane", "react", "send", "edit", "provisional"]);
const STEP_NODE = Object.freeze({ lane: "lanes", recheck: "decide", provisional: "fd" });

/** One of the chat object's own steps (`stepEvents.ts` `logStep`), whole, as the step book keeps it; null for another event. */
function workerStep(step) {
  if (!WORKER_STEPS.has(step?.name)) return null;
  return { node: STEP_NODE[step.name] ?? step.name, ...(step.input !== undefined ? { in: step.input } : {}), out: step.output ?? null, ms: Number.isFinite(step.ms) ? step.ms : 0, ok: step.ok !== false };
}

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A person's made-up number in a test chat, the same for the same name: +1 555 01xx, then digits from its hash. */
export async function phoneOf(who) {
  const hash = await sha256Hex(`lab-person:${String(who)}`);
  return `+1555${String(parseInt(hash.slice(0, 8), 16) % 10_000_000).padStart(7, "0")}`;
}

/** The test chat's addresses: Tex's line, the chat's id (a 1:1's) or group id, and each person's number by name. */
export async function addressOf(about, sandboxId) {
  const people = (about.people ?? []).map((p) => (typeof p.handle === "string" && p.handle !== "" ? p.handle : p.name)).filter((who) => typeof who === "string" && who !== "");
  const phones = new Map();
  for (const who of people) phones.set(who, await phoneOf(who));
  return { line: LAB_LINE, chatId: `lab:${sandboxId}`, groupId: `lab:${sandboxId}`, phones };
}

/** A Durable Object's storage, in memory, with its alarm: what the chat object reads and writes. */
export class MemoryStorage {
  /** `onEvent`: each chat event the object logs (`events.ts` `addEvent`), as it logs it. */
  constructor(entries = [], alarm = null, onEvent = null) {
    this.data = new Map(entries);
    this.alarm = alarm;
    this.onEvent = onEvent;
  }
  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))]));
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    if (typeof key === "object" && key !== null) for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
    if (this.onEvent !== null && typeof key === "string" && value?.e?.kind === "step") {
      try {
        this.onEvent(value.e);
      } catch {
        /* the Lab's view never stops the object */
      }
    }
  }
  async delete(key) {
    if (Array.isArray(key)) return key.reduce((n, k) => n + (this.data.delete(k) ? 1 : 0), 0);
    return this.data.delete(key);
  }
  async deleteAll() {
    this.data.clear();
  }
  async list(options = {}) {
    const prefix = options.prefix ?? "";
    let keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (options.reverse) keys = keys.reverse();
    if (Number.isInteger(options.limit)) keys = keys.slice(0, options.limit);
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key))]));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = typeof at === "number" ? at : new Date(at).getTime();
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  /** What is kept between texts: JSON, or null when it will not fit. */
  snapshot(upTo) {
    try {
      const text = JSON.stringify({ upTo, alarm: this.alarm, entries: [...this.data.entries()] });
      return text.length <= KEEP_BYTES ? text : null;
    } catch {
      return null;
    }
  }
  /** The storage kept after `upTo`, when that text is still in the test chat; else a fresh one. */
  static from(kept, rows, onEvent = null) {
    try {
      const parsed = typeof kept === "string" ? JSON.parse(kept) : null;
      if (parsed && Array.isArray(parsed.entries) && (rows ?? []).some((row) => row.id === parsed.upTo)) return new MemoryStorage(parsed.entries, parsed.alarm ?? null, onEvent);
    } catch {
      /* a fresh chat object */
    }
    return new MemoryStorage([], null, onEvent);
  }
}

/**
 * The steps a text ran, by node: the turn graph's node entries and the chat object's own steps, in the order logged.
 * The chat object hands its log on with the next turn, so a ledger can hold its steps for an earlier row (a tapback
 * only noted, an edit kept as it was): `own`, the steps this row's run saw the object log, replaces the ledger's; or,
 * without it, `since` drops the object's steps logged before this row came in.
 */
export function chatStepsOf(entries, { own = null, since = 0 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const nodes = stepsOf(list);
  const logged = list.filter((entry) => entry?.kind === "step" && WORKER_STEPS.has(entry.step) && (entry.at ?? 0) >= since);
  const worker = Array.isArray(own) ? own : logged.map((entry) => ({ at: entry.at ?? 0, step: workerStep({ name: entry.step, output: entry.output, ms: entry.ms, ok: entry.ok }) }));
  const graph = list.filter((entry) => entry?.kind === "step" && entry.step === "node" && typeof entry.name === "string").map((entry, i) => ({ at: entry.at ?? 0, step: nodes[i] }));
  // The Queue logs no step of its own: the turn's reply keeps the Worker's wait for it (`timing.waitMs`), the same
  // number Replay draws as the Queue's time (`measured.ts` `realTimes`). Placed just before the turn's first step.
  const queued = [];
  if (!worker.some(({ step }) => step?.node === "lanes")) {
    for (const reply of list.filter((entry) => entry?.kind === "reply" && Number.isFinite(entry.timing?.waitMs))) {
      const first = Math.min(...graph.map((g) => g.at), reply.at ?? 0);
      queued.push({ at: first - 0.5, step: { node: "lanes", out: { waitedMs: reply.timing.waitMs, from: "the turn's logged wait" }, ms: reply.timing.waitMs, ok: true } });
    }
  }
  return [...worker, ...queued, ...graph].sort((a, b) => a.at - b.at).map(({ step }) => step);
}

/**
 * A line that keeps what Tex sends and texts nobody: `sent` holds each text, `calls` every method asked. `onText(text)`
 * is told each text as Text them hands it over (the test chat's line holds it, `line.js`); `onPicture(picture)` keeps a
 * picture Tex sends in the test chat and answers its address there.
 */
export function keepingLine(phones, prefix = "lab", { onText = null, onPicture = null } = {}) {
  const sent = [];
  const calls = [];
  let n = 0;
  const handle = () => `${prefix}-sent-${(n += 1)}`;
  const answer = async (method, args) => {
    calls.push(method);
    if (method === "sendText") {
      const text = args.find((a) => typeof a === "string") ?? "";
      sent.push({ text, at: Date.now() });
      if (onText !== null) onText(text);
      return handle();
    }
    if (method === "sendMedia" || method === "sendCarousel" || method === "sendAppCard") {
      sent.push({ text: "", media: true, at: Date.now() });
      return null;
    }
    if (method === "readMembers") return [...phones.values()];
    if (method === "readOwnMessage") return null;
    if (method === "shareContactCard") return false;
    if (method === "uploadPicture") {
      const url = onPicture !== null ? await onPicture(args[0]).catch(() => null) : null;
      return { url: url ?? "https://lab-sandbox.invalid/picture" };
    }
    return null;
  };
  const rpc = {
    lineCall: async ({ method, args }) => ({ ok: true, value: await answer(method, args ?? []) }),
    groupLineCall: async ({ method, args }) => ({ ok: true, value: await answer(method, (args ?? []).slice(1)) }),
  };
  return { rpc, sent, calls };
}

/**
 * The control plane as the chat object asks it, answered from what the Lab already read for this chat (`chat`, from
 * `texLabSandbox.ts` `session`). Reads answer; a change is refused and listed (`gate.record`).
 */
export function controlPlaneSwitch({ about, chat, phones, gate, token, storage = null, world = null }) {
  // Muted in this test chat (a turn's `chat_mute`, or "Tex, stop"): the chat object's own mark (`groupChat.ts` `gmuted`),
  // so the control plane answers as it would for a muted chat, and "Tex, start" starts it again.
  const muted = async () => storage !== null && (await storage.get("gmuted")) === true;
  const names = (about.people ?? []).flatMap((p) => (typeof p.handle === "string" && /^[a-z0-9][a-z0-9-]{0,64}$/.test(p.handle) && phones.has(p.handle) ? [{ phone: phones.get(p.handle), handle: p.handle, ...(p.name && p.name !== "You" ? { name: p.name } : {}) }] : []));
  const guests = [...phones.entries()].filter(([who]) => !names.some((n) => n.handle === who)).map(([, phone], i) => ({ phone, label: `guest-${(4096 + i).toString(16).slice(-4)}` }));
  return async (path, body) => {
    // A made-up group chat (`world.js`): its group questions are the preview's real control plane's to answer.
    const real = world === null ? undefined : await world(path, body);
    if (real !== undefined) return real;
    switch (path) {
      case "/agent-texts/session":
        return { status: "linked", accessToken: token, ...(about.timeZone ? { timeZone: about.timeZone } : {}) };
      case "/agent-texts/group": {
        if (body?.command?.kind === "stop" || body?.command?.kind === "start") {
          gate.record({ kind: "Setting", summary: body.command.kind === "stop" ? "muted Tex in this test chat" : "started Tex again in this test chat" });
          return { status: body.command.kind === "stop" ? "stopped" : "started" };
        }
        if (body?.command !== undefined) {
          gate.record({ kind: "Settings", summary: `asked the control plane to ${String(body.command?.kind ?? "change the chat")}` });
          return { status: "refused" };
        }
        if (about.kind === "group" && (await muted())) return { status: "muted" };
        const handle = names.find((n) => n.phone === body?.sender)?.handle;
        return {
          status: "ready",
          slug: chat?.slug ?? "lab",
          intro: false,
          ...(about.timeZone ? { timeZone: about.timeZone } : {}),
          ...(handle ? { handle } : {}),
          accessToken: token,
          names,
          guests,
          // How Tex acts in this chat, as the control plane's row says (`textGroups.ts` `engagementOf`).
          ...(chat?.engagement ? { engagement: chat.engagement } : {}),
          ...(chat?.engagementChosen === true ? { engagementChosen: true } : {}),
          ...(chat?.instructions ? { instructions: chat.instructions } : {}),
          ...(chat?.updates ? { updates: chat.updates } : {}),
          // Whether the chat is shared with the developers, as the control plane reads it (`lib/texLabShared.ts` `devShareOf`).
          ...(chat?.devShare ? { devShare: chat.devShare } : {}),
        };
      }
      case "/agent-texts/decide/gate":
        return { ok: true, remaining: 1000 };
      case "/agent-texts/decide/usage":
        return { ok: true };
      case "/agent-texts/old-line":
        return chat?.oldLine ?? { mode: "off" };
      case "/agent-texts/phones":
        return { phones: [] };
      default:
        gate.record({ kind: "Other", summary: `asked the control plane ${path}` });
        return null;
    }
  };
}

/**
 * Everything one test text's chat object runs on. `agent` and `texts` answer the gateway's routes; tests hand in fakes.
 * `inboxes` is the objects it reaches (`jobs.js` `sandboxInboxes`: its own jobs); without it, every other object refuses.
 */
export function chatEnvFor({ gate, storage, about, chat, phones, line, token, agent, texts, images, inboxes = null, world = null }) {
  const control = controlPlaneSwitch({ about, chat, phones, gate, token, storage, world });
  const pictures = new Set((chat?.pictures ?? []).map(String));
  const download = pictureFetch((...a) => globalThis.fetch(...a));
  const fetchOut = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === LAB_GATEWAY) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      return await agent(url.pathname === "/agent" ? await atRealChat(request, about) : request, url.pathname);
    }
    if (url.origin === LAB_CONTROL_PLANE) {
      const body = await request.json().catch(() => ({}));
      const answer = await control(url.pathname, body);
      return answer === null ? Response.json({ error: "not_in_lab" }, { status: 403 }) : Response.json(answer);
    }
    // A picture the test text was sent with, downloaded as the Lab downloads one (a plain https name, every redirect
    // checked again, cut at 5 MB: `inbound.js` `pictureFetch`); nothing else goes out.
    if (request.method === "GET" && pictures.has(request.url)) return await download(request.url, { signal: request.signal });
    gate.record({ kind: "Other", summary: `tried to reach ${url.hostname}` });
    return Response.json({ error: "not_in_lab" }, { status: 403 });
  };
  const objects = {
    idFromName: (name) => ({ name, toString: () => "" }),
    idFromString: () => {
      throw new TypeError("a test chat reaches no other object");
    },
    get: (id) => ({
      fetch: async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        if (path === "/chat-where") return Response.json({ ok: true });
        gate.record({ kind: "Job", summary: `asked another object ${path}` });
        return new Response(null, { status: 503 });
      },
    }),
  };
  return {
    FETCH: fetchOut,
    // The draft's wiring, for what the chat object reads itself (a Provisional run, `packages/tex/worker/provisional.ts`).
    ...(gate.config ? { TEX_GRAPH: withDraft(TEX_CONFIG, gate.config) } : {}),
    GATEWAY_ORIGIN: LAB_GATEWAY,
    GATEWAY_TEXTS: { fetch: (input, init) => texts(new Request(input, init)) },
    CONTROL_PLANE_ORIGIN: LAB_CONTROL_PLANE,
    AGENT_WORKER_SECRET: LAB_WORKER_SECRET,
    SENDER_INBOX: inboxes ?? objects,
    TEX_LINE: line,
    IMAGES: images,
    LINQ_API_KEY: "",
  };
}

/** A turn's body with a group's made-up key and members put back to the real chat's, which its ledger and home are found by. */
async function atRealChat(request, about) {
  // A made-up chat is its own real chat on the preview: its key and members are the ones the chat object worked out.
  if (about.kind !== "group" || about.source === WORLD_SOURCE) return request;
  const body = await request.json().catch(() => null);
  if (body === null || typeof body.group !== "object" || body.group === null) return new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
  const group = { ...body.group, key: about.chatKey, members: about.members };
  return new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...body, group }) });
}

/** Messages' six tapbacks, by the emoji the Lab sends, as the Worker names them (`reactions.ts` `Tapback`). */
const TAPBACKS = Object.freeze({ "❤️": "Loved", "👍": "Liked", "👎": "Disliked", "😂": "Laughed at", "‼️": "Emphasized", "❓": "Questioned" });
/** The most words of the text a tapback is on that the line carries (`gatewayInbound.js` `MAX_QUOTED_TEXT`). */
const MAX_QUOTED = 3_000;

/** The words a text says now: its latest edit's, else its own; `skip` (the edit being sent) left out. */
export function wordsNow(rows, row, skip = null) {
  let words = String(row.text ?? "");
  for (const r of rows ?? []) if (r.id !== skip && r.kind === "edit" && r.on === row.id && typeof r.text === "string") words = r.text;
  return words;
}

/**
 * A test row as Tex's line hands it to the chat object (`photonEvents.ts`, `photonInbound.ts`), and the object's route:
 * a text to `/accept` or `/group-accept`; a tapback to `/react` in a 1:1, or to `/group-accept` as a group message
 * carrying `reaction`; an edit or an unsend to `/edit`. A tapback is on Tex's text (its words, `onTex`) or on another's
 * (`onOther`), as Photon's `targetFromMe` says. An edit names the text by the id the object took it under.
 */
export function inboundOf({ about, row, rows, address, sentHandles }) {
  const from = address.phones.get(row.who) ?? address.phones.values().next().value ?? "+15555550101";
  const group = about.kind === "group";
  const participants = [...address.phones.values()];
  const people = participants.includes(from) ? participants : [...participants, from];
  const eventId = `lab:${row.id}`;
  const target = typeof row.on === "string" ? (rows ?? []).find((r) => r.id === row.on) : undefined;
  if (row.kind === "reaction") {
    const onTex = target !== undefined && (target.who === "Tex" || target.reply !== undefined);
    const reaction = { how: TAPBACKS[row.emoji] ?? "Liked", ...(onTex ? { words: String(target.text ?? "").trim().slice(0, MAX_QUOTED), onTex: true } : { words: "", onOther: true, ...(target !== undefined && String(target.text ?? "").trim() !== "" ? { otherWords: String(target.text).trim().slice(0, MAX_QUOTED) } : {}) }) };
    if (!group) return { path: "/react", body: { kind: "reaction", eventId, chatId: address.chatId, from, messageId: eventId, reaction } };
    return { path: "/group-accept", body: { kind: "group-message", eventId, groupId: address.groupId, line: address.line, from, participants: people, messageId: eventId, text: "", reaction } };
  }
  if (row.kind === "edit" || row.kind === "unsend") {
    const where = group ? { groupId: address.groupId, participants: people } : { chatId: address.chatId };
    const before = target ? wordsNow(rows, target, row.id) : "";
    const words = row.kind === "edit" ? { text: String(row.text ?? ""), ...(before !== "" ? { previous: before } : {}) } : {};
    return { path: "/edit", body: { kind: row.kind === "edit" ? "edited" : "unsent", eventId, ...where, line: address.line, from, messageId: target?.id ?? String(row.on ?? ""), ...words, at: new Date(row.at ?? Date.now()).toISOString() } };
  }
  const attachments = attachmentsOf(row);
  const replied = typeof row.replyTo === "string" ? (rows ?? []).find((r) => r.id === row.replyTo) : undefined;
  const files = attachments.length > 0 ? { attachments } : {};
  if (!group) {
    const reply = replied ? { ...(replied.text ? { quoted: String(replied.text) } : {}), threaded: true } : {};
    return { path: "/accept", body: { kind: "message", eventId, chatId: address.chatId, from, messageId: row.id, text: String(row.text ?? ""), ...files, ...reply } };
  }
  const replyTo = replied ? (sentHandles.get(replied.id) ?? replied.id) : undefined;
  return { path: "/group-accept", body: { kind: "group-message", eventId, groupId: address.groupId, line: address.line, from, participants: people, messageId: row.id, text: String(row.text ?? ""), ...files, ...(replyTo ? { replyTo } : {}) } };
}


/** Picture types a test chat keeps and serves (`pages.js`): never one that can carry a script. */
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Runs one test text through the chat object, and writes what Tex sent into the test chat (Dev2, 2026-11-16: "the
 * sandbox should act like an actual chat"). The text is held for the line's delay in (`lineIn`) before the chat
 * object takes it; each text Tex sends is held for the line's delay out (`lineOut`) before it shows as delivered; a job
 * the turn started runs after it (`jobs.js`), its texts each a Tex row `from: "job"`. Every step is kept as it runs
 * (`steps.js`), and each Tex row names its `cause`. `chat` is the control plane's view of the chat; `inbound(address)`
 * is what another chat's object hands this one (`/cross-ask`, `/cross-answer`) in place of a text over the line
 * (`crossRuns.js`); `sleep` and `now` only for tests. Never throws; answers `{ cross }`, what its turns sent another chat.
 */
export async function runChatTurn({ env, stub, about, row, payload, token, config, origin, chat = null, inbound = null, agentRoute = null, textsRoute = null, now = Date.now, sleep = hold, jobLimitMs = JOB_LIMIT_MS, sandbox = null }) {
  const line = lineOf(about);
  const gate = sandboxGate(stub, about, row.id, { config, arrivedAt: row.at ?? now(), now });
  // The group chats a 1:1 test turn may read, as the control plane listed them for this chat (`texLabSandbox.ts`):
  // a shared 1:1's are only the groups its person shared too, and a group's own turn never asks (`groupChats.js`).
  gate.groups = Array.isArray(chat?.groups) ? chat.groups : null;
  // A chat shared with the developers runs with none of its person's notes (Dev2, 2026-11-17): their workspace's key is
  // handed only to its members, and the developer testing is not one (`policy.js` `NO_NOTES_BINDING`).
  gate.noNotes = about?.shared === true;
  const { book } = gate;
  const onEvent = (event) => {
    const step = workerStep(event.step);
    if (step !== null) gate.worker(step, Number.isFinite(event.at) ? event.at : now());
  };
  const sandboxEnv = sandboxEnvOf(env, { gate, workspaces: sandboxNamespace(env.WORKSPACE_STORE, gate), tex: sandboxNamespace(env.TEX_STORE, gate) });
  const controlPlane = createControlPlane(sandboxEnv);
  const after = [];
  const ctx = { waitUntil: (work) => void after.push(Promise.resolve(work).catch(() => {})), passThroughOnException() {} };
  const started = now();
  const replyId = `${row.id}r`;
  const labToken = `lab_${randomHex(24)}`;
  // Each text Tex hands the line: `from` the node that sent it ("fd" for the turn's answer, "job" for a job's), its
  // `lineOut` step, and when it shows as delivered. A job's text is its own row the moment it is delivered.
  const phase = { from: "fd" };
  const delivered = [];
  let jobRows = 0;
  const posted = [];
  const onText = (text) => {
    const from = phase.from;
    const out = book.line("lineOut", { line: line.name, to: about.kind === "group" ? "the group" : "them", chars: text.length }, book.deliverer() ?? book.tail);
    const done = sleep(line.outMs).then(() => {
      book.end(out, { out: { delivered: true, line: line.name, number: line.number }, ms: line.outMs });
      return { text, from, step: out, at: now() };
    });
    delivered.push(done);
    if (from === "job" && text !== "") {
      posted.push(done.then(async (d) => {
        jobRows += 1;
        const cause = book.causeOf(d.step);
        await callSandbox(stub, "row.add", { row: { id: `${row.id}j${jobRows}`, reply: row.id, who: "Tex", text, at: d.at, prod: false, from: "job", line: rowLine(line, { out: true }), cause, ms: d.at - started, steps: fitSteps(book.pick(cause)) } });
      }).catch(() => {}));
    }
  };
  const onPicture = async (picture) => {
    const type = String(picture?.mediaType ?? "").toLowerCase();
    if (!PICTURE_TYPES.has(type) || typeof picture?.data !== "string") return null;
    const id = assetId();
    const url = assetUrl(about, id);
    if (url === null) return null;
    await callSandbox(stub, "asset.put", { id, kind: "picture", title: String(picture.title ?? picture.name ?? "picture").slice(0, 200), type, body: picture.data, by: row.id });
    await gate.write({ kind: "picture", title: String(picture.title ?? picture.name ?? "picture"), url, expires: now() + SANDBOX_TTL_MS });
    return url;
  };
  // What this text's turns sent another chat (`jobs.js` `crossOut`), handed back for the route to carry (`crossRuns.js`).
  let crossOut = [];
  // The run a job box reaches this text's fences through (`jobBox.js`): only where the gateway has job boxes, and only
  // for a text its test chat's own object runs (`sandbox`, that object's name, which the box calls back).
  const live = env?.LAB_JOB !== undefined && typeof sandbox === "string" ? openRun({ setup: null, env: null, namespace: null, node: null }) : null;
  try {
    await callSandbox(stub, "beat", { msgId: row.id, node: inbound === null ? "lineIn" : "text", steps: [] });
    // The line: the text reaches the chat object after the line's delay in, as a Photon text reaches the Worker.
    // Its hold counts from when the text was sent (`row.at`), as a provider's lag does: what the route spent is part of it.
    // A run another chat started (`inbound`, `crossRuns.js`) comes from that chat's object, never over the line.
    if (inbound === null) {
      const sentAt = row.at ?? started;
      const lineIn = book.line("lineIn", { line: line.name, number: line.number, from: row.who, holdMs: line.inMs }, null, sentAt);
      await sleep(Math.max(0, line.inMs - (now() - sentAt)));
      book.end(lineIn, { out: { arrived: true, line: line.name, number: line.number }, ms: Math.max(line.inMs, now() - sentAt) });
    }
    const state = await callSandbox(stub, "state", {});
    // Reset while the line held the text: the test chat is gone, and the turn never starts.
    if (!state.meta?.chat) throw new Error("the test chat was reset");
    const rows = state.rows ?? [];
    const sandboxId = String(about.sandboxId ?? state.meta?.sandboxId ?? row.id).slice(0, 40);
    const isWorld = about.source === WORLD_SOURCE;
    const address = isWorld ? worldAddress(about, line.number) : { ...(await addressOf(about, sandboxId)), line: line.number };
    const grant = { token: null, payload: null, last: null }; // a made-up chat's, minted by the preview's control plane
    // Anyone a group's text is written as has a number of their own there: a name nobody in the chat has is a guest's.
    if (about.kind === "group" && !isWorld && inbound === null && typeof row.who === "string" && !address.phones.has(row.who)) address.phones.set(row.who, await phoneOf(row.who));
    const storage = MemoryStorage.from(state.meta?.chatObject, rows, onEvent);
    const fresh = storage.data.size === 0;
    const kept = keepingLine(address.phones, row.id, { onText, onPicture });
    // The chat's session and store, opened when the chat object first reaches the gateway, as a real text's are.
    let opened = null;
    const storeOf = () =>
      (opened ??= (async () => {
        const session = isWorld ? sessionFromPayload(await worldPayload(env, grant), null, grant.token) : sessionFromPayload(payload, null, token);
        Object.defineProperty(session, "labSandbox", { value: gate, enumerable: false });
        const store = await storeForSession(session, sandboxEnv, controlPlane);
        const request = new Request(`${origin}/agent`, { method: "POST" });
        decorateRequestStore(store, { session, env: sandboxEnv, controlPlane, ctx, request, origin });
        const openOnce = onceEach((target) => storeForSession(target, sandboxEnv, controlPlane));
        attachContextOpener(store, session, { env: sandboxEnv, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
        attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, sandboxEnv, controlPlane), (o, sibling) => attachLinkCalls(o, sibling, controlPlane, sandboxEnv));
        return { store, session };
      })());
    const agent = agentRoute ?? gatewayRoutes({ storeOf, sandboxEnv, controlPlane, ctx, gate });
    const routes = textsRoute ?? textsRoutes({ about, sandboxEnv, ctx, gate });
    // The chat's session is this text's own token, whoever answers the other routes.
    const linked = { status: "linked", accessToken: labToken, ...(about.timeZone ? { timeZone: about.timeZone } : {}), ...(payload?.defaultWorkspaceId ? { personalWorkspaceId: payload.defaultWorkspaceId } : {}) };
    // A test chat's jobs are its own objects (`jobs.js`), never the gateway's job home: a 501 sends the chat to them
    // (`packages/tex/worker/jobObject.ts`), whoever answers the other routes.
    const texts = (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/texts/session") return Response.json(linked);
      if (path.startsWith("/texts/job-call/")) return Response.json({ error: "no_job_home" }, { status: 501 });
      return routes(request);
    };
    const { SenderInbox, remoteLine, remoteGroupLine, setChatBound } = await import("../../../tex/worker/gatewayChat.js");
    const inboxName = about.kind === "group" ? `group:${address.groupId}` : address.phones.values().next().value ?? "lab";
    const chatLine = { line: (chatId) => remoteLine(kept.rpc, inboxName, chatId), groupLine: (groupId) => remoteGroupLine(kept.rpc, inboxName, groupId) };
    const work = [];
    const objectState = (store, id) => ({ storage: store, id: { toString: () => id }, waitUntil: (p) => void work.push(Promise.resolve(p).catch(() => {})), blockConcurrencyWhile: (run) => run() });
    // The objects the chat object reaches: itself, for a job's report, and the jobs it starts, each on storage in memory.
    let envOf = null;
    const registry = sandboxInboxes({
      gate,
      makeJob: (name) => {
        const jobStorage = new MemoryStorage([], null, onEvent);
        return { storage: jobStorage, inbox: new SenderInbox(objectState(jobStorage, `lab-${sandboxId}-${name}`), envOf) };
      },
      parentOfJob: () => book.last("fd") ?? book.tail,
      makeBox: live === null ? null : (name) => boxStub(env.LAB_JOB, { sandbox, rowId: row.id, jobName: name, run: live.key }),
    });
    envOf = chatEnvFor({ gate, storage, about, chat: { ...(chat ?? {}), pictures: (row.pics ?? []).map((p) => p.url) }, phones: address.phones, line: chatLine, token: labToken, agent, texts, images: env.IMAGES, inboxes: registry.namespace, world: isWorld ? worldControl(env, grant, labToken) : null });
    if (live !== null) {
      Object.assign(live.entry, {
        setup: { config: config ?? null, gateway: LAB_GATEWAY, controlPlane: LAB_CONTROL_PLANE, secret: LAB_WORKER_SECRET },
        env: envOf,
        namespace: registry.namespace,
        node: (phase, run) => boxNode({ phase, run, registry, gate, book }),
      });
    }
    const inbox = new SenderInbox(objectState(storage, `lab-${sandboxId}`), envOf);
    registry.chat = inbox;
    crossOut = registry.crossOut;
    if (about.kind !== "group") await storage.put("texts:workspace", payload?.defaultWorkspaceId ?? "");
    const sentHandles = new Map(Object.entries(state.meta?.sentHandles ?? {}));
    // `inbound(address)`: what another chat's object hands this one (`/cross-ask`, `/cross-answer`), in place of a text.
    const { path, body: message } = inbound === null ? inboundOf({ about, row, rows, address, sentHandles }) : inbound(address);
    // A test chat is one Tex already answers in (its grant is what the Lab opened it with): its object starts set up for
    // the people here, as the real chat's is after Tex's first turn there (`groupChat.ts` `setChatBound`).
    if (about.kind === "group" && fresh && (!isWorld || about.world?.introduced === true)) await setChatBound(storage, { kind: "group-message", groupId: address.groupId, line: address.line, from: message.from ?? message.asker, participants: message.participants ?? [...address.phones.values()], messageId: row.id, text: "" });
    // Its provider is the line's: the lag the `text` step shows is the line's hold.
    const provider = { name: line.name === "photon" ? "photon" : "lab", providerAt: row.at ?? started, receivedAt: now() };
    const accepted = await inbox.fetch(new Request(`https://inbox${path}`, { method: "POST", body: JSON.stringify(inbound === null ? { ...message, provider } : message) }));
    const outcome = (await accepted.json().catch(() => ({}))).outcome ?? `status ${accepted.status}`;
    // A burst (`send`'s `also`): the texts right behind this one reach the object before it looks at any.
    if (inbound === null) {
      const fresh = (await callSandbox(stub, "state", {})).rows ?? rows;
      for (const id of Array.isArray(row.also) ? row.also : []) {
        const next = fresh.find((r) => r.id === id);
        if (next === undefined) continue;
        // Their number first, so the text is from them and not from whoever sent the first one.
        if (about.kind === "group" && typeof next.who === "string" && !address.phones.has(next.who)) address.phones.set(next.who, await phoneOf(next.who));
        const { path: nextPath, body: nextMessage } = inboundOf({ about, row: next, rows: fresh, address, sentHandles });
        await inbox.fetch(new Request(`https://inbox${nextPath}`, { method: "POST", body: JSON.stringify({ ...nextMessage, provider: { ...provider, providerAt: next.at ?? provider.providerAt, receivedAt: now() } }) }));
      }
    }
    const deadline = started + TURN_LIMIT_MS;
    await drainChat(inbox, storage, work, deadline, now);
    await within(Promise.allSettled(after.splice(0)), AFTER_LIMIT_MS);
    // The turn's texts, each once its line delivered it: one reply row, as before, now with its line and its cause.
    const answered = await Promise.all(delivered.splice(0));
    const said = answered.map((d) => d.text).filter((text) => text !== "");
    const at = answered.length > 0 ? Math.max(...answered.map((d) => d.at)) : now();
    const text = said.join("\n\n");
    const quiet = said.length === 0;
    const cause = [...new Set(answered.filter((d) => d.text !== "").flatMap((d) => book.causeOf(d.step)))];
    const ordered = book.view().filter((step) => cause.includes(step.id)).map((step) => step.id);
    await gate.flush();
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text, at, prod: false, from: "fd", line: rowLine(line, { out: true }), ...(quiet ? { quiet: true, note: `The chat object took the text (${outcome}) and Tex sent nothing.` } : { cause: ordered }), ...(said.length > 1 ? { parts: said } : {}), ...(grant.last !== null ? { group: grant.last } : {}), ms: at - started, steps: fitSteps(book.view()) } });
    // Each job the turn started runs now, on the same fences; its texts post as they are delivered.
    if (registry.jobs.size > 0) {
      phase.from = "job";
      await runJobs({ registry, gate, book, config, now, sleep, limitMs: jobLimitMs, drain: () => drainChat(inbox, storage, work, now() + TURN_LIMIT_MS, now).then(() => within(Promise.allSettled(after.splice(0)), AFTER_LIMIT_MS)) });
      await Promise.all(delivered.splice(0));
      await Promise.all(posted.splice(0));
      await gate.flush();
      await callSandbox(stub, "row.patch", { id: replyId, patch: { steps: fitSteps(book.view()) } });
    }
    await callSandbox(stub, "meta", { key: "chatObject", value: storage.snapshot(row.id) });
    const handles = Object.fromEntries([...sentHandles.entries()].slice(-200));
    if (!quiet) handles[replyId] = `${row.id}-sent-${said.length}`;
    await callSandbox(stub, "meta", { key: "sentHandles", value: handles });
    console.log(JSON.stringify({ event: "lab_sandbox_chat_turn", ok: true, cross: registry.crossOut.length, ms: now() - started, steps: book.view().length, quiet, jobs: registry.jobs.size, jobTexts: jobRows, outcome: String(outcome).slice(0, 20), lineCalls: kept.calls.length }));
  } catch (error) {
    await gate.flush();
    const at = now();
    const steps = fitSteps(book.view());
    await callSandbox(stub, "row.add", { row: { id: replyId, reply: row.id, who: "Tex", text: "", at, prod: false, from: "fd", quiet: true, ms: at - started, steps, error: String(error?.message ?? "the turn failed").slice(0, 200) } }).catch(() =>
      callSandbox(stub, "row.patch", { id: replyId, patch: { steps, error: String(error?.message ?? "the turn failed").slice(0, 200) } }).catch(() => {}),
    );
    console.log(JSON.stringify({ event: "lab_sandbox_chat_turn", ok: false, ms: at - started, reason: String(error?.name ?? "error").slice(0, 40) }));
  } finally {
    // A box still calling after this is answered "gone", and deletes itself (`jobBox.js`).
    live?.close();
    await gate.flush();
    // Only this text's own mark: a turn that outlived its mark never frees another text's.
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
  }
  return { cross: crossOut };
}

/** The chat object's alarm, run as Cloudflare runs it, until nothing near is left to run, never past the deadline. */
async function drainChat(inbox, storage, work, deadline, now) {
  while (storage.alarm !== null && now() < deadline) {
    const wait = storage.alarm - now();
    if (wait > ALARM_NEAR_MS) break;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1_000)));
    if (storage.alarm !== null && storage.alarm <= now()) {
      storage.alarm = null;
      await inbox.alarm();
      await settle(work, deadline, now);
    }
  }
  await settle(work, deadline, now);
}

/** Waits for the object's handed-on work, as Cloudflare keeps an object alive for it, never past the deadline. */
async function settle(work, deadline, now) {
  while (work.length > 0 && now() < deadline) await within(Promise.allSettled(work.splice(0)), Math.max(0, deadline - now()));
}

function within(work, ms) {
  let timer;
  return Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}

/**
 * The gateway's routes the chat object calls, as `http/route.js` answers them, on the test chat's session and store:
 * `/agent` (a group's real key and members put back on its body), and the texting routes (`/agent/events` and the
 * rest). Anything else is refused and listed.
 */
export function gatewayRoutes({ storeOf, sandboxEnv, controlPlane, ctx, gate, handle = handleAgent }) {
  return async (request, path) => {
    const { store, session } = await storeOf();
    if (path === "/agent") {
      const turn = request;
      if (!wantsProgress(turn)) return await handle(turn, sandboxEnv, store, session, controlPlane);
      return streamTurn((progress, step, answered, live) => handle(turn, sandboxEnv, store, session, controlPlane, { progress, step, answered, live }), { waitUntil: (work) => ctx.waitUntil(work) });
    }
    if (TEXTING_ROUTES.has(path)) return await TEXTING_ROUTES.get(path)(request, store, session);
    // What follows a job's part: the Part end node on the test chat's draft, logged to the test chat (`jobPartEndRoute.js`).
    if (path === JOB_PART_END_PATH) return await handleJobPartEnd(request, sandboxEnv, store, session);
    gate.record({ kind: "Other", summary: `asked the gateway ${path}` });
    return Response.json({ error: "not_in_lab" }, { status: 403 });
  };
}

/**
 * The `TexTexts` routes the chat object calls (`index.js`), on the test chat's env: Decide and the last look, the old
 * number, and the chat's events and day, which reach the test chat's own ledger whatever key the made-up chat has.
 */
function textsRoutes({ about, sandboxEnv, ctx, gate }) {
  // A group's ledger is found by its key; the made-up chat's key is put back to the real chat's. A 1:1 names none.
  const atLedger = async (request) => {
    const body = await request.json().catch(() => ({}));
    const ledger = about.kind === "group" && typeof body?.ledger === "string" ? { ledger: about.chatKey } : {};
    return new Request(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...ledger }) });
  };
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === TEXTS_DECIDE_PATH || path === TEXTS_RECHECK_PATH) return await decideForTexts(await atLedger(request), sandboxEnv, { waitUntil: (work) => ctx.waitUntil(work) });
    if (path === TEXTS_CHAT_PATH) return await chatForTexts(await atLedger(request), sandboxEnv);
    if (path === TEXTS_EVENTS_PATH) return await eventsForTexts(await atLedger(request), sandboxEnv);
    if (path === TEXTS_OLD_LINE_PATH) return await oldLineForTexts(request);
    // Node `edit` on the test chat's draft, as `/texts/edit` runs it on main's (`textsEdit.js`).
    if (path === TEXTS_EDIT_PATH) return await editForTexts(request, { graph: gatewayGraph({ config: gate.config ? withDraft(TEX_CONFIG, gate.config) : TEX_CONFIG }) });
    gate.record({ kind: "Other", summary: `asked the gateway ${path}` });
    return Response.json({ error: "not_in_lab" }, { status: 403 });
  };
}

/**
 * A test row's turn, as production runs it: a text, a tapback, an edit or an unsend, each into the chat object as Tex's
 * line hands it over (Dev2's coordinator, 2026-11-16: tapbacks, edits and unsends "the same shadow-path problem").
 */
export function runTestText(args) {
  return runChatTurn(args);
}
/** The chat object logs every row's event itself (`inboxTurn.ts` `logInbound`, `editStep.ts`): the route leaves it to it. */
runTestText.logsText = () => true;
