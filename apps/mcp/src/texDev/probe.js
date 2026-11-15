/**
 * `tex_dev` probing (Dev2, 2026-11-15: "replay this text ... what was taking so long, why did it do that, what node
 * failed, what tool calls failed ... what was the reasoning, what was the context that it loaded, what were the inputs
 * and outputs, the exact order different nodes were run"): a chat's turns, read from the chat's history file, the same
 * one the Lab's Replay and the Tex page's History read (`agent/ledger.js`, `http/texPage/ledger.js`).
 *
 * Which chats: the person's own one-to-one with Tex and each group chat they are in, decided by the control plane
 * exactly as for the Tex page (`texPage.pageForUser`). Only what the log shows ran is shown; nothing is estimated
 * (Dev2, 2026-11-14).
 */

import { ledgerFor, ONE_TO_ONE_CHAT } from "../agent/ledger.js";
import { chatOf, pickerOf } from "../http/texPage/page.js";
import { dayRange, ledgerView } from "../http/texPage/ledger.js";

const NEWEST = Number.MAX_SAFE_INTEGER;
/** Around a reply, the window a turn's own entries are read from. */
const BEFORE_MS = 20 * 60_000;
const AFTER_MS = 5 * 60_000;
/** Characters kept of each text field, unless `full`. */
export const CUT = 2_000;
export const FULL_CUT = 64_000;
const TURN_ID = /^[A-Za-z0-9_-]{1,64}$/;

function placeOf(chat) {
  if (chat?.owner?.person) return { owner: { person: chat.owner.person }, name: ONE_TO_ONE_CHAT };
  if (chat?.owner?.chat) return { owner: { chat: chat.owner.chat }, name: chat.owner.chat };
  return null;
}

