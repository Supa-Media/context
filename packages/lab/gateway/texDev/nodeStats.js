/**
 * `tex_dev` `node_stats`: HOW OFTEN EACH STEP OF TEX'S GRAPH RAN, OVER DAYS (2026-11-16: simplifying the graph by hand
 * judged "rarely fires" from four sampled turns, because `tool_stats` counts tools only).
 *
 * Read from the chats this person can probe (`probe.js` `chatsOf`: their own 1:1 with Tex and each group chat they
 * are in), the same history files `turn` and the Lab's Replay read: every step the graph runner logged (`step:
 * "node"`) and every step the texting Worker logged for the chat (`triage`, `decide`, `react`, ...), counted per
 * config node, with how many failed, the median and slowest time, and what each said most often (its `when`, `to` or
 * `outcome`). The steps of main's config that logged no run in the window are listed by name. Only what the log
 * shows ran is counted; nothing is estimated (Dev2, 2026-11-14).
 */

import { TEX_CONFIG } from "../fromGateway/agent_texConfig.js";
import { chatsOf, openChat } from "./probe.js";

const DAY_MS = 86_400_000;
export const MAX_DAYS = 30;
export const DEFAULT_DAYS = 7;
/** Entries one chat's read takes; a busier window says it was cut. */
const MAX_ENTRIES_PER_CHAT = 20_000;
const PAGE = 5_000;
/** Chats read at most, newest first as the picker lists them. */
const MAX_CHATS = 20;
/** The Worker's own step names, by the config node each belongs to (`labSandbox/chatRun.js` `STEP_NODE`). */
const WORKER_NODE = { text: "text", oldLine: "oldLine", triage: "triage", decide: "decide", recheck: "decide", lane: "lanes", react: "react", send: "send", edit: "edit", moveChat: "moveChat" };

const rec = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);

/** What a step said, as a word a wire's `when` would read: its `when`, its `to`, else its `outcome`. */
function saidOf(output) {
  const out = rec(output);
  if (!out) return null;
  if (Array.isArray(out.when) && out.when.length) return out.when.filter((w) => typeof w === "string").join("+");
  if (typeof out.when === "string") return out.when;
  if (typeof out.to === "string") return out.to;
  if (typeof out.outcome === "string") return out.outcome;
  return null;
}

/** A step entry as `{node, ok, ms, said, turn}`, or null for an entry that is no step's run. */
export function runOf(entry) {
  // The Queue logs no step of its own: a turn's reply keeps the Worker's wait for it (`timing.waitMs`), which Replay
  // draws as the Queue's time (`measured.ts` `realTimes`).
  if (entry?.kind === "reply") return Number.isFinite(entry.timing?.waitMs) ? { node: "lanes", ok: true, ms: entry.timing.waitMs, said: null, turn: entry.turn ?? null } : null;
  if (entry?.kind !== "step") return null;
  if (entry.step === "node" && typeof entry.name === "string" && entry.name !== "") {
    const out = rec(entry.output);
    const failed = entry.ok === false || out?.failed === true || out?.outcome === "failed";
    return { node: entry.name, ok: !failed, ms: Number.isFinite(entry.own) ? entry.own : Number.isFinite(entry.ms) ? entry.ms : null, said: saidOf(entry.output), turn: entry.turn ?? null };
  }
  // The texting Worker's own steps, kept as `step: { name, ok, ms, output }` (`packages/tex/worker/stepEvents.ts`).
  const st = rec(entry.step);
  if (st && typeof st.name === "string") {
    if (st.name === "send" && st.of === "delivery") return null; // Text them's delivery: counted with the gateway's send
    const node = WORKER_NODE[st.name];
    if (!node) return null;
    return { node, ok: st.ok !== false, ms: Number.isFinite(st.ms) ? st.ms : null, said: saidOf(st.output), turn: null };
  }
  // The same steps as a history file keeps them once written: `step: "<name>"` beside `output`, `ms`, `ok`. A `send`
  // kept this way is Text them's delivery, counted with the gateway's send node; `timing` is a stage, not a step.
  if (typeof entry.step === "string" && entry.step !== "send" && WORKER_NODE[entry.step]) {
    return { node: WORKER_NODE[entry.step], ok: entry.ok !== false, ms: Number.isFinite(entry.ms) ? entry.ms : null, said: saidOf(entry.output), turn: null };
  }
  return null;
}

