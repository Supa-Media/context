/**
 * WHERE ONE TEX TURN'S TIME WENT, AS THE HISTORY DRAWS IT (Dev, 2026-11-03:
 * "I need to be able to look at an interaction with Tex and tell exactly why
 * things might be slow"; the artboard approved the same day, and "only
 * breakdowns for developers": owners and editors of @context-lc alone are given it, `useSeesTurnTiming`).
 *
 * The gateway keeps a `timing` block on each turn's `reply` entry
 * (`apps/mcp/src/agent/turnTiming.js`): the wait before it, each named step,
 * the router, each model round with its tokens, each tool, all measured from
 * the moment it read the text. The texts Tex sent are the chat's own entries,
 * with their times. This turns the two into a pill (the wait from the text
 * arriving to the first bubble out), a one-line verdict naming the slowest
 * step, and the waterfall's rows on one clock. Pure.
 */

import type { LedgerEntry } from "../page/texPageTypes";

/** At or past this, the pill is amber. */
export const SLOW_MS = 10_000;

interface Step { name: string; at: number; ms: number; state?: string }
interface Round { at: number; ms: number; model?: string; fallback?: boolean; ok?: boolean; retried?: boolean; cut?: boolean; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; said?: number; calls?: number }
interface Tool { at: number; ms: number; name: string; ok?: boolean; held?: boolean }
export interface TimingBlock { v: number; waitMs?: number; replyMs: number; steps: Step[]; router?: { at: number; ms: number; model?: string }; rounds: Round[]; tools: Tool[] }

/** What one turn holds for its timing: its reply, the texts it sent and its tool calls, as kept. */
export interface TurnTimingSource { reply: LedgerEntry; sent: LedgerEntry[]; tools: LedgerEntry[] }

export type RowKind = "queue" | "setup" | "router" | "model" | "tool" | "after" | "send";

export interface TimingRow {
  key: string;
  kind: RowKind;
  label: string;
  /** The step's own name, beside a plain label. */
  code?: string;
  /** From the text arriving, in ms. */
  start: number;
  ms: number;
  /** A second muted line: a model round's tokens. */
  detail?: string;
  /** "+0.5 s": a later bubble, after the one before. */
  after?: boolean;
  failed?: boolean;
  /** The single slowest step: the one solid bar. */
  slowest?: boolean;
  /** Getting ready's named steps, folded under it. */
  children?: TimingRow[];
}

