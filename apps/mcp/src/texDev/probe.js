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
/** Characters kept of each text field, unless `full`. */
export const CUT = 2_000;
export const FULL_CUT = 64_000;

function placeOf(chat) {
  if (chat?.owner?.person) return { owner: { person: chat.owner.person }, name: ONE_TO_ONE_CHAT };
  if (chat?.owner?.chat) return { owner: { chat: chat.owner.chat }, name: chat.owner.chat };
  return null;
}

/**
 * One of the person's own chats (`chatOf`), or one shared with the developers (`page.shared`, which `tool.js` reads
 * from the control plane on each call: `lib/texLabShared.ts`), by its Lab key: `u:<id>` for a 1:1, a group's key.
 * Read only: everything that opens a chat here only reads its history file.
 */
export function probedChat(page, key) {
  try {
    return chatOf(page, key);
  } catch (error) {
    const shared = (Array.isArray(page?.shared) ? page.shared : []).find((c) => c && c.key === key);
    if (!shared) throw error;
    const group = shared.kind === "group";
    const owner = group ? (typeof shared.owner?.chat === "string" ? { chat: shared.owner.chat } : null) : typeof shared.owner?.person === "string" ? { person: shared.owner.person } : null;
    if (owner === null) throw error;
    return { kind: group ? "group" : "me", key, name: String(shared.name ?? "Shared chat"), shared: true, owner, routines: [], picks: [], about: null, jobsChat: null };
  }
}

