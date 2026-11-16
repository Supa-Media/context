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
 *  - `chats` → `{ chats: [{ chatId, name }] }`: their 1:1 (`me`) and each group chat they are in.
 *  - `open { source: "chat" | "set" | "maya", chatId?, convId?, versionId?, base? }` → `{ sandboxId, people, rows }`:
 *    a real chat's texts so far (up to `base`, which is left out), or a Training or Dev conversation's (never the Test
 *    Set's), as the test chat's start; `maya` is the bench's Maya conversation.
 *  - `send { sandboxId, as, text }` → `{ msgId }`: the text, as `as`, and its turn run in the background; `get` shows it.
 *  - `retry { sandboxId, msgId }` → `{ msgId }`: that text and everything after it dropped, and the text sent again.
 *  - `back { sandboxId, msgId }`: that text and its reply kept, everything later dropped.
 *  - `drop { sandboxId, msgId }`: that text and everything after it dropped.
 *  - `reset { sandboxId }`: the whole test chat deleted.
 *  - `get { sandboxId }` → `{ rows, writes, running }`.
 */

import REPO from "../../../../packages/shared/src/texSetsRepo.generated.json" with { type: "json" };
import { createControlPlane } from "../controlPlane.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../agent/ledger.js";
import { bearerToken } from "../session.js";
import { json } from "../http/responses.js";
import { callSandbox, sandboxStub } from "./object.js";
import { eventId, runSandboxTurn, textEvent, TURN_LIMIT_MS } from "./harness.js";

export const LAB_SANDBOX_PATH = "/tex-lab/sandbox";
/** A person's test texts a day, across all their test chats: each runs the real models. */
export const DAILY_SENDS = 200;
/** The real texts a test chat starts from. */
export const START_TEXTS = 200;
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

/** A real chat's texts before `base` (left out), oldest first, from the chat's ledger: read only. */
async function realTexts(env, owner, chat, base) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: START_TEXTS, jobs: false }).catch(() => null);
  const entries = (read?.entries ?? []).filter((entry) => entry?.kind === "text" && typeof entry.eid === "string" && typeof entry.text === "string").sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (typeof base !== "string" || base === "") return entries;
  const at = entries.findIndex((entry) => entry.eid === base);
  return at < 0 ? entries : entries.slice(0, at);
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
    rows = entries.map((entry) => realRow(entry, kind));
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
  await callSandbox(stub, "init", { about, rows, history });
  console.log(JSON.stringify({ event: "lab_sandbox_open", source, kind, rows: rows.length, draft: about.versionId !== "main" }));
  return json({ sandboxId, people, rows: rows.map(shown) });
}

/** The Lab's view: rows, writes, and the turn running now (a stale mark is no turn). */
function view(state) {
  const running = state.meta?.running;
  const live = running && typeof running === "object" && Date.now() - (running.at ?? 0) < TURN_LIMIT_MS + 2 * MINUTE;
  return { rows: (state.rows ?? []).map(shown), writes: state.writes ?? [], running: live ? { msgId: running.msgId, node: running.node ?? null } : null };
}

/** `send`, and `retry`'s second half: the text into the test chat's ledger and rows, its turn run in the background. */
async function send(env, ctx, controlPlane, token, who, stub, state, { as, text }, origin) {
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT) return refused(400, `text is 1 to ${MAX_TEXT} characters`);
  const about = state.meta.chat;
  if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
  const speaker = about.kind === "group" ? (typeof as === "string" && as.trim() !== "" ? as.trim().slice(0, 64) : (about.people ?? [])[0]?.handle ?? "someone") : "You";
  if (about.kind === "group" && !HANDLE.test(speaker) && !/^[\p{L}\p{N} ._\-']{1,40}$/u.test(speaker)) return refused(400, "as is a person's handle or a name");
  const day = new Date().toISOString().slice(0, 10);
  const counted = await callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key: `sends:${day}`, max: DAILY_SENDS });
  if (!counted.ok) return refused(429, `${DAILY_SENDS} test texts a day: try again tomorrow`);
  const answer = await controlPlane.labSandbox(token, "session", { chat: about.chat });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "This chat is no longer yours to test in.");
  const at = Date.now();
  const eid = eventId(at);
  const row = { id: `t${eid.replace("-", "")}`, eid, who: speaker, text, at, prod: false };
  await callSandbox(stub, "row.add", { row });
  await callSandbox(stub, "ledger.append", { entries: [textEvent({ eid, at, text, as: speaker, about })], by: row.id });
  await callSandbox(stub, "meta", { key: "running", value: { msgId: row.id, node: null, at } });
  const run = runSandboxTurn({ env, stub, about, row, payload: answer.session, token, config: about.config ?? null, origin });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run);
  else await run;
  return json({ msgId: row.id });
}

/** A test text the caller may cut at: one of this test chat's own, never a real text it started from. */
function testRow(state, msgId) {
  const row = (state.rows ?? []).find((r) => r.id === msgId);
  if (!row) return { error: [404, "There is no such text in this test chat."] };
  if (row.prod) return { error: [400, "That is a real text: open the chat with base set to it to try from there."] };
  return { row };
}

/** One `/tex-lab/sandbox` call. */
export async function handleLabSandbox(request, env, ctx, { origin = "https://context.lc" } = {}) {
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
    const groups = (Array.isArray(who.chats) ? who.chats : []).filter((chat) => CHAT_KEY.test(chat?.key ?? "")).map((chat) => ({ chatId: chat.key, name: String(chat.name ?? "Group chat") }));
    return json({ chats: [{ chatId: "me", name: "You and Tex" }, ...groups] });
  }
  if (input.op === "open") return await open(env, controlPlane, token, who, input);

  if (typeof input.sandboxId !== "string" || !SANDBOX_ID.test(input.sandboxId)) return refused(400, "name the test chat: sandboxId");
  const stub = sandboxStub(env, who.userId, input.sandboxId);
  const state = await callSandbox(stub, "state", {});
  if (!state?.meta?.chat) return refused(404, "There is no such test chat (Reset or a day unused deletes one).");

  switch (input.op) {
    case "get":
      return json(view(state));
    case "send":
      return await send(env, ctx, controlPlane, token, who, stub, state, input, origin);
    case "retry": {
      const found = testRow(state, input.msgId);
      if (found.error) return refused(...found.error);
      if (found.row.reply) return refused(400, "retry a text, not Tex's reply");
      if (view(state).running !== null) return refused(409, "a test text is still running: wait for its reply");
      await callSandbox(stub, "cut.from", { id: found.row.id });
      return await send(env, ctx, controlPlane, token, who, stub, await callSandbox(stub, "state", {}), { as: found.row.who, text: found.row.text }, origin);
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
      return refused(400, "op is chats, open, send, retry, back, drop, reset or get");
  }
}
