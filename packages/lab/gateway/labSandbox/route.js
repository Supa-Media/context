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
 *  - `search { query, versionId?, graph?, only? }` → `{ query, main, draft, changed }`: one search of the caller's own
 *    workspaces on main's search config and on a draft's (`search.js`), each unrecorded, so a try-out is never a real search.
 *  - `shared` and `ledger { chatId, ... }`: the chats people shared with the developers and their history files, read
 *    only (`shared.js`); `open { source: "shared", chatId }` opens a test chat over one, run as its person.
 *  - `worlds` → `{ preview, slugs, workspaces }`: the workspaces a made-up chat's people can have roles in here
 *    (`worldLocal.js`): the preview's made-up ones, or on main the caller's own shared ones.
 *  - `open { source: "chat" | "set" | "maya" | "shared", chatId?, convId?, versionId?, base? }` → `{ sandboxId, people, rows }`:
 *    a real chat's texts so far (up to `base`, which is left out), or a Training or Dev conversation's (never the Test
 *    Set's), as the test chat's start; `maya` is the bench's Maya conversation.
 *  - `send { sandboxId, as?, text, pics?, replyTo? }` → `{ msgId }`: the text, as `as`, with up to 6 pictures
 *    (`[{ url, type?, name? }]`, https; `text` may then be empty) and as a reply to a row of this test chat, and its turn
 *    run in the background; `get` shows it.
 *    `tags`, `effect` and `app` add native tags, an effect, or another app's card, read into the words as a real
 *    text's are (`rich.js`); the row keeps them as `rich`.
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

import { createControlPlane } from "../fromGateway/controlPlane.js";
import { ONE_TO_ONE_CHAT } from "../fromGateway/agent_ledger.js";
import { loggedSteps, oneRowPerText, realLedger, realRow } from "./realChat.js";
import { saidTexts } from "../fromGateway/agent_sentOnItsOwn.js";
import { bearerToken } from "../fromGateway/session.js";
import { json } from "../fromGateway/http_responses.js";
import { callSandbox, carryWith, jobOutWith, SANDBOX_TTL_MS, sandboxStub, SEED_CHUNK } from "./object.js";
import { serveJobOut } from "./jobBox.js";
import { eventId, RUNNING_STALE_MS, stepsOf } from "./harness.js";
import { chatStepsOf, runTestText } from "./chatRun.js";
import { carryFrom, carryInObject, objectCarry, objectRun, runInObject } from "./crossRuns.js"; // a test chat's asks of other chats
import { draftFit, TEX_CONFIG } from "../fromGateway/agent_texConfig.js";
import { sharedChatOf, sharedLedger, sharedList } from "./shared.js";
import { intake } from "./intake.js";
import { richText } from "./rich.js";
import { inboundEvent, picsOf, reactionOf, STICKER_ROW, TAPBACK_OF, targetOf } from "./inbound.js";
import { lineOf, measuredLine, rowLine } from "./line.js";
import { addTex } from "./added.js";
import { sandboxAsset } from "./pages.js";
import { nightlyForReal, nightlyInTestChat } from "./nightlyRoute.js";
import { checkInTestChat } from "./checkin.js";
import { searchBenchForPerson, searchForPerson } from "./search.js";
import { forwardToPreview, openOnPreview } from "./preview.js";
import { conversationOf, conversationStart, handleOf, setsList } from "./conversations.js";
import { changePeople, makeWorld, startRows, WORLD_SOURCE, worldAbout, worldInput, worldSpeaker } from "./world.js";
import { localGroupKey, localPeople, localSession, worldPlace } from "./worldLocal.js";

export { oneRowPerText };

export const LAB_SANDBOX_PATH = "/tex-lab/sandbox";
/** A person's test texts a day, across all their test chats: each runs the real models. */
export const DAILY_SENDS = 200;
export const MAX_TEXT = 4_000;
const SANDBOX_ID = /^[0-9a-f]{16}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
/** The bench's Maya: her Dev conversation when the sets have one, else a fresh 1:1 (Dev2 removed it 2026-11-17). */
export const MAYA_CONVO = "maya-and-tex";

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
export async function open(env, controlPlane, token, who, input, origin) {
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
  } else if (source === WORLD_SOURCE) {
    return await openWorld(env, controlPlane, token, who, input, origin, drafted);
  } else return refused(400, 'source is "chat", "set", "maya", "shared" or "world"');

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
    rows = oneRowPerText(saidTexts(entries)).map((entry) => realRow(entry, kind)); // a text never said is no row
    history = entries.map(({ seq: _seq, ...entry }) => entry);
    people = (answer.people ?? []).filter((person) => person && typeof person.handle === "string");
  }
  const sandboxId = randomId();
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
    ...(conv !== null ? { convId: conv.id } : {}),
  };
  return await startChat(env, who, input, drafted, about, rows, history);
}