/** A value with every long string cut to `max` characters, saying how long it was. */
export function cutDeep(value, max) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… [cut, ${value.length} characters]` : value;
  if (Array.isArray(value)) return value.map((v) => cutDeep(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutDeep(v, max)]));
  return value;
}

const when = (at, timeZone) => {
  try {
    return new Date(at).toLocaleString("en-US", { timeZone: timeZone || "UTC", dateStyle: "medium", timeStyle: "medium" });
  } catch {
    return new Date(at).toISOString();
  }
};

/** The chats this person can probe. */
export function chatsOf(page) {
  return pickerOf(page).map((c) => ({ chat: c.key, name: c.key === "me" ? "Just you and Tex" : c.name, ...(c.people ? { people: c.people } : {}) }));
}

function openChat(env, page, key, ledgerOf = ledgerFor) {
  const chat = chatOf(page, key ?? "me");
  const place = placeOf(chat);
  const ledger = place === null ? null : ledgerOf(env, place.owner);
  return { chat, place, ledger };
}

/**
 * A chat's recent turns, newest first: each reply with its turn id, when, how long, the model and Tex version, the
 * text it answered and what Tex said. `before` pages back (the `before` the last answer gave).
 */
export async function turnsOf(env, page, { chat: key, day, before } = {}, { ledgerOf = ledgerFor } = {}) {
  const { chat, place, ledger } = openChat(env, page, key, ledgerOf);
  if (ledger === null) return { chat: chat.key, turns: [] };
  const range = dayRange(day, page.timeZone);
  const read = await ledger.read(place.name, { before: Number.isSafeInteger(before) ? before : NEWEST, kinds: ["text", "reply"], limit: 300, jobs: false, ...(range ?? {}) });
  const entries = read.entries ?? [];
  const texts = entries.filter((e) => e.kind === "text");
  const turns = [];
  for (const reply of entries.filter((e) => e.kind === "reply" && typeof e.turn === "string")) {
    const said = texts.filter((t) => t.turn === reply.turn && t.from?.kind === "tex").map((t) => t.text).join("\n");
    const asked = texts.filter((t) => t.from?.kind === "person" && t.at <= reply.at).sort((a, b) => b.at - a.at)[0];
    turns.push({
      turn: reply.turn,
      at: reply.at,
      when: when(reply.at, page.timeZone),
      ms: reply.ms ?? null,
      ...(reply.model ? { model: reply.model } : {}),
      ...(reply.version ? { version: reply.version } : {}),
      ...(reply.clean === false ? { tainted: true } : {}),
      asked: asked ? cutDeep(asked.text ?? "", 300) : null,
      ...(asked?.from?.name ? { from: asked.from.name } : {}),
      said: cutDeep(said || reply.text || "", 300),
    });
  }
  return { chat: chat.key, turns, ...(Number.isSafeInteger(read.before) ? { before: read.before } : {}) };
}

const failedOf = (e) => e.ok === false || (e.kind === "judge" && e.went === false) || (e.kind === "tool" && (e.held || e.withheld));

/** A short label for one entry, as the order list shows it. */
function labelOf(e) {
  if (e.kind === "step") return e.step === "node" ? `node ${e.name}` : `step ${e.step}${e.name ? " " + e.name : ""}`;
  if (e.kind === "tool") return `tool ${e.name}`;
  if (e.kind === "judge") return `judge ${e.by ?? ""} round ${e.round ?? 1}`.trim();
  if (e.kind === "text") return `text from ${e.from?.kind ?? "?"}`;
  return e.kind;
}

/**
 * One turn exactly as its log shows it ran: every entry in the order written, each with its input and output (cut to
 * `CUT` characters unless `full`), and a summary of what took the time and what failed.
 */
export async function turnOf(env, page, { chat: key, turn, at, full = false } = {}, { ledgerOf = ledgerFor } = {}) {
  if (typeof turn !== "string" || !TURN_ID.test(turn)) return { error: "turn takes a turn id from turns" };
  const { chat, place, ledger } = openChat(env, page, key, ledgerOf);
  if (ledger === null) return { error: "this chat has no history file yet" };
  let around = Number.isSafeInteger(at) ? at : null;
  if (around === null) {
    const replies = await ledger.read(place.name, { before: NEWEST, kinds: ["reply"], limit: 2_000 });
    around = (replies.entries ?? []).find((e) => e.turn === turn)?.at ?? null;
  }
  if (around === null) return { error: `no turn ${turn} in this chat's recent history; pass the at that turns gave` };
  const read = await ledger.read(place.name, { since: around - BEFORE_MS, until: around + AFTER_MS, limit: 5_000 });
  const mine = (read.entries ?? []).filter((e) => e.turn === turn);
  if (mine.length === 0) return { error: `no entries for turn ${turn}` };
  const max = full === true ? FULL_CUT : CUT;
  const reply = mine.find((e) => e.kind === "reply") ?? null;
  const start = mine[0].at;
  const order = mine.map((e, i) => {
    const { v: _v, id: _id, turn: _turn, seq, ...rest } = e;
    return { n: i + 1, seq, label: labelOf(e), tPlusMs: e.at - start, ...(failedOf(e) ? { failed: true } : {}), ...cutDeep(rest, max) };
  });
  const timed = mine.filter((e) => Number.isFinite(e.ms) && e.kind !== "reply").map((e) => ({ what: labelOf(e), ms: e.ms }));
  timed.sort((a, b) => b.ms - a.ms);
  const failed = order.filter((e) => e.failed).map((e) => ({ n: e.n, what: e.label, why: e.reason ?? e.error ?? e.notice ?? (Array.isArray(e.failed) ? e.failed : null) ?? null }));
  return {
    chat: chat.key,
    turn,
    when: when(start, page.timeZone),
    summary: {
      entries: mine.length,
      ms: reply?.ms ?? null,
      ...(reply?.model ? { model: reply.model } : {}),
      ...(reply?.version ? { version: reply.version } : {}),
      ...(reply?.timing ? { timing: reply.timing } : {}),
      slowest: timed.slice(0, 8),
      failed,
      tools: mine.filter((e) => e.kind === "tool").map((e) => ({ name: e.name, ok: e.ok !== false, ms: e.ms ?? null })),
      nodes: mine.filter((e) => e.kind === "step" && e.step === "node").map((e) => e.name),
    },
    order,
  };
}

/** The chat's history file raw, 100 entries at a time, as the Tex page and the Lab read it. */
export async function entriesOf(env, page, body = {}) {
  const chat = chatOf(page, body.chat ?? "me");
  const answer = await ledgerView(env, page, chat, { view: "raw", kinds: body.kinds, day: body.day, after: body.after, before: body.before === undefined && body.after === undefined ? NEWEST : body.before, job: body.job });
  return { chat: chat.key, ...answer, entries: (answer.entries ?? []).map((e) => cutDeep(e, body.full === true ? FULL_CUT : CUT)) };
}
