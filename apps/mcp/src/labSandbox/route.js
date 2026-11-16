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
 *  - `open { source: "chat" | "set" | "maya", chatId?, convId?, versionId?, base? }` → `{ sandboxId, people, rows }`:
 *    a real chat's texts so far (up to `base`, which is left out), or a Training or Dev conversation's (never the Test
 *    Set's), as the test chat's start; `maya` is the bench's Maya conversation.
 *  - `send { sandboxId, as?, text, pics?, replyTo? }` → `{ msgId }`: the text, as `as`, with up to 6 pictures
 *    (`[{ url, type?, name? }]`, https; `text` may then be empty) and as a reply to a row of this test chat, and its turn
 *    run in the background; `get` shows it.
 *  - `react { sandboxId, msgId, emoji, as? }` → `{ msgId, turn }`: a tapback (❤️ 👍 👎 😂 ‼️ ❓) on any row with words;
 *    `turn` false when production only notes it (a 1:1 tapback that answers nothing), its reply row quiet and `noted`.
 *  - `edit { sandboxId, msgId, text, as? }` → `{ msgId, to, why }`: one of the test texts edited, taken as production takes
 *    an edit (`edits.js`): node `edit` says `same` (nothing kept), or `turn`, a kind "edit" row `on` the text with the new
 *    words, kept beside it and its turn run.
 *  - `unsend { sandboxId, msgId, as? }` → `{ msgId, to, why }`: one of the test texts taken back, a kind "unsend" row `on`
 *    it, kept with a quiet noted reply and no turn, as production keeps one.
 *  - `retry { sandboxId, msgId }` → `{ msgId }`: that text or tapback and everything after it dropped, and sent again.
 *  - `back { sandboxId, msgId }`: that text and its reply kept, everything later dropped.
 *  - `drop { sandboxId, msgId }`: that text and everything after it dropped.
 *  - `reset { sandboxId }`: the whole test chat deleted.
 *  - `get { sandboxId, after? }` → `{ rows, writes, running: { msgId, node, steps } | null, total? }`: while a text
 *    runs, its row carries the steps its turn has finished so far; `after` (a row id) answers only the rows after it; a row has `pics`, `replyTo`, `reactions: [{ who, emoji }]`
 *    when tapped and `unsent: true` when taken back; a tapback's own row is `kind: "reaction"` with its `emoji` and the
 *    row it is `on`, an edit's `kind: "edit"` (`edited: true`) and an unsend's `kind: "unsend"`, each `on` its text.
 */

import REPO from "../../../../packages/shared/src/texSetsRepo.generated.json" with { type: "json" };
import { createControlPlane } from "../controlPlane.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../agent/ledger.js";
import { bearerToken } from "../session.js";
import { json } from "../http/responses.js";
import { callSandbox, sandboxStub, SEED_CHUNK } from "./object.js";
import { eventId, stepsOf, TURN_LIMIT_MS } from "./harness.js";
import { chatStepsOf, runTestText } from "./chatRun.js";
import { inboundEvent, picsOf, reactionOf, TAPBACK_OF, targetOf } from "./inbound.js";
import { runEditNode, UNSENT_NOTE, wordsNow } from "./edits.js";

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
/** The bench's Maya: her Dev conversation with Tex. */
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

/**
 * A real chat's texts before `base` (left out), oldest first, from the chat's ledger: read only, and all of them,
 * paged on with `after` (Dev2, 2026-11-16: "its not truly loading the entire converstation history ... thats not gonna
 * do"). A read the ledger cannot answer leaves what was read so far.
 */
async function realTexts(env, owner, chat, base) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const entries = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await ledger.read(chat, { ...(after === null ? {} : { after }), kinds: ["text"], limit: PAGE_TEXTS, jobs: false }).catch(() => null);
    if (read === null) break;
    for (const entry of read.entries ?? []) if (entry?.kind === "text" && typeof entry.eid === "string" && typeof entry.text === "string") entries.push(entry);
    if (!Number.isSafeInteger(read.next)) break;
    after = read.next;
  }
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (typeof base !== "string" || base === "") return entries;
  const at = entries.findIndex((entry) => entry.eid === base);
  return at < 0 ? entries : entries.slice(0, at);
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