/**
 * A made-up group chat (`world.js`): on a preview its people are made there first; anywhere else they live only in the
 * test chat, with roles in the caller's own shared workspaces (`worldLocal.js`). Then it opens like any test chat.
 */
async function openWorld(env, controlPlane, token, who, input, origin, drafted) {
  const place = await worldPlace(controlPlane, token);
  if (place.error) return refused(...place.error);
  const asked = place.preview ? worldInput(input.world) : worldInput(input.world, place.slugs);
  if (asked.error) return refused(400, asked.error);
  const sandboxId = randomId();
  const line = measuredLine([]);
  const groupId = `lab-world-${sandboxId}`;
  const made = place.preview ? await makeWorld(controlPlane, token, { sandboxId, line: line.number, groupId, world: asked.world }) : { ...(await localPeople(asked.world.people)), groupKey: await localGroupKey(groupId) };
  if (made.error) return refused(...made.error);
  const world = place.preview ? asked.world : { ...asked.world, local: { slugs: place.slugs } };
  const about = { sandboxId, origin, line, source: WORLD_SOURCE, ...worldAbout({ sandboxId, made, world, groupId }) };
  const rows = startRows(asked.world, made.people, Date.now(), (at) => newIds(at));
  return await startChat(env, who, input, drafted, about, rows, []);
}

