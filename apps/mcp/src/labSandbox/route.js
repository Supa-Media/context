/**
 * `POST /tex-lab/sandbox`: THE LAB'S TEST CHATS (Dev2, 2026-11-16: "I should be able to use maya, or my users existing
 * 1:1 or group chats, and send test messages to see how the new architecture responds, I should be able to write as
 * anyone in the group, delete some test messages and retry"; plan `tex-lab-run/plan.md` piece 3; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * One JSON body `{ op, ... }`, the caller's own grant as the bearer (the Lab's console grant, or an AI client's for
 * `tex_dev`). The control plane says who the caller is and refuses anyone who is not a Tex developer
 * (`apps/convex/functions/texLabSandbox.ts`); every test chat is the caller's own object, named by their id, so one
 * person never reaches another's.
 *
 *  - `chats` → `{ chats: [{ chatId, name, kind: "1:1" | "group", people }] }`: their 1:1 (`me`) and each group chat
 *    they are in, with how many people it holds besides Tex.
 *  - `sets` → `{ sets: [{ id, title, set: "training" | "dev", kind, people, texts }] }`: the Training and Dev
 *    conversations a test chat can start from, the Lab's drafts over the repo's copy. Never the Test Set.
 *  - `shared` and `ledger { chatId, ... }`: the chats people shared with the developers and their history files, read
 *    only (`shared.js`); `open { source: "shared", chatId }` opens a test chat over one, run as its person.
 *  - `open { source: "chat" | "set" | "maya" | "shared", chatId?, convId?, versionId?, base? }` → `{ sandboxId, people, rows }`:
 *    a real chat's texts so far (up to `base`, which is left out), or a Training or Dev conversation's (never the Test
 *    Set's), as the test chat's start; `maya` is the bench's Maya conversation.
 *  - `send { sandboxId, as?, text, pics?, replyTo? }` → `{ msgId }`: the text, as `as`, with up to 6 pictures
 *    (`[{ url, type?, name? }]`, https; `text` may then be empty) and as a reply to a row of this test chat, and its turn
 *    run in the background; `get` shows it.
 *  - `react { sandboxId, msgId, emoji, as? }` → `{ msgId }`: a tapback (❤️ 👍 👎 😂 ‼️ ❓) on any row with words.
 *  - `edit { sandboxId, msgId, text, as? }` → `{ msgId }`: one of the test texts edited, a kind "edit" row `on` it.
 *  - `unsend { sandboxId, msgId, as? }` → `{ msgId }`: one of the test texts taken back, a kind "unsend" row `on` it.
 *    Each of the three goes into the chat object as Tex's line hands it over, and the object decides as in production:
 *    a tapback noted or answered, an edit kept, queued as a text or taken as the same, an unsend taking a waiting text
 *    back. Its steps (`react`, `edit`, ...) are on the row, and a quiet reply row says what the object did.
 *  - `retry { sandboxId, msgId }` → `{ msgId }`: that text or tapback and everything after it dropped, and sent again.
 *  - `back { sandboxId, msgId }`: that text and its reply kept, everything later dropped.
 *  - `drop { sandboxId, msgId }`: that text and everything after it dropped.
 *  - `reset { sandboxId }`: the whole test chat deleted.
 *  - `get { sandboxId, after? }` → `{ rows, writes, line, running: { msgId, node, steps } | null, total? }`: while a
 *    text runs, its row carries its steps so far, the running ones with no `ms` yet; `after` (a row id) answers only the
 *    rows after it; a row has `pics`, `replyTo`, `reactions: [{ who, emoji }]`
 *    when tapped and `unsent: true` when taken back; a tapback's own row is `kind: "reaction"` with its `emoji` and the
 *    row it is `on`, an edit's `kind: "edit"` (`edited: true`) and an unsend's `kind: "unsend"`, each `on` its text.
 *    Every test row carries the `line` it went over (`line.js`: Photon, its holds); a Tex row its `from` (`fd`, or `job`
 *    for a background job's text) and its `cause`, the ids of the steps that led to it (`steps.js`). Each step has its
 *    `id`, `at`, `parent`, whole `in` and `out`, `calls`, model, effort and tokens where it spent any. `writes` are what
 *    the test chat's turns did (`sandboxTools.js`): each with its `id`, `kind`, `title`, and its body, address or
 *    recipients. `line` is the line every new text uses.
 *  - `page { sandboxId, id }` → `{ kind, title, type, text? , base64? }`: one of the test chat's pages or pictures, as
 *    `GET /tex-lab/sandbox/page/<sandboxId>/<id>` serves it to its owner (`pages.js`).
 *  - `list` → `{ chats: [{ sandboxId, source, kind, chat, versionId, openedBy, openedAt, lastBy?, lastAt?, rows, testRows,
 *    running, last }] }`: the person's test chats of the last day, newest used first, whoever opened them on their grant
 *    (the Lab, or an AI through `tex_dev`, named by `by` on `open` and on each send).
 *  - `about { sandboxId }` → `{ source, kind, chat, versionId, convId?, people, rows, testRows }`.
 *  - `use { sandboxId, versionId }`: the draft (or main) the next texts run on, as `open`'s `versionId`.
 *  - `read { sandboxId, options }` → the test chat's history file read (`ledger.read` on its own chat, never another),
 *    so `tex_dev` reads a test turn with Replay's own code, as it reads a real one.
 */