async function draftConfig(controlPlane, token, versionId) {
  if (versionId === undefined || versionId === null || versionId === "" || versionId === "main") return { config: null };
  if (typeof versionId !== "string" || versionId.length > 200) return { error: [400, "versionId is a Lab draft's id or main"] };
  const answer = await controlPlane.labSandbox(token, "draft", { draft: versionId });
  if (answer?.status !== "ok") return { error: [404, "There is no such draft."] };
  return { config: parse(answer.graph) };
}

/** `open`: a new test chat, the caller's own. */
async function open(env, controlPlane, token, who, input) {
  const source = input.source ?? "chat";
  const drafted = await draftConfig(controlPlane, token, input.versionId);
  if (drafted.error) return refused(...drafted.error);
  let chat;
  let conv = null;
  if (source === "set" || source === "maya") {
    const found = await conversationOf(controlPlane, token, source === "maya" ? MAYA_CONVO : input.convId);
    if (found.error) return refused(...found.error);
    conv = found.conv;
    // A group conversation runs in one of the caller's group chats (its Tex notes read, its history the conversation's).
    chat = conv.kind === "group" ? input.chatId : "me";
    if (conv.kind === "group" && (typeof chat !== "string" || !CHAT_KEY.test(chat))) return refused(400, "a group conversation runs in one of your group chats: pass chatId");
  } else if (source === "chat") {
    chat = typeof input.chatId === "string" && input.chatId !== "" ? input.chatId : "me";
  } else return refused(400, 'source is "chat", "set" or "maya"');

  const answer = await controlPlane.labSandbox(token, "session", { chat });
  if (answer === null) return refused(503, "the control plane did not answer");
  if (answer.status !== "ok") return refused(answer.status === "bad_request" ? 400 : 404, answer.error ?? "There is no such chat.");
  const payload = answer.session;
  const group = chat !== "me";
  const kind = group ? "group" : "one";
  const owner = group ? { chat } : { person: payload.defaultWorkspaceId };
  const ledgerChat = group ? chat : ONE_TO_ONE_CHAT;

  let rows;
  let history;
  let people;
  if (conv !== null) {
    ({ rows, history } = conversationStart(conv, kind, input.base));
    people = group ? (conv.members ?? []).map((name) => ({ handle: handleOf(name), name: String(name) })) : [{ handle: "", name: "You" }];
  } else {
    const entries = await realTexts(env, owner, ledgerChat, input.base);
    rows = oneRowPerText(entries).map((entry) => realRow(entry, kind));
    history = entries.map(({ seq: _seq, ...entry }) => entry);
    people = (answer.people ?? []).filter((person) => person && typeof person.handle === "string");
  }
  const sandboxId = randomId();
  const stub = sandboxStub(env, who.userId, sandboxId);
  const about = {
    source,
    chat,
    kind,
    owner: group ? `chat:${chat}` : `person:${payload.defaultWorkspaceId}`,
    ledgerChat,
    ...(group ? { chatKey: chat, members: await sha256Hex(`lab:${chat}:${people.map((p) => p.handle).sort().join(",")}`) } : {}),
    people,
    versionId: typeof input.versionId === "string" ? input.versionId : "main",
    config: drafted.config,
    ...(conv !== null ? { convId: conv.id } : {}),
    ...(typeof who.timeZone === "string" ? { timeZone: who.timeZone } : {}),
  };
  // The whole chat, in pieces a Durable Object call carries (`object.js` `SEED_CHUNK`).
  await callSandbox(stub, "init", { about, rows: rows.slice(0, SEED_CHUNK), history: history.slice(0, SEED_CHUNK) });
  for (let at = SEED_CHUNK; at < Math.max(rows.length, history.length); at += SEED_CHUNK) {
    await callSandbox(stub, "seed", { rows: rows.slice(at, at + SEED_CHUNK), history: history.slice(at, at + SEED_CHUNK) });
  }
  console.log(JSON.stringify({ event: "lab_sandbox_open", source, kind, rows: rows.length, draft: about.versionId !== "main" }));
  return json({ sandboxId, people, rows: rows.map(shown) });
}