/** A new test chat's object, seeded with its rows and history, and listed for its person. */
async function startChat(env, who, input, drafted, base, rows, history) {
  const { sandboxId, source, chat, kind } = base;
  const group = kind === "group";
  const people = base.people;
  const stub = sandboxStub(env, who.userId, sandboxId);
  const about = {
    ...base,
    versionId: typeof input.versionId === "string" ? input.versionId : "main",
    config: drafted.config,
    ...(drafted.drawn ? { drawn: true } : {}),
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
  if (about.source === WORLD_SOURCE) return worldSpeaker(about, as);
  const speaker = typeof as === "string" && as.trim() !== "" ? as.trim().slice(0, 64) : (about.people ?? [])[0]?.handle ?? "someone";
  if (!HANDLE.test(speaker) && !/^[\p{L}\p{N} ._\-']{1,40}$/u.test(speaker)) return { error: [400, "as is a person's handle or a name"] };
  return { speaker };
}

/**
 * A test row into the chat, and its run through the chat object in the background: the object logs its event and
 * decides, as in production, whether it takes a turn (a tapback it only notes, an unsend, an edit that changed nothing
 * end quiet, their reply row saying what the object did). Every row is counted; asks of other chats run after it. */
async function addRow({ env, ctx, controlPlane, token, who, stub, state, row, origin, runTurn, graph, cut = null, also = [] }) {
  const about = state.meta.chat;
  // The draft as drawn now (unsaved edits) or as saved now, not as at open: a Lab edit since then is what runs next.
  const drafted = await draftConfig(controlPlane, token, about.versionId, graph, about.drawn === true ? about.config : undefined);
  if (drafted.error) return refused(...drafted.error);
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
  if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  // A shared chat's session is asked again on every text, so one no longer shared stops at once.
  // A made-up chat's session is the grant its own turn mints on the preview (`world.js`), never the caller's.
  // On main its session is the caller's own, narrowed to what its people's chat reaches (`worldLocal.js`).
  const answer = about.source === WORLD_SOURCE ? (about.world?.local ? await localSession(controlPlane, token, about) : { status: "ok", session: null, chat: null }) : await controlPlane.labSandbox(token, "session", { chat: about.chat, ...(about.shared === true ? { shared: true } : {}) });
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
    // A burst's texts are rows of their own, right behind it: the chat object takes them all before it looks (`chatRun.js`).
    for (const added of [row, ...also]) {
      await callSandbox(stub, "row.add", { row: added });
      // The text's event as the Worker logs it, unless the chat object the turn runs through logs it itself.
      const logged = typeof runTurn.logsText === "function" && runTurn.logsText(added);
      if (!logged) await callSandbox(stub, "ledger.append", { entries: [await inboundEvent({ about, row: added, rows: [...(state.rows ?? []), row, ...also] })], by: added.id });
    }
  } catch (error) {
    await callSandbox(stub, "release", { msgId: row.id }).catch(() => {});
    throw error;
  }
  // The run (turn, jobs, asks; `crossRuns.js` `runInObject`) is the object's unless this request waits: a Worker stops a
  // request's `waitUntil` 30 s after answering. It runs here only if the object refused it (a lost answer may be running).
  const [config, later] = [drafted.config ?? null, typeof ctx?.waitUntil === "function"];
  const carry = { env, controlPlane, token, who, origin, config, asker: { stub, about, sandboxId: about.sandboxId, replyId: `${row.id}r`, payload: answer.session, chat: answer.chat ?? null } };
  if (later && (await runInObject({ about, row }, carry)) !== "refused") return json({ msgId: row.id });
  const run = Promise.resolve(runTurn({ env, stub, about, row, payload: answer.session, token, config, origin, chat: answer.chat ?? null })).then((done) => (later ? carryInObject : carryFrom)(done, carry, { open, newRow: newIds, runTurn, max: DAILY_SENDS }));
  await (later ? ctx.waitUntil(run) : run);
  return json({ msgId: row.id });
}

/** What the nightly's ops (`nightlyRoute.js`) use of this route's own. */
const routeHelpers = () => ({ draftConfig, refused, view, newIds, DAILY_SENDS, indexStub, byOf, json, aboutOf, speakerOf, addRow });

/** A new test row's ids: its event id and the row id built from it. */
export const newIds = (at = Date.now(), eid = eventId(at)) => ({ at, eid, id: `t${eid.replace("-", "")}` });
// A job box's calls out (`jobBox.js`), answered in the test chat's object.
jobOutWith(serveJobOut);
carryWith((env, state, body, op) => (op === "text.run" ? objectRun : objectCarry)(env, state, body, async () => ({ open, newIds, runTurn: runTestText, max: DAILY_SENDS })));

/** The most texts one `send` lands together (`also`): a burst, as people send "say alpha", "say bravo" a second apart. */
export const MAX_ALSO = 4;

/**
 * `also`: texts that land right behind this one, before the chat object looks at any (Dev2, 2026-11-18: a burst
 * answered in one turn could not be tried in a test chat). Each `{ text, as? }`, words only; checked like `send`'s.
 */
function alsoRows(about, also, first) {
  if (also === undefined || also === null) return { rows: [] };
  if (!Array.isArray(also) || also.length === 0 || also.length > MAX_ALSO) return { error: [400, `also is 1 to ${MAX_ALSO} texts, each { text, as? }`] };
  const rows = [];
  for (const [index, item] of also.entries()) {
    const words = typeof item === "string" ? item : item?.text;
    if (typeof words !== "string" || words.trim() === "" || words.length > MAX_TEXT) return { error: [400, `each also text is 1 to ${MAX_TEXT} characters`] };
    const speaker = speakerOf(about, typeof item === "object" ? item?.as : undefined);
    if (speaker.error) return { error: speaker.error };
    const { at, eid, id } = newIds(first.at + index + 1);
    rows.push({ id, eid, who: speaker.speaker, text: words, at, prod: false, line: first.line, burst: first.id });
  }
  return { rows };
}

/** `send`, and `retry`'s second half: a text, with its pictures and the row it replies to, and its turn. */
async function send(deps, state, { as, text: typed = "", pics: given, replyTo, also, tags, effect, app }, cut = null) {
  if (typeof typed !== "string" || typed.length > MAX_TEXT) return refused(400, `text is at most ${MAX_TEXT} characters`);
  // Native tags, an effect, another app's card: read into the words by the Worker's own code (`rich.js`).
  const read = await richText({ text: typed, tags, effect, app });
  if (read.error) return refused(400, read.error);
  const { text, rich } = read;
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
  const row = { id, eid, who: speaker.speaker, text, at, prod: false, line: rowLine(lineOf(about)), ...(pics.length > 0 ? { pics } : {}), ...(typeof replyTo === "string" ? { replyTo } : {}), ...(rich ? { rich } : {}) };
  const burst = alsoRows(about, also, row);
  if (burst.error) return refused(...burst.error);
  return await addRow({ ...deps, state, row: burst.rows.length > 0 ? { ...row, also: burst.rows.map((r) => r.id) } : row, cut, also: burst.rows });
}

/** `react`: a tapback on a row with words, as Tex's line hands one over (noted or answered is the chat object's call); `sticker: true` sticks a made-up one. */
async function react(deps, state, { msgId, emoji, as, sticker }, cut = null) {
  if (sticker === true) emoji = STICKER_ROW;
  else if (typeof emoji !== "string" || !TAPBACK_OF[emoji]) return refused(400, `emoji is one of ${Object.keys(TAPBACK_OF).join(" ")}, or pass sticker: true`);
  const target = targetOf(state.rows, msgId, "tapped");
  if (target.error) return refused(...target.error);
  const about = state.meta.chat;
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const speaker = speakerOf(about, as);
  if (speaker.error) return refused(...speaker.error);
  const read = await reactionOf({ about, target: target.row, emoji, as: speaker.speaker, rows: state.rows });
  const { at, eid, id } = newIds();
  const row = { id, eid, who: speaker.speaker, kind: "reaction", emoji, on: target.row.id, text: read.line, at, prod: false, line: rowLine(lineOf(about)), ...(sticker === true ? { sticker: `lab-sticker-${id}` } : {}) };
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
      ...(state.meta.chat.remote ? { code: `#${state.meta.chat.remote.pr}` } : {}),
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
  if (input.op === "sets") {
    const listed = await setsList(controlPlane, token);
    return listed.error ? refused(...listed.error) : json(listed);
  }
  // `code: "#N"`: the test chat runs on pull request N's own preview, its code and its data (`preview.js`).
  if (input.op === "open") return (await openOnPreview({ env, controlPlane, token, who, input, origin, helpers: routeHelpers() })) ?? (await open(env, controlPlane, token, who, input, origin));
  if (input.op === "list") return json(await listOf(env, who.userId));
  if (input.op === "shared") return await sharedList(controlPlane, token);
  // The workspaces a made-up chat's people can have roles in here (`worldLocal.js`), for the Lab's setup.
  if (input.op === "worlds") {
    const place = await worldPlace(controlPlane, token);
    return place.error ? refused(...place.error) : json(place);
  }
  // A search try-out on the caller's own 1:1 (`search.js`): main's search config and a draft's, neither counted. No test chat.
  if (input.op === "search") return await searchForPerson({ env, controlPlane, token, who, origin, helpers: routeHelpers() }, input);
  // A kept bench asked on main's search config and a draft's, on the standing bench objects (`search.js`, `bench/run.js`).
  if (input.op === "search_bench") return await searchBenchForPerson({ env, ctx, controlPlane, token, helpers: routeHelpers() }, input);
  if (input.op === "ledger") return await sharedLedger(env, controlPlane, token, who, input);
  // Where the caller's own chats are answered, and moving one into the gateway before the rest (`intake.js`).
  if (input.op === "intake") return await intake(env, who, input, { controlPlane, token });
  // The nightly on the caller's own workspace, for real (`nightly.js`): no test chat, main or a saved draft only.
  if (input.op === "nightly" && input.real === true) return await nightlyForReal({ env, controlPlane, token, who, origin, helpers: routeHelpers() }, input);
  if (typeof input.sandboxId !== "string" || !SANDBOX_ID.test(input.sandboxId)) return refused(400, "name the test chat: sandboxId");
  const stub = sandboxStub(env, who.userId, input.sandboxId);
  // Asked first, making nothing: an id nobody opened gets no tables and no alarm (`object.js` `exists`).
  const kept = stub === null ? false : (await callSandbox(stub, "exists", {})).exists;
  const state = kept ? await callSandbox(stub, "state", {}) : null;
  if (!state?.meta?.chat) return refused(404, "There is no such test chat (Reset or a day unused deletes one).");

  // A test chat on a pull request's preview: every call is the preview's to answer (`preview.js`); Reset clears both.
  const forwarded = state.meta.chat.remote ? await forwardToPreview({ env, controlPlane, token, who, stub, state, input, helpers: routeHelpers() }) : null;
  if (forwarded !== null) return forwarded;
  const deps = { env, ctx, controlPlane, token, who, stub, origin, runTurn, graph: input.graph };
  if (["send", "react", "edit", "unsend", "retry", "use", "added"].includes(input.op)) {
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
    case "added": return await addTex({ ...deps, helpers: routeHelpers() }, state, input);
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
      if (row.kind === "joined") return await addTex({ ...deps, helpers: routeHelpers() }, before, { as: row.who }, row.id);
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
    // Who is in a made-up chat changes (`world.js`): a row the chat shows, and the next text's people.
    case "join":
    case "leave": {
      if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
      const changed = await changePeople({ controlPlane, token, about: state.meta.chat, input, newRow: () => newIds() });
      if (changed.error) return refused(...changed.error);
      await callSandbox(stub, "meta", { key: "chat", value: changed.chat });
      await callSandbox(stub, "row.add", { row: { ...changed.row, prod: false } });
      return json(view(await callSandbox(stub, "state", {})));
    }
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
    case "nightly":
      return await nightlyInTestChat({ ...deps, helpers: routeHelpers() }, state, input);
    // A check-in now, on the test chat's draft (`checkin.js`): its reads real, its writes in the test copy, its text a row.
    case "checkin":
      return await checkInTestChat({ ...deps, helpers: routeHelpers() }, state, input);
    case "page": {
      const asset = await sandboxAsset(env, who.userId, input.sandboxId, input.id);
      return asset === null ? refused(404, "There is no such page in this test chat.") : json(asset);
    }
    default:
      return refused(400, "op is chats, sets, shared, ledger, intake, list, open, search, send, react, edit, unsend, added, retry, back, drop, reset, get, page, about, use, read, nightly, checkin, join or leave");
  }
}