import REPO from "../../../../packages/shared/src/texSetsRepo.generated.json" with { type: "json" };
import { createControlPlane } from "../controlPlane.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../agent/ledger.js";
import { LEDGER_KINDS } from "../texStore/ledger.js";
import { bearerToken } from "../session.js";
import { json } from "../http/responses.js";
import { callSandbox, SANDBOX_TTL_MS, sandboxStub, SEED_CHUNK } from "./object.js";
import { eventId, RUNNING_STALE_MS, stepsOf } from "./harness.js";
import { chatStepsOf, runTestText } from "./chatRun.js";
import { draftFit, TEX_CONFIG } from "../agent/texConfig.js";
import { sharedChatOf, sharedLedger, sharedList } from "./shared.js";
import { inboundEvent, picsOf, reactionOf, TAPBACK_OF, targetOf } from "./inbound.js";
import { lineOf, measuredLine, rowLine } from "./line.js";
import { sandboxAsset } from "./pages.js";

export const LAB_SANDBOX_PATH = "/tex-lab/sandbox";
/** A person's test texts a day, across all their test chats: each runs the real models. */
export const DAILY_SENDS = 200;
/** One read of a real chat's texts; a chat is read whole, page after page, up to `MAX_PAGES` (a million texts). */
const PAGE_TEXTS = 5_000;
const MAX_PAGES = 200;
export const MAX_TEXT = 4_000;
const SANDBOX_ID = /^[0-9a-f]{16}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;
const CONVO_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
/** The bench's Maya: her Dev conversation when the sets have one, else a fresh 1:1 (Dev2 removed it 2026-11-17). */
export const MAYA_CONVO = "maya-and-tex";
const MINUTE = 60_000;

const refused = (status, error) => json({ error }, status);
const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
const parse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A row as the Lab reads it: the ledger's event id left out. */
const shown = ({ eid: _eid, ...row }) => row;

/** What a test chat copies of the real chat's ledger: every kind a turn reads (replies, notes, tools, days, ...), never the steps' logs. */
const COPIED_KINDS = [...LEDGER_KINDS].filter((kind) => kind !== "step");

/**
 * A real chat's ledger before its text `base` (left out), oldest first: read only, and all of it, paged on with `after`
 * (Dev2, 2026-11-16: "its not truly loading the entire converstation history ... thats not gonna do"). Every kind a turn
 * reads, not the texts alone: Tex's history is rebuilt from the texts with their `reply` entries, and with texts only it
 * rebuilt nothing (`ledgerConversation.js`), so a test turn read no history. A read the ledger cannot answer leaves what
 * was read so far.
 */
async function realLedger(env, owner, chat, base) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const entries = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await ledger.read(chat, { ...(after === null ? {} : { after }), kinds: COPIED_KINDS, limit: PAGE_TEXTS, jobs: false }).catch(() => null);
    if (read === null) break;
    for (const entry of read.entries ?? []) if (entry && typeof entry === "object" && (entry.kind !== "text" || (typeof entry.eid === "string" && typeof entry.text === "string"))) entries.push(entry);
    if (!Number.isSafeInteger(read.next)) break;
    after = read.next;
  }
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (typeof base !== "string" || base === "") return entries;
  const at = entries.findIndex((entry) => entry.kind === "text" && entry.eid === base);
  return at < 0 ? entries : entries.slice(0, at);
}

/** How many of the real chat's newest logged steps a test chat reads at open for its line's delays (`line.js`). */
const LINE_STEPS = 2_000;

/** The real chat's logged steps, newest first, for the line's measured delays; none when they cannot be read. */
async function loggedSteps(env, owner, chat) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["step"], limit: LINE_STEPS, jobs: false }).catch(() => null);
  return Array.isArray(read?.entries) ? read.entries : [];
}

/**
 * One row per real text. A voice note is logged twice under one event id (the audio, then what was heard, `heard`),
 * and the test chat keys its rows by that id, so the pair is one row: the one with words. Its history keeps both.
 */
export function oneRowPerText(entries) {
  const byEid = new Map();
  for (const entry of entries) {
    const had = byEid.get(entry.eid);
    if (!had || (String(had.text ?? "").trim() === "" && String(entry.text ?? "").trim() !== "")) byEid.set(entry.eid, entry);
  }
  return [...new Set(entries.map((entry) => entry.eid))].map((eid) => byEid.get(eid));
}

/** The Lab's row for a real text. */
function realRow(entry, kind) {
  const who = entry.from?.kind === "tex" ? "Tex" : typeof entry.from?.name === "string" && entry.from.name !== "" ? entry.from.name : kind === "group" ? "Someone" : "You";
  return { id: entry.eid, eid: entry.eid, who, text: entry.text, at: entry.at, prod: true };
}

/** A Training or Dev conversation as the Lab has it: its draft over the repo's copy. Never the Test Set. */
async function conversationOf(controlPlane, token, id) {
  if (typeof id !== "string" || !CONVO_ID.test(id)) return { error: [400, "name the conversation: convId"] };
  const draft = await controlPlane.labSandbox(token, "set", { id }).catch(() => null);
  const conv = draft?.status === "ok" ? parse(draft.conv) : (REPO.sets ?? []).find((c) => c.id === id) ?? null;
  if (!conv || !Array.isArray(conv.msgs)) return { error: [404, `There is no Training or Dev conversation ${id}.`] };
  if (conv.set === "test") return { error: [403, "The Test Set is people only and never runs here."] };
  return { conv };
}