export interface TurnTimingView {
  /** The text arriving to the first bubble out, or to the reply when nothing went out. */
  totalMs: number;
  slow: boolean;
  /** "Most of this wait was" / "The biggest part of this wait was", the slowest step, and the rest. */
  verdict: { lead: string; strong: string; rest: string };
  /** `Model 13.7 s · Getting ready 4.0 s · …`, largest first. */
  split: string;
  rows: TimingRow[];
  /** The axis's end, in ms. */
  spanMs: number;
  raw: TimingBlock;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The block as kept, or null when the reply has none (a turn from before 2026-11-03, or one that is not a texted turn). */
export function timingOf(reply: LedgerEntry): TimingBlock | null {
  const t = reply.timing as Partial<TimingBlock> | undefined;
  if (t === null || typeof t !== "object" || t.v !== 1 || !Array.isArray(t.steps) || !Array.isArray(t.rounds) || !Array.isArray(t.tools)) return null;
  return t as TimingBlock;
}

/** `0.8 s`, `21.8 s`, `40 ms`. */
export function seconds(ms: number): string {
  if (ms < 95) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** `anthropic/claude-haiku-5-5` → `Haiku 5.5`; anything else, its name without the provider. */
export function modelName(model: string | undefined): string {
  const bare = str(model).replace(/^[^/]*\//, "");
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(bare);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return bare;
}

/** What a step is, in words; its own name goes beside. */
const STEP_WORDS: Record<string, string> = {
  read_request: "Reading the text",
  history: "Loading the chat history",
  web_setup: "Web tools",
  pictures_setup: "Pictures",
  waiting_asks: "Open questions",
  tools_list: "Listing tools",
  setup: "Loading settings",
  learned_skills: "Learned skills",
  tex_notes: "Tex's notes",
  google_offer: "Google offer",
  allowed: "Checking limits",
  steer_begin: "Starting the turn",
  kept_files_again: "Earlier files",
  keep_sent_files: "Their files",
  hear_voice: "Voice messages",
  usage_record: "Recording usage",
  ledger_texts: "Saving the texts",
  learn_desk_keys: "Desk keys",
};

function stepLabel(name: string): string {
  const bare = name.replace(/^wait:/, "");
  return STEP_WORDS[bare] ?? bare.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

/** Output past the words (about four characters a token) and the calls is thinking: an estimate, said as one. */
function thinkingOf(r: Round): number {
  return Math.max(0, num(r.output) - Math.ceil(num(r.said) / 4) - num(r.calls) * 40);
}

/** `3,900 in · 41,000 cached · 620 out · said nothing, called 1 tool → ~600 thinking`. */
function roundDetail(r: Round): string | undefined {
  if (r.input === undefined && r.output === undefined) return r.fallback ? "failed, moved to the next model" : undefined;
  const said = num(r.said), calls = num(r.calls), out = num(r.output);
  const did = [said === 0 ? "said nothing" : `wrote ${thousands(said)} chars`, calls > 0 ? `called ${calls} tool${calls === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    const thinking = thinkingOf(r);
  return [`${thousands(num(r.input))} in`, `${thousands(num(r.cacheRead))} cached`, `${thousands(out)} out`, did].join(" · ") + (thinking >= 50 ? ` → ~${thousands(thinking)} thinking` : "");
}

/** A tool's argument in a few words: what it searched or read. */
function toolHint(entry: LedgerEntry | undefined): string {
  const args = entry?.args;
  if (args === null || typeof args !== "object") return "";
  for (const key of ["query", "path", "title", "url", "q"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      const words = value.replace(/\s+/g, " ").trim();
      return `“${words.length > 40 ? `${words.slice(0, 39)}…` : words}”`;
    }
  }
  return "";
}

const ORDINAL = ["first", "second", "third", "fourth", "fifth"];

/** How the verdict names the slowest step. */
function verdictName(row: TimingRow, rounds: number): string {
  if (row.kind === "model") {
    const n = Number(/\d+/.exec(row.label)?.[0] ?? 1);
    return rounds === 1 ? "one model call" : `the ${ORDINAL[n - 1] ?? `#${n}`} model call`;
  }
  if (row.kind === "queue") return "waiting in line before Tex started";
  if (row.kind === "send") return "sending the first text";
  if (row.kind === "tool") return `the ${row.code ?? "tool"} call`;
  return row.label.toLowerCase();
}

/**
 * The view of one turn's time, or null when its reply kept no timing. Rows run
 * on one clock from the text arriving (the gateway's start less its wait).
 */
export function turnTimingView({ reply, sent, tools }: TurnTimingSource): TurnTimingView | null {
  const t = timingOf(reply);
  if (t === null) return null;
  const wait = num(t.waitMs);
  // The gateway read the text `replyMs` before it wrote the reply.
  const gatewayAt = reply.at - num(t.replyMs);
  const arrived = gatewayAt - wait;
  const on = (at: number) => wait + num(at);
  const rows: TimingRow[] = [];
  if (t.waitMs !== undefined) rows.push({ key: "queue", kind: "queue", label: "Waiting in line", start: 0, ms: wait });

  const model = t.steps.find((s) => s.name === "model");
  const modelAt = model ? num(model.at) : Infinity;
  const before = t.steps.filter((s) => s.name !== "model" && num(s.at) < modelAt).sort((a, b) => num(a.at) - num(b.at));
  const after = t.steps.filter((s) => s.name !== "model" && num(s.at) >= modelAt);
  if (before.length > 0) {
    const children = before.map((s, i): TimingRow => ({ key: `setup:${i}:${s.name}`, kind: "setup", label: stepLabel(s.name), code: s.name, start: on(s.at), ms: num(s.ms), ...(s.state === "failed" ? { failed: true } : {}) }));
    const readyMs = Number.isFinite(modelAt) ? modelAt : Math.max(...before.map((s) => num(s.at) + num(s.ms)));
    rows.push({ key: "setup", kind: "setup", label: "Getting ready", start: wait, ms: readyMs, children });
  }

  const loop: TimingRow[] = [];
  if (t.router) loop.push({ key: "router", kind: "router", label: "Choosing a model", code: "router", start: on(t.router.at), ms: num(t.router.ms), ...(t.router.model ? { detail: `picked ${modelName(t.router.model)}` } : {}) });
  let round = 0;
  for (const [i, r] of t.rounds.entries()) {
    if (!r.fallback) round += 1;
    const detail = roundDetail(r);
    loop.push({ key: `round:${i}`, kind: "model", label: r.fallback ? "Model failed" : `Model, round ${round}`, code: modelName(r.model), start: on(r.at), ms: num(r.ms), ...(detail ? { detail } : {}), ...(r.ok === false || r.fallback ? { failed: true } : {}) });
  }
  const kept = tools.slice().sort((a, b) => a.at - b.at);
  const used = new Set<LedgerEntry>();
  for (const [i, tool] of t.tools.entries()) {
    const entry = kept.find((e) => !used.has(e) && str(e.name) === tool.name);
    if (entry) used.add(entry);
    const hint = toolHint(entry);
    loop.push({ key: `tool:${i}`, kind: "tool", label: hint ? `${tool.name} ${hint}` : tool.name, code: tool.name, start: on(tool.at), ms: num(tool.ms), ...(tool.ok === false ? { failed: true } : {}) });
  }
  rows.push(...loop.sort((a, b) => a.start - b.start));
  for (const [i, s] of after.entries()) rows.push({ key: `after:${i}:${s.name}`, kind: "after", label: stepLabel(s.name), code: s.name, start: on(s.at), ms: num(s.ms), ...(s.state === "failed" ? { failed: true } : {}) });

  const replyAt = reply.at - arrived;
  const bubbles = sent.map((e) => e.at - arrived).filter((at) => at >= replyAt - 1_000).sort((a, b) => a - b);
  let last = replyAt;
  for (const [i, at] of bubbles.entries()) {
    rows.push(i === 0 ? { key: "send:0", kind: "send", label: "First text out", start: replyAt, ms: Math.max(0, at - replyAt) } : { key: `send:${i}`, kind: "send", label: "Next text out", start: last, ms: Math.max(0, at - last), after: true });
    last = at;
  }
  const totalMs = Math.max(0, bubbles[0] ?? replyAt);

  // The slowest single step: the one solid bar, and the verdict's subject.
  const leaves = rows.flatMap((r) => (r.children ? r.children : [r])).filter((r) => !r.after);
  const slowest = leaves.reduce<TimingRow | null>((top, r) => (top === null || r.ms > top.ms ? r : top), null);
  if (slowest !== null) slowest.slowest = true;
  const share = slowest === null || totalMs === 0 ? 0 : slowest.ms / totalMs;
  const roundCount = t.rounds.filter((r) => !r.fallback).length;
  const slowRound = slowest?.kind === "model" ? t.rounds[Number(slowest.key.split(":")[1])] : undefined;
  const thought = slowRound === undefined ? 0 : thinkingOf(slowRound);
  const thinkingHeavy = slowRound !== undefined && thought >= 50 && thought >= num(slowRound.output) / 2;

  const sum = (kinds: RowKind[]) => rows.filter((r) => kinds.includes(r.kind) && !r.children).reduce((n, r) => n + r.ms, 0) + (kinds.includes("setup") ? rows.find((r) => r.key === "setup")?.ms ?? 0 : 0);
  const parts: [string, number][] = [
    ["Model", sum(["model", "router"])],
    ["Getting ready", sum(["setup"])],
    ["Tools", sum(["tool"])],
    ["In line", sum(["queue"])],
    ["Sending", sum(["send"])],
    ["After", sum(["after"])],
  ];
  const split = parts.filter(([, ms]) => ms >= 100).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${seconds(ms)}`).join(" · ");

  return {
    totalMs,
    slow: totalMs >= SLOW_MS,
    verdict: slowest === null
      ? { lead: "", strong: "", rest: `${seconds(totalMs)} in all.` }
      : {
          lead: share >= 0.5 ? "Most of this wait was " : "The biggest part of this wait was ",
          strong: `${verdictName(slowest, roundCount)}: ${seconds(slowest.ms)}`,
          rest: ` of ${seconds(totalMs)}${thinkingHeavy ? `, most of it thinking (~${thousands(thought)} tokens).` : "."}`,
        },
    split,
    rows,
    spanMs: Math.max(totalMs, ...rows.map((r) => r.start + r.ms), 1),
    raw: t,
  };
}