const median = (list) => {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Counts per node from step entries, with the config's steps that logged no run. */
export function tally(entries, { config = TEX_CONFIG } = {}) {
  let replies = 0;
  const by = new Map();
  for (const entry of entries) {
    const run = runOf(entry);
    if (entry?.kind === "reply") replies += 1;
    if (!run) continue;
    const row = by.get(run.node) ?? { runs: 0, failed: 0, ms: [], said: new Map(), turns: new Set() };
    row.runs += 1;
    if (!run.ok) row.failed += 1;
    if (run.ms !== null) row.ms.push(run.ms);
    if (run.said) row.said.set(run.said, (row.said.get(run.said) ?? 0) + 1);
    if (run.turn) row.turns.add(run.turn);
    by.set(run.node, row);
  }
  const label = new Map(config.nodes.map((n) => [n.id, n.label ?? n.id]));
  const off = new Set(config.nodes.filter((n) => n.on === false).map((n) => n.id));
  const nodes = [...by.entries()]
    .map(([node, row]) => ({
      node,
      ...(label.get(node) && label.get(node) !== node ? { label: label.get(node) } : {}),
      ...(label.has(node) ? {} : { notInConfig: true }),
      runs: row.runs,
      ...(row.turns.size ? { turns: row.turns.size } : {}),
      ...(row.failed ? { failed: row.failed } : {}),
      medianMs: median(row.ms),
      maxMs: row.ms.length ? Math.max(...row.ms) : null,
      said: [...row.said.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([what, n]) => `${what} ×${n}`),
    }))
    .sort((a, b) => b.runs - a.runs || a.node.localeCompare(b.node));
  const never = config.nodes.filter((n) => !by.has(n.id)).map((n) => ({ node: n.id, ...(n.label && n.label !== n.id ? { label: n.label } : {}), ...(off.has(n.id) ? { off: true } : {}) }));
  return { replies, nodes, neverRan: never };
}

/** All of one chat's step and reply entries in the window, a page at a time, up to the cap. */
async function stepsOfChat(ledger, name, since, until) {
  const out = [];
  let after = null;
  for (;;) {
    const read = await ledger.read(name, { since, until, kinds: ["step", "reply"], limit: PAGE, ...(after === null ? {} : { after }) });
    const entries = read.entries ?? [];
    out.push(...entries);
    if (!Number.isSafeInteger(read.next) || out.length >= MAX_ENTRIES_PER_CHAT) return { entries: out, cut: Number.isSafeInteger(read.next) };
    after = read.next;
  }
}

/** `node_stats { days?, chat? }`: per step of the graph, how often it ran in this person's chats over the window. */
export async function nodeStatsAnswer(env, page, args = {}, { ledgerOf, now = Date.now() } = {}) {
  const days = Number.isFinite(args.days) && args.days > 0 ? Math.min(MAX_DAYS, Math.round(args.days)) : DEFAULT_DAYS;
  const until = now;
  const since = now - days * DAY_MS;
  const all = chatsOf(page).filter((c) => !c.shared);
  const picked = typeof args.chat === "string" && args.chat !== "" ? all.filter((c) => c.chat === args.chat) : all.slice(0, MAX_CHATS);
  if (picked.length === 0) return { error: "There is no such chat; chats lists yours." };
  const entries = [];
  const read = [];
  for (const c of picked) {
    const { place, ledger } = openChat(env, page, c.chat, ...(ledgerOf ? [ledgerOf] : []));
    if (ledger === null) continue;
    const got = await stepsOfChat(ledger, place.name, since, until);
    entries.push(...got.entries);
    read.push({ chat: c.chat, entries: got.entries.length, ...(got.cut ? { cut: true } : {}) });
  }
  return {
    days,
    chats: read,
    ...tally(entries),
    note: "Counts from your own chats' history files (what ran, never an estimate). A run is one logged step: a step that runs twice in a turn (the front door after a check) counts twice; turns says in how many turns it ran.",
  };
}