/**
 * `sets`: the Training and Dev conversations a test chat can start from, each as the Lab has it (its draft over the
 * repo's copy, `texSets.ts` `listDrafts` through the control plane), a removed one left out. The Test Set is never kept
 * there or in the repo's copy, and anything that says it is one is left out here too.
 */
async function setsList(controlPlane, token) {
  const answer = await controlPlane.labSandbox(token, "sets", {}).catch(() => null);
  if (answer === null) return refused(503, "the control plane did not answer");
  const drafts = answer.status === "ok" && Array.isArray(answer.drafts) ? answer.drafts.filter((d) => d && typeof d.id === "string") : [];
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const repo = REPO.sets ?? [];
  const convs = [];
  for (const c of repo) {
    const d = byId.get(c.id);
    if (d?.removed) continue;
    convs.push(d ? (parse(d.conv) ?? c) : c);
  }
  for (const d of drafts) if (!d.removed && !repo.some((c) => c.id === d.id)) convs.push(parse(d.conv));
  const sets = convs
    .filter((c) => c && typeof c.id === "string" && (c.set === "training" || c.set === "dev") && Array.isArray(c.msgs))
    .map((c) => ({
      id: c.id,
      title: String(c.title ?? c.id),
      set: c.set,
      kind: c.kind === "group" ? "group" : "1:1",
      people: c.kind === "group" ? (Array.isArray(c.members) ? c.members.length : 0) : 1,
      texts: c.msgs.filter((m) => m && typeof m.text === "string").length,
    }));
  return json({ sets });
}

/** A conversation's messages as a test chat's start: rows, and the ledger entries a turn reads them from. */
function conversationStart(conv, kind, base) {
  const msgs = conv.msgs.filter((m) => m && typeof m.text === "string");
  const until = typeof base === "string" && base !== "" ? msgs.findIndex((m) => m.id === base) : -1;
  const kept = until < 0 ? msgs : msgs.slice(0, until);
  const now = Date.now();
  const rows = [];
  const history = [];
  kept.forEach((m, i) => {
    const at = now - (kept.length - i) * MINUTE;
    const eid = eventId(at);
    const tex = m.tex === true || m.who === "Tex";
    const who = tex ? "Tex" : kind === "group" ? String(m.who ?? "Someone") : "You";
    rows.push({ id: String(m.id ?? eid), eid, who, text: m.text, at, prod: true });
    history.push(tex
      ? { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "tex" }, text: m.text, delivered: true }
      : { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "person", ...(kind === "group" ? { name: handleOf(m.who) } : {}) }, text: m.text });
  });
  return { rows, history };
}

/** A bench name as a handle (`Mia` → `mia`). */
const handleOf = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) || "someone";

/** The most a drawn draft's graph may be: a whole config's steps and wires, with room to spare. */
export const MAX_DRAWN_GRAPH = 500_000;

/** A drawn graph the Lab sent (its own JSON string), or null when it isn't one. */
function drawnGraph(graph) {
  if (typeof graph !== "string" || graph.length === 0 || graph.length > MAX_DRAWN_GRAPH) return null;
  const parsed = parse(graph);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) ? parsed : null;
}

/**
 * The config a draft's test texts run on. The Lab sends the draft as drawn (`graph`) while it has edits not saved yet,
 * a draft never saved among them (Dev2, 2026-11-16: a draft with unsaved edits left the test chat on "There is no such
 * draft." and its history unreadable); otherwise the saved draft is read. `kept` is the config a chat already has, the
 * last drawn one, for a call that sends none (an AI texting in a chat the Lab opened on an unsaved draft).
 */
async function draftConfig(controlPlane, token, versionId, graph = undefined, kept = undefined) {
  if (versionId === undefined || versionId === null || versionId === "" || versionId === "main") return { config: null };
  if (typeof versionId !== "string" || versionId.length > 200) return { error: [400, "versionId is a Lab draft's id or main"] };
  if (graph !== undefined && graph !== null) {
    const drawn = drawnGraph(graph);
    if (drawn === null) return { error: [400, `graph is the draft's steps and wires as JSON, at most ${MAX_DRAWN_GRAPH} characters`] };
    return { config: drawn, drawn: true };
  }
  const answer = await controlPlane.labSandbox(token, "draft", { draft: versionId });
  if (answer?.status === "ok") return { config: parse(answer.graph) };
  if (kept && typeof kept === "object") return { config: kept, drawn: true };
  return { error: [404, "There is no such draft: save it in the Lab, or send it as drawn (graph)."] };
}