/** A value with every long string cut to `max` characters, saying how long it was. */
export function cutDeep(value, max) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… [cut, ${value.length} characters]` : value;
  if (Array.isArray(value)) return value.map((v) => cutDeep(v, max));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutDeep(v, max)]));
  return value;
}

export const when = (at, timeZone) => {
  try {
    return new Date(at).toLocaleString("en-US", { timeZone: timeZone || "UTC", dateStyle: "medium", timeStyle: "medium" });
  } catch {
    return new Date(at).toISOString();
  }
};

/** The chats this person can probe: their own, then the ones shared with the developers (read only). */
export function chatsOf(page) {
  const own = pickerOf(page).map((c) => ({ chat: c.key, name: c.key === "me" ? "Just you and Tex" : c.name, ...(c.people ? { people: c.people } : {}) }));
  const shared = (Array.isArray(page?.shared) ? page.shared : []).filter((c) => c && typeof c.key === "string").map((c) => ({ chat: c.key, name: String(c.name ?? "Shared chat"), shared: true, ...(c.kind === "group" ? { people: c.people } : {}), ...(Array.isArray(c.sharedBy) ? { sharedBy: c.sharedBy } : {}) }));
  return [...own, ...shared];
}

export function openChat(env, page, key, ledgerOf = ledgerFor) {
  const chat = probedChat(page, key ?? "me");
  const place = placeOf(chat);
  const ledger = place === null ? null : ledgerOf(env, place.owner);
  return { chat, place, ledger };
}

/** Turns one `turns` answer lists unless `limit` says otherwise, and the most it lists. */
export const TURNS_SHOWN = 20;
export const MAX_TURNS = 100;

/** A whole number of things to show: `value` when it is one, between 1 and `max`, else `fallback`. */
export const countOf = (value, fallback, max) => (Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback);

/**
 * A chat's recent turns, newest first: each reply with its turn id, when, how long, the model and Tex version, the
 * text it answered and what Tex said; 20 unless `limit` (at most 100). `before` pages back (the `before` the last
 * answer gave).
 */
export async function turnsOf(env, page, { chat: key, day, before, limit } = {}, { ledgerOf = ledgerFor } = {}) {
  const { chat, place, ledger } = openChat(env, page, key, ledgerOf);
  if (ledger === null) return { chat: chat.key, turns: [] };
  const range = dayRange(day, page.timeZone);
  const read = await ledger.read(place.name, { before: Number.isSafeInteger(before) ? before : NEWEST, kinds: ["text", "reply"], limit: 300, jobs: false, ...(range ?? {}) });
  const entries = read.entries ?? [];
  const texts = entries.filter((e) => e.kind === "text");
  const turns = [];
  const shown = countOf(limit, TURNS_SHOWN, MAX_TURNS);
  const replies = entries.filter((e) => e.kind === "reply" && typeof e.turn === "string");
  for (const reply of replies.slice(0, shown)) {
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
  // More replies than shown: the next page starts before the oldest one shown.
  const next = replies.length > shown ? replies[shown - 1].seq : read.before;
  return { chat: chat.key, turns, ...(Number.isSafeInteger(next) ? { before: next } : {}) };
}

export const failedOf = (e) => e.ok === false || (e.kind === "judge" && e.went === false) || (e.kind === "tool" && (e.held || e.withheld));

/** A short label for one entry, as the order list shows it. */
export function labelOf(e) {
  if (e.kind === "step") return e.step === "node" ? `node ${e.name}` : `step ${e.step}${e.name ? " " + e.name : ""}`;
  if (e.kind === "tool") return `tool ${e.name}`;
  if (e.kind === "judge") return `judge ${e.by ?? ""} round ${e.round ?? 1}`.trim();
  if (e.kind === "text") return `text from ${e.from?.kind ?? "?"}`;
  return e.kind;
}

/** Characters kept of each text field in a brief turn (the default): enough to read, never a whole prompt or thinking. */
export const BRIEF_CUT = 500;

/** A reply's timing in brief: each round's prompt as its module count and size (`prompt` shows the modules). */
function briefTiming(timing, steps = true) {
  if (!timing || typeof timing !== "object") return timing;
  const rounds = (Array.isArray(timing.rounds) ? timing.rounds : []).map((r) => {
    const modules = Array.isArray(r?.prompt?.modules) ? r.prompt.modules : null;
    if (!modules) return r;
    const { prompt: _p, ...rest } = r;
    return { ...rest, prompt: { modules: modules.length, chars: modules.reduce((a, m) => a + (Number.isFinite(m?.n) ? m.n : 0), 0) } };
  });
  const out = { ...timing, ...(Array.isArray(timing.rounds) ? { rounds } : {}) };
  // The gateway's own stage timings are also each a `step timing` entry; a brief turn names the slow ones in `slowest`.
  if (!steps && Array.isArray(timing.steps)) out.steps = `${timing.steps.length} stage timings; detail: "all" lists them`;
  return out;
}

/** The gateway's stage timings (`turnTiming.js`), each kept as an entry: a brief turn counts them instead of listing each. */
const isStageTiming = (e) => e.kind === "step" && e.step === "timing";

/**
 * One turn's entries (`mine`, in the order they ran) as `turn` answers them, and a summary of what took the time and
 * what failed. `detail`:
 *
 *  - "brief" (the default): every node, tool, judging, thinking and text in order, each string cut to `BRIEF_CUT`; the
 *    gateway's stage timings counted, not listed (`summary.slowest` names the slow ones). A busy turn's whole answer
 *    was 77,000 characters (2026-11-16), more than a model's tool answer holds; brief keeps it readable;
 *  - "all": every entry, the stage timings too, cut to `CUT`; `full: true` cuts at `FULL_CUT` instead.
 *
 * The reply's timing is in the summary once; its entry in the order says so rather than repeating it.
 */
export function turnFrom(mine, { timeZone, full = false, detail } = {}) {
  const all = full === true || detail === "all";
  const max = full === true ? FULL_CUT : all ? CUT : BRIEF_CUT;
  const reply = mine.find((e) => e.kind === "reply") ?? null;
  const start = mine[0].at;
  const numbered = mine.map((e, i) => ({ e, n: i + 1 }));
  const order = numbered
    .filter(({ e }) => all || !isStageTiming(e) || failedOf(e))
    .map(({ e, n }) => {
      const { v: _v, id: _id, turn: _turn, seq, ...rest } = e;
      if (e.kind === "reply" && rest.timing) rest.timing = "in summary.timing";
      return { n, seq, label: labelOf(e), tPlusMs: e.at - start, ...(failedOf(e) ? { failed: true } : {}), ...cutDeep(rest, max) };
    });
  const timed = mine.filter((e) => Number.isFinite(e.ms) && e.kind !== "reply").map((e) => ({ what: labelOf(e), ms: e.ms }));
  timed.sort((a, b) => b.ms - a.ms);
  const failed = order.filter((e) => e.failed).map((e) => ({ n: e.n, what: e.label, why: e.reason ?? e.error ?? e.notice ?? (Array.isArray(e.failed) ? e.failed : null) ?? null }));
  const hidden = mine.length - order.length;
  return {
    when: when(start, timeZone),
    summary: {
      entries: mine.length,
      ...(hidden > 0 ? { detail: `brief: ${hidden} stage timing entries not listed and strings cut at ${BRIEF_CUT}; detail: "all" (or full: true) gives every entry` } : {}),
      ms: reply?.ms ?? null,
      ...(reply?.model ? { model: reply.model } : {}),
      ...(reply?.version ? { version: reply.version } : {}),
      ...(reply?.timing ? { timing: full === true ? withoutWords(reply.timing) : briefTiming(reply.timing, all) } : {}),
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
  const chat = probedChat(page, body.chat ?? "me");
  const answer = await ledgerView(env, page, chat, { view: "raw", kinds: body.kinds, day: body.day, after: body.after, before: body.before === undefined && body.after === undefined ? NEWEST : body.before, job: body.job });
  return { chat: chat.key, ...answer, entries: (answer.entries ?? []).map((e) => cutDeep(e, body.full === true ? FULL_CUT : CUT)) };
}

/** The timing block without its kept prompt words (`turnTiming.js`): `prompt` is the action that shows them. */
function withoutWords(timing) {
  if (!Array.isArray(timing?.rounds)) return timing;
  return { ...timing, rounds: timing.rounds.map((round) => (round?.prompt?.words ? { ...round, prompt: { ...round.prompt, words: undefined } } : round)) };
}