/** The Lab's view: rows (each tapped one with its `reactions`), writes, and the turn running now (a stale mark is no turn). */
function view(state) {
  const running = state.meta?.running;
  const live = running && typeof running === "object" && Date.now() - (running.at ?? 0) < TURN_LIMIT_MS + 2 * MINUTE;
  const list = state.rows ?? [];
  const taps = new Map();
  for (const row of list) if (row.kind === "reaction" && typeof row.on === "string") taps.set(row.on, [...(taps.get(row.on) ?? []), { who: row.who, emoji: row.emoji }]);
  // A text taken back says so on its own row, as Messages shows it gone.
  const gone = new Set(list.filter((row) => row.kind === "unsend").map((row) => row.on));
  const rows = list.map((row) => ({ ...shown(row), ...(taps.has(row.id) ? { reactions: taps.get(row.id) } : {}), ...(gone.has(row.id) ? { unsent: true } : {}) }));
  return { rows, writes: state.writes ?? [], running: live ? { msgId: running.msgId, node: running.node ?? null } : null };
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
    const kept = chatStepsOf(entries);
    const live = Array.isArray(state.meta?.running?.steps) ? state.meta.running.steps : [];
    const steps = stepsOf(entries).length > 0 || live.length < kept.length ? kept : live;
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

/** What a noted tapback's quiet row says: production runs no turn for it (`apps/agent/src/inbox.ts` `react`). */
const NOTED = "Noted, not answered: a 1:1 tapback that answers nothing runs no turn; the next text carries it as reacted.";

/**
 * A test row into the chat: its event into the ledger as the Worker logs it, and its turn run in the background, or,
 * for a tapback production only notes, a quiet reply row and no turn. Only a row that runs a turn is counted.
 */
async function addRow({ env, ctx, controlPlane, token, who, stub, state, row, origin, runTurn, turn = true, cut = null, before = [], note = NOTED }) {
  const about = state.meta.chat;
  // The draft as saved now, not as it was at open: an edit in the Lab since then is what the next turn runs.
  const drafted = turn ? await draftConfig(controlPlane, token, about.versionId) : { config: about.config ?? null };
  if (drafted.error) return refused(...drafted.error);
  if (turn) {
    const day = new Date().toISOString().slice(0, 10);
    const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
    if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  }
  const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "This chat is no longer yours to test in.");
  // A retry cuts its old text only once everything that could refuse it has passed, so a refusal loses nothing.
  if (cut !== null) {
    // Read again: a send that landed while the checks above were out is running now, and the cut would take it.
    const now = await callSandbox(stub, "state", {});
    if (view(now).running !== null) return refused(409, "a test text is still running: wait for its reply");
    await callSandbox(stub, "cut.from", { id: cut });
  }
  await callSandbox(stub, "row.add", { row });
  // The text's event as the Worker logs it, unless the chat object the turn runs through logs it itself.
  const logged = typeof runTurn.logsText === "function" && runTurn.logsText(row) && turn;
  const entries = [...before, ...(logged ? [] : [await inboundEvent({ about, row, rows: [...(state.rows ?? []), row] })])];
  if (entries.length > 0) await callSandbox(stub, "ledger.append", { entries, by: row.id });
  const tapback = row.kind === "reaction" ? { turn } : {};
  if (!turn) {
    await callSandbox(stub, "row.add", { row: { id: `${row.id}r`, reply: row.id, who: "Tex", text: "", at: row.at, prod: false, quiet: true, noted: true, note, ms: 0, steps: [] } });
    return json({ msgId: row.id, ...tapback });
  }
  await callSandbox(stub, "meta", { key: "running", value: { msgId: row.id, node: null, at: row.at } });
  const run = runTurn({ env, stub, about, row, payload: answer.session, token, config: drafted.config ?? null, origin, chat: answer.chat ?? null });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
  else await run;
  return json({ msgId: row.id, ...tapback });
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
  const row = { id, eid, who: speaker.speaker, text, at, prod: false, ...(pics.length > 0 ? { pics } : {}), ...(typeof replyTo === "string" ? { replyTo } : {}) };
  return await addRow({ ...deps, state, row, cut });
}