/** `open`: a new test chat, the caller's own. */
async function open(env, controlPlane, token, who, input, origin) {
  const source = input.source ?? "chat";
  const drafted = await draftConfig(controlPlane, token, input.versionId, input.graph);
  if (drafted.error) return refused(...drafted.error);
  let chat;
  let conv = null;
  if (source === "set" || source === "maya") {
    const found = await conversationOf(controlPlane, token, source === "maya" ? MAYA_CONVO : input.convId);
    if (found.error && !(source === "maya" && found.error[0] === 404)) return refused(...found.error);
    conv = found.conv ?? { id: "maya", title: "Maya (test account)", set: "dev", kind: "one", members: ["Maya"], msgs: [] };
    // A group conversation runs in one of the caller's group chats (its Tex notes read, its history the conversation's).
    chat = conv.kind === "group" ? input.chatId : "me";
    if (conv.kind === "group" && (typeof chat !== "string" || !CHAT_KEY.test(chat))) return refused(400, "a group conversation runs in one of your group chats: pass chatId");
  } else if (source === "chat") {
    chat = typeof input.chatId === "string" && input.chatId !== "" ? input.chatId : "me";
  } else if (source === "shared") {
    chat = input.chatId;
  } else return refused(400, 'source is "chat", "set", "maya" or "shared"');

  // A shared chat is someone else's: its session is the sharer's own, given only while it is listed (`shared.js`).
  let owner;
  let group;
  let answer;
  if (source === "shared") {
    const found = await sharedChatOf(controlPlane, token, chat);
    if (found.error) return refused(...found.error);
    group = found.chat.kind === "group";
    owner = found.chat.owner;
    answer = await controlPlane.labSandbox(token, "session", { chat, shared: true });
  } else {
    answer = await controlPlane.labSandbox(token, "session", { chat });
  }
  if (answer === null) return refused(503, "the control plane did not answer");
  if (answer.status !== "ok") return refused(answer.status === "bad_request" ? 400 : 404, answer.error ?? "There is no such chat.");
  if (source !== "shared") {
    group = chat !== "me";
    owner = group ? { chat } : { person: answer.session.defaultWorkspaceId };
  } else if (!group && answer.session.defaultWorkspaceId !== owner.person) return refused(404, "That chat isn't shared with the developers (or no longer is).");
  const kind = group ? "group" : "one";
  const ledgerChat = group ? owner.chat : ONE_TO_ONE_CHAT;

  let rows;
  let history;
  let people;
  if (conv !== null) {
    ({ rows, history } = conversationStart(conv, kind, input.base));
    people = group ? (conv.members ?? []).map((name) => ({ handle: handleOf(name), name: String(name) })) : [{ handle: "", name: "You" }];
  } else {
    const entries = await realLedger(env, owner, ledgerChat, input.base);
    rows = oneRowPerText(entries.filter((entry) => entry.kind === "text")).map((entry) => realRow(entry, kind));
    history = entries.map(({ seq: _seq, ...entry }) => entry);
    people = (answer.people ?? []).filter((person) => person && typeof person.handle === "string");
  }
  const sandboxId = randomId();
  const stub = sandboxStub(env, who.userId, sandboxId);
  // The line every text here goes over: Photon, its delays measured from the real chat's own logged deliveries.
  const line = measuredLine(conv === null ? await loggedSteps(env, owner, ledgerChat) : []);
  const about = {
    sandboxId,
    origin,
    line,
    source,
    chat,
    kind,
    owner: group ? `chat:${owner.chat}` : `person:${owner.person}`,
    ledgerChat,
    ...(source === "shared" ? { shared: true } : {}),
    ...(group ? { chatKey: owner.chat, members: await sha256Hex(`lab:${chat}:${people.map((p) => p.handle).sort().join(",")}`) } : {}),
    people,
    versionId: typeof input.versionId === "string" ? input.versionId : "main",
    config: drafted.config,
    ...(drafted.drawn ? { drawn: true } : {}),
    ...(conv !== null ? { convId: conv.id } : {}),
    ...(typeof who.timeZone === "string" ? { timeZone: who.timeZone } : {}),
  };
  // The whole chat, in pieces a Durable Object call carries (`object.js` `SEED_CHUNK`).
  await callSandbox(stub, "init", { about, rows: rows.slice(0, SEED_CHUNK), history: history.slice(0, SEED_CHUNK) });
  for (let at = SEED_CHUNK; at < Math.max(rows.length, history.length); at += SEED_CHUNK) {
    await callSandbox(stub, "seed", { rows: rows.slice(at, at + SEED_CHUNK), history: history.slice(at, at + SEED_CHUNK) });
  }
  // Listed for the person, so the Lab can follow a test chat an AI opened on their grant, and the AI one the Lab opened.
  await callSandbox(indexStub(env, who.userId), "meta", { key: `sb:${sandboxId}`, value: { sandboxId, source, chat, kind: group ? "group" : "1:1", versionId: about.versionId, by: byOf(input.by), at: Date.now() } }).catch(() => {});
  console.log(JSON.stringify({ event: "lab_sandbox_open", source, kind, rows: rows.length, draft: about.versionId !== "main" }));
  return json({ sandboxId, people, rows: rows.map(shown), fit: draftFit(TEX_CONFIG, drafted.config) });
}

/** The Lab's view: rows (each tapped one with its `reactions`), writes, and the turn running now (a stale mark is no turn). */
function view(state) {
  const running = state.meta?.running;
  const live = running && typeof running === "object" && Date.now() - (running.at ?? 0) < RUNNING_STALE_MS;
  const list = state.rows ?? [];
  const taps = new Map();
  for (const row of list) if (row.kind === "reaction" && typeof row.on === "string") taps.set(row.on, [...(taps.get(row.on) ?? []), { who: row.who, emoji: row.emoji }]);
  // A text taken back says so on its own row, as Messages shows it gone.
  const gone = new Set(list.filter((row) => row.kind === "unsend").map((row) => row.on));
  const rows = list.map((row) => ({ ...shown(row), ...(taps.has(row.id) ? { reactions: taps.get(row.id) } : {}), ...(gone.has(row.id) ? { unsent: true } : {}) }));
  const line = lineOf(state.meta?.chat);
  return { rows, writes: state.writes ?? [], line: { name: line.name, inMs: line.inMs, outMs: line.outMs, number: line.number, measured: line.measured }, running: live ? { msgId: running.msgId, node: running.node ?? null } : null };
}

/**
 * `get`: the view, with the running text's steps so far on its own row, from the node and step entries its turn has
 * kept (never estimated), so the Lab lights each step as it finishes. `after` (a row id) answers only the rows after
 * it, with `total`, so a long chat is not sent again on every look.
 */
async function liveView(stub, state, after) {
  const seen = view(state);
  if (seen.running !== null) {
    // Each step as it finished (`harness.js` `show`): the chat object's own (A text arrives, Old number?, Triage,
    // Decide, the queue) as it logged each, then the turn's nodes. Once the turn's nodes are written, what its ledger kept.
    const entries = await callSandbox(stub, "ledger.of", { by: seen.running.msgId }).then((read) => read.entries ?? []).catch(() => []);
    const since = seen.rows.find((row) => row.id === seen.running.msgId)?.at ?? 0;
    const kept = chatStepsOf(entries, { since });
    const live = Array.isArray(state.meta?.running?.steps) ? state.meta.running.steps : [];
    // The text's own step book (`steps.js`: ids, parents, the running ones) whenever it has one; else the ledger's.
    const booked = live.some((step) => typeof step?.id === "string");
    const steps = booked ? live : stepsOf(entries).length > 0 || live.length < kept.length ? kept : live;
    seen.rows = seen.rows.map((row) => (row.id === seen.running.msgId ? { ...row, steps } : row));
    seen.running = { ...seen.running, steps };
  }
  if (typeof after === "string" && after !== "") {
    const at = seen.rows.findIndex((row) => row.id === after);
    if (at >= 0) return { ...seen, rows: seen.rows.slice(at + 1), total: seen.rows.length };
  }
  return seen;
}

/** Who a test row is from: a person's handle or a name in a group, the person in a 1:1; `{ speaker }` or `{ error }`. */
function speakerOf(about, as) {
  if (about.kind !== "group") return { speaker: "You" };
  const speaker = typeof as === "string" && as.trim() !== "" ? as.trim().slice(0, 64) : (about.people ?? [])[0]?.handle ?? "someone";
  if (!HANDLE.test(speaker) && !/^[\p{L}\p{N} ._\-']{1,40}$/u.test(speaker)) return { error: [400, "as is a person's handle or a name"] };
  return { speaker };
}

/**
 * A test row into the chat, and its run through the chat object in the background: the object logs its event and
 * decides, as in production, whether it takes a turn (a tapback it only notes, an unsend, an edit that changed nothing
 * end quiet, their reply row saying what the object did). Every row is counted.
 */
async function addRow({ env, ctx, controlPlane, token, who, stub, state, row, origin, runTurn, graph, cut = null }) {
  const about = state.meta.chat;
  // The draft as drawn now (sent while it has unsaved edits) or as saved now, not as it was at open: an edit in the Lab
  // since then is what the next turn runs.
  const drafted = await draftConfig(controlPlane, token, about.versionId, graph, about.drawn === true ? about.config : undefined);
  if (drafted.error) return refused(...drafted.error);
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
  if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  // A shared chat's session is asked again on every text, so one no longer shared stops at once.
  const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat, ...(about.shared === true ? { shared: true } : {}) });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "This chat is no longer yours to test in.");
  // The test chat is this text's, taken in the object in one step: two sends at once never both get past here, whatever
  // the reads above saw. Until its turn starts, anything that fails gives the chat back.
  const claimed = await callSandbox(stub, "claim", { msgId: row.id, staleMs: RUNNING_STALE_MS });
  if (!claimed.ok) return refused(409, "a test text is still running: wait for its reply");
  try {
    // The draft as drawn is kept with the chat, so its `about` says what ran and an AI texting here next runs the same.
    if (graph !== undefined && graph !== null) await callSandbox(stub, "meta", { key: "chat", value: { ...about, config: drafted.config, drawn: true } });
    // A retry cuts its old text only once everything that could refuse it has passed, so a refusal loses nothing.
    if (cut !== null) await callSandbox(stub, "cut.from", { id: cut });
    await callSandbox(stub, "row.add", { row });
    // The text's event as the Worker logs it, unless the chat object the turn runs through logs it itself.
    const logged = typeof runTurn.logsText === "function" && runTurn.logsText(row);
    if (!logged) await callSandbox(stub, "ledger.append", { entries: [await inboundEvent({ about, row, rows: [...(state.rows ?? []), row] })], by: row.id });
  } catch (error) {
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
    throw error;
  }
  const run = runTurn({ env, stub, about, row, payload: answer.session, token, config: drafted.config ?? null, origin, chat: answer.chat ?? null });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
  else await run;
  return json({ msgId: row.id });
}