/** `react`: a tapback on a row with words, read as production reads it; a turn only when production would run one. */
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
  const row = { id, eid, who: speaker.speaker, kind: "reaction", emoji, on: target.row.id, text: read.line, at, prod: false, ...(read.runs ? {} : { noted: true }) };
  return await addRow({ ...deps, state, row, turn: read.runs, cut });
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
 * `edit` and `unsend`: node `edit` on the change (`edits.js`), as the texting Worker asks it. `same` keeps nothing;
 * `turn` keeps a kind "edit" row with the new words and runs its turn; `withdraw` keeps a kind "unsend" row and a quiet
 * noted reply, no turn. The node's run is the row's first ledger entry, so the row shows it as a step.
 */
async function change(deps, state, { msgId, text, as }, verb, cut = null) {
  const found = changeable(state, msgId, as, verb);
  if (found.error) return refused(...found.error);
  if (verb === "edit" && (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT)) return refused(400, `text is 1 to ${MAX_TEXT} characters`);
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const about = state.meta.chat;
  const drafted = await draftConfig(deps.controlPlane, deps.token, about.versionId);
  if (drafted.error) return refused(...drafted.error);
  const node = await runEditNode({ config: drafted.config ?? null, kind: about.kind === "group" ? "group" : "one", change: verb, ...(verb === "edit" ? { words: text } : {}), earlier: wordsNow(state.rows, found.row) });
  if (node.to === "same") return json({ msgId: found.row.id, to: "same", why: node.why });
  const { at, eid, id } = newIds();
  const unsend = node.to === "withdraw";
  const row = { id, eid, who: found.row.who, kind: unsend ? "unsend" : "edit", on: found.row.id, text: unsend ? "" : text, at, prod: false, ...(unsend ? {} : { edited: true }) };
  const answer = await addRow({ ...deps, state, row, turn: !unsend, cut, before: node.entries, note: UNSENT_NOTE });
  if (answer.status !== 200) return answer;
  return json({ msgId: id, to: node.to, why: node.why });
}

/** A test text the caller may cut at: one of this test chat's own, never a real text it started from. */
function testRow(state, msgId) {
  const row = (state.rows ?? []).find((r) => r.id === msgId);
  if (!row) return { error: [404, "There is no such text in this test chat."] };
  if (row.prod) return { error: [400, "That is a real text: open the chat with base set to it to try from there."] };
  return { row };
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
  if (input.op === "open") return await open(env, controlPlane, token, who, input);

  if (typeof input.sandboxId !== "string" || !SANDBOX_ID.test(input.sandboxId)) return refused(400, "name the test chat: sandboxId");
  const stub = sandboxStub(env, who.userId, input.sandboxId);
  const state = await callSandbox(stub, "state", {});
  if (!state?.meta?.chat) return refused(404, "There is no such test chat (Reset or a day unused deletes one).");

  const deps = { env, ctx, controlPlane, token, who, stub, origin, runTurn };
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
      return json({ ok: true });
    default:
      return refused(400, "op is chats, sets, open, send, react, edit, unsend, retry, back, drop, reset or get");
  }
}