/** A new test row's ids: its event id and the row id built from it. */
function newIds() {
  const at = Date.now();
  const eid = eventId(at);
  return { at, eid, id: `t${eid.replace("-", "")}` };
}

/** `send`, and `retry`'s second half: a text, with its pictures and the row it replies to, and its turn. */
async function send(deps, state, { as, text = "", pics: given, replyTo }, cut = null) {
  if (typeof text !== "string" || text.length > MAX_TEXT) return refused(400, `text is at most ${MAX_TEXT} characters`);
  const { pics, error } = picsOf(given);
  if (error) return refused(400, error);
  if (text.trim() === "" && pics.length === 0) return refused(400, `text is 1 to ${MAX_TEXT} characters, or empty with pictures`);
  if (replyTo !== undefined && replyTo !== null) {
    const target = targetOf(state.rows, replyTo, "replied to");
    if (target.error) return refused(...target.error);
  }
  const about = state.meta.chat;
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const speaker = speakerOf(about, as);
  if (speaker.error) return refused(...speaker.error);
  const { at, eid, id } = newIds();
  const row = { id, eid, who: speaker.speaker, text, at, prod: false, line: rowLine(lineOf(about)), ...(pics.length > 0 ? { pics } : {}), ...(typeof replyTo === "string" ? { replyTo } : {}) };
  return await addRow({ ...deps, state, row, cut });
}

/** `react`: a tapback on a row with words, handed to the chat object as Tex's line hands one over. */
async function react(deps, state, { msgId, emoji, as }, cut = null) {
  if (typeof emoji !== "string" || !TAPBACK_OF[emoji]) return refused(400, `emoji is one of ${Object.keys(TAPBACK_OF).join(" ")}`);
  const target = targetOf(state.rows, msgId, "tapped");
  if (target.error) return refused(...target.error);
  const about = state.meta.chat;
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const speaker = speakerOf(about, as);
  if (speaker.error) return refused(...speaker.error);
  const read = await reactionOf({ about, target: target.row, emoji, as: speaker.speaker, rows: state.rows });
  const { at, eid, id } = newIds();
  // Its line is how the chat shows it; whether it is noted or answered is the chat object's call (`reactions.ts`).
  const row = { id, eid, who: speaker.speaker, kind: "reaction", emoji, on: target.row.id, text: read.line, at, prod: false, line: rowLine(lineOf(about)) };
  return await addRow({ ...deps, state, row, cut });
}

/**
 * The test text an edit or an unsend changes: one of this test chat's own texts, never a real one, Tex's, a tapback, an
 * edit or unsend row, or a text already taken back; in a group, edited only as whoever sent it. `{ row }` or `{ error }`.
 */
function changeable(state, msgId, as, verb) {
  const found = testRow(state, msgId);
  if (found.error) return found;
  const { row } = found;
  const done = verb === "edit" ? "edited" : "unsent";
  if (row.who === "Tex" || row.reply) return { error: [400, `Tex's text is never ${done}: ${verb} one of the test texts`] };
  if (row.kind === "reaction") return { error: [400, `a tapback is never ${done}`] };
  if (row.kind === "edit" || row.kind === "unsend") return { error: [400, `${verb} the text itself, not its ${row.kind}`] };
  if ((state.rows ?? []).some((r) => r.kind === "unsend" && r.on === row.id)) return { error: [400, "That text was taken back."] };
  if (state.meta.chat.kind === "group" && typeof as === "string" && as.trim() !== "" && as.trim() !== row.who) return { error: [403, `That text is ${row.who}'s: ${verb} it as them.`] };
  return { row };
}

/**
 * `edit` and `unsend`: the change handed to the chat object as Tex's line hands one over (`/edit`), which asks node
 * `edit` over `/texts/edit` on the test chat's draft and keeps it, queues its turn, or takes a waiting text back
 * (`editStep.ts`, `chatObject.ts` `takeEdit`). The row is the person's change; the reply row says what came of it.
 */
async function change(deps, state, { msgId, text, as }, verb, cut = null) {
  const found = changeable(state, msgId, as, verb);
  if (found.error) return refused(...found.error);
  if (verb === "edit" && (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT)) return refused(400, `text is 1 to ${MAX_TEXT} characters`);
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const { at, eid, id } = newIds();
  const unsend = verb === "unsend";
  const row = { id, eid, who: found.row.who, kind: unsend ? "unsend" : "edit", on: found.row.id, text: unsend ? "" : text, at, prod: false, line: rowLine(lineOf(state.meta.chat)), ...(unsend ? {} : { edited: true }) };
  return await addRow({ ...deps, state, row, cut });
}

/** A test text the caller may cut at: one of this test chat's own, never a real text it started from. */
function testRow(state, msgId) {
  const row = (state.rows ?? []).find((r) => r.id === msgId);
  if (!row) return { error: [404, "There is no such text in this test chat."] };
  if (row.prod) return { error: [400, "That is a real text: open the chat with base set to it to try from there."] };
  return { row };
}

/** The person's own index object: their send count and the list of their test chats. Never another's. */
const indexStub = (env, userId) => sandboxStub(env, userId, "index0000000000");
/** Who opened or last used a test chat: "Lab", or the AI client's name `tex_dev` passes. */
const byOf = (by) => (typeof by === "string" && /^[\p{L}\p{N} ._()\-]{1,60}$/u.test(by) ? by : "Lab");
/** How many test chats `list` answers, newest used first. */
const LISTED = 20;

/**
 * `list`: the person's test chats from the last day, newest used first, each with who opened it and who last used it
 * (the Lab, or an AI through `tex_dev` on the person's grant), the draft it runs, its size and the text running now, so
 * the Lab follows a test chat an AI is driving and the AI one the person is (Dev2, 2026-11-16: "if I go into a
 * session/draft an AI is updating / editing, we can co work, and when its playing something I can see it playing").
 */
async function listOf(env, userId) {
  const index = await callSandbox(indexStub(env, userId), "state", {}).catch(() => null);
  const meta = index?.meta ?? {};
  const since = Date.now() - SANDBOX_TTL_MS;
  const opened = Object.entries(meta)
    .filter(([key, value]) => key.startsWith("sb:") && value && typeof value === "object")
    .map(([, value]) => ({ ...value, used: meta[`used:${value.sandboxId}`] ?? null }))
    .filter((chat) => Math.max(chat.at ?? 0, chat.used?.at ?? 0) >= since)
    .sort((a, b) => Math.max(b.at ?? 0, b.used?.at ?? 0) - Math.max(a.at ?? 0, a.used?.at ?? 0))
    .slice(0, LISTED);
  const chats = [];
  for (const chat of opened) {
    const state = await callSandbox(sandboxStub(env, userId, chat.sandboxId), "state", {}).catch(() => null);
    if (!state?.meta?.chat) continue;
    const seen = view(state);
    const last = seen.rows.at(-1) ?? null;
    chats.push({
      sandboxId: chat.sandboxId,
      source: chat.source,
      kind: chat.kind,
      chat: chat.chat,
      versionId: state.meta.chat.versionId ?? "main",
      openedBy: chat.by ?? "Lab",
      openedAt: chat.at,
      ...(chat.used ? { lastBy: chat.used.by ?? "Lab", lastAt: chat.used.at } : {}),
      rows: seen.rows.length,
      testRows: seen.rows.filter((row) => !row.prod).length,
      running: seen.running,
      ...(last ? { last: { who: last.who, text: String(last.text ?? "").slice(0, 120) } } : {}),
    });
  }
  return { chats };
}

/** What a test chat is: where it started, whose chat, the draft its next texts run on, its people and size. */
function aboutOf(state) {
  const about = state.meta.chat;
  const rows = state.rows ?? [];
  return {
    source: about.source,
    kind: about.kind === "group" ? "group" : "1:1",
    chat: about.chat,
    versionId: about.versionId ?? "main",
    ...(about.convId ? { convId: about.convId } : {}),
    people: about.people ?? [],
    rows: rows.length,
    testRows: rows.filter((row) => !row.prod).length,
    // Whether its texts run the draft as drawn, or main's code for steps the draft adds, removes or changes (`draftFit`).
    fit: draftFit(TEX_CONFIG, about.config ?? null),
    // The Lab sent the draft as drawn (edits not saved yet): its texts run that, not the saved copy.
    ...(about.drawn === true ? { drawn: true } : {}),
  };
}

/** The ledger read options `read` passes on, each checked; the chat is always the test chat's own. */
const READ_KEYS = ["before", "after", "since", "until"];
function readOptions(options) {
  const given = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const out = {};
  for (const key of READ_KEYS) if (Number.isSafeInteger(given[key])) out[key] = given[key];
  if (Array.isArray(given.kinds)) out.kinds = given.kinds.filter((kind) => typeof kind === "string").slice(0, 32);
  out.limit = Number.isSafeInteger(given.limit) && given.limit > 0 ? Math.min(given.limit, 5_000) : 500;
  if (typeof given.jobs === "boolean") out.jobs = given.jobs;
  if (given.slim === true) out.slim = true;
  return out;
}

/** One `/tex-lab/sandbox` call. */
export async function handleLabSandbox(request, env, ctx, options = {}) {
  try {
    return await serveLabSandbox(request, env, ctx, options);
  } catch (error) {
    // Said in words the Lab can show, never a bare "server_error"; the log keeps the cause, never a text's words.
    console.log(JSON.stringify({ event: "lab_sandbox_failed", reason: String(error?.message ?? error).slice(0, 200) }));
    return refused(500, "The test chat hit a problem on the server and couldn't finish. Try again, or pick another chat.");
  }
}

async function serveLabSandbox(request, env, ctx, { origin = "https://context.lc", runTurn = runTestText } = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env?.LAB_SANDBOX) return refused(501, "this deployment has no Lab test chats");
  const token = bearerToken(request);
  if (!token) return refused(401, "sign in");
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.op !== "string") return refused(400, "a call is { op, ... }");
  const controlPlane = createControlPlane(env);
  const who = await controlPlane.labSandbox(token, "who").catch(() => null);
  if (who === null) return refused(503, "the control plane did not answer");
  if (who.status === "refused" || typeof who.userId !== "string") return refused(403, "Only Tex developers use the Lab's test chats.");

  if (input.op === "chats") {
    const groups = (Array.isArray(who.chats) ? who.chats : [])
      .filter((chat) => CHAT_KEY.test(chat?.key ?? ""))
      .map((chat) => ({ chatId: chat.key, name: String(chat.name ?? "Group chat"), kind: "group", people: Number.isSafeInteger(chat.people) && chat.people > 0 ? chat.people : 1 }));
    return json({ chats: [{ chatId: "me", name: "You and Tex", kind: "1:1", people: 1 }, ...groups] });
  }
  if (input.op === "sets") return await setsList(controlPlane, token);
  if (input.op === "open") return await open(env, controlPlane, token, who, input, origin);
  if (input.op === "list") return json(await listOf(env, who.userId));
  if (input.op === "shared") return await sharedList(controlPlane, token);
  if (input.op === "ledger") return await sharedLedger(env, controlPlane, token, who, input);

  if (typeof input.sandboxId !== "string" || !SANDBOX_ID.test(input.sandboxId)) return refused(400, "name the test chat: sandboxId");
  const stub = sandboxStub(env, who.userId, input.sandboxId);
  // Asked first, making nothing: an id nobody opened gets no tables and no alarm (`object.js` `exists`).
  const kept = stub === null ? false : (await callSandbox(stub, "exists", {})).exists;
  const state = kept ? await callSandbox(stub, "state", {}) : null;
  if (!state?.meta?.chat) return refused(404, "There is no such test chat (Reset or a day unused deletes one).");

  const deps = { env, ctx, controlPlane, token, who, stub, origin, runTurn, graph: input.graph };
  if (["send", "react", "edit", "unsend", "retry", "use"].includes(input.op)) {
    await callSandbox(indexStub(env, who.userId), "meta", { key: `used:${input.sandboxId}`, value: { at: Date.now(), by: byOf(input.by), op: input.op } }).catch(() => {});
  }
  switch (input.op) {
    case "get":
      return json(await liveView(stub, state, input.after));
    case "send":
      return await send(deps, state, input);
    case "react":
      return await react(deps, state, input);
    case "edit":
    case "unsend":
      return await change(deps, state, input, input.op);
    case "retry": {
      const found = testRow(state, input.msgId);
      if (found.error) return refused(...found.error);
      if (found.row.reply) return refused(400, "retry a text, not Tex's reply");
      if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
      // Checked against the chat as it will be once the text is cut; the cut itself waits until nothing can refuse it.
      const { row } = found;
      const at = (state.rows ?? []).findIndex((r) => r.id === row.id);
      const before = { ...state, rows: (state.rows ?? []).slice(0, at) };
      if (row.kind === "reaction") return await react(deps, before, { msgId: row.on, emoji: row.emoji, as: row.who }, row.id);
      if (row.kind === "edit" || row.kind === "unsend") return await change(deps, before, { msgId: row.on, text: row.text, as: row.who }, row.kind, row.id);
      return await send(deps, before, { as: row.who, text: row.text, pics: row.pics, replyTo: row.replyTo }, row.id);
    }
    case "back":
    case "drop": {
      const found = testRow(state, input.msgId);
      if (found.error) return refused(...found.error);
      if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
      await callSandbox(stub, input.op === "back" ? "cut.after" : "cut.from", { id: found.row.id });
      return json(view(await callSandbox(stub, "state", {})));
    }
    case "reset":
      await callSandbox(stub, "reset", {});
      await callSandbox(indexStub(env, who.userId), "meta", { key: `sb:${input.sandboxId}`, value: null }).catch(() => {});
      await callSandbox(indexStub(env, who.userId), "meta", { key: `used:${input.sandboxId}`, value: null }).catch(() => {});
      return json({ ok: true });
    // For `tex_dev` (Dev2, 2026-11-16: an AI does everything the Lab does here): what the test chat is, the draft its
    // next texts run on, and its history file read as Replay reads a real one (`texDev/sandbox.js`).
    case "about":
      // `graph: true` adds the draft as drawn, for a chat that runs one (a draft not saved yet): what its runs ran on.
      return json({ ...aboutOf(state), ...(input.graph === true && state.meta.chat.drawn === true ? { graph: state.meta.chat.config ?? null } : {}) });
    case "use": {
      if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
      const drafted = await draftConfig(controlPlane, token, input.versionId, input.graph);
      if (drafted.error) return refused(...drafted.error);
      const versionId = typeof input.versionId === "string" && input.versionId !== "" ? input.versionId : "main";
      const chat = { ...state.meta.chat, versionId, config: drafted.config, drawn: drafted.drawn === true };
      await callSandbox(stub, "meta", { key: "chat", value: chat });
      return json({ ...aboutOf({ ...state, meta: { ...state.meta, chat } }) });
    }
    case "read":
      return json(await callSandbox(stub, "ledger.read", { chat: state.meta.chat.ledgerChat, options: readOptions(input.options) }));
    case "page": {
      const asset = await sandboxAsset(env, who.userId, input.sandboxId, input.id);
      return asset === null ? refused(404, "There is no such page in this test chat.") : json(asset);
    }
    default:
      return refused(400, "op is chats, sets, shared, ledger, list, open, send, react, edit, unsend, retry, back, drop, reset, get, page, about, use or read");
  }
}
