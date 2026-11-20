/**
 * A test text in the sandbox as the one run shape every playback uses (`playRun.ts`; Lab live sandbox, approved by
 * Dev2 2026-11-16, mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5). Pure, with no React and no Lab state,
 * so `tex_dev` can read a text's timeline and path exactly as the Lab draws them.
 *
 * Times are what the gateway logged: a step's `at` (ms from the text's arrival) and `ms`. A row from before the
 * gateway sent `at` plays as the Lab always played it, each step starting when the one before it ended (at least
 * 1 ms each); nothing else is estimated. A step without `ms` while its text runs is still running.
 */
import type { PlayRun, PlayStep } from "./playRun";
import { causeRun } from "./playRun";

/** The fields of a sandbox row and step (`sandbox.ts`) this reads. */
export type RunStepIn = {
  node: string;
  ms: number | null;
  ok?: boolean;
  out?: string;
  id?: string;
  at?: number;
  data?: unknown;
  in?: unknown;
  think?: string;
  calls?: PlayStep["calls"];
  model?: string;
  effort?: string;
  tokIn?: number;
  tokOut?: number;
  cost?: number;
  bg?: boolean;
  parent?: string;
};
export type RunRowIn = { id: string; text?: string; at?: number; tex?: boolean; quiet?: boolean; reply?: string; cause?: string[]; steps?: RunStepIn[] };
/** The text running now, the step the gateway says is running, and the clock (epoch ms) to measure it against. */
export type RunLive = { running?: string | null; hot?: string | null; now?: number };

const msOf = (ms: number | null | undefined) => Math.max(ms ?? 0, 1);

/** One sandbox text as a run, or null when it has no steps and isn't running. */
export function sandboxRun(row: RunRowIn, rows: RunRowIn[], live: RunLive = {}): PlayRun | null {
  const running = !!live.running && live.running === row.id;
  const src = row.steps ?? [];
  if (!src.length && !running) return null;
  let cursor = 0;
  const steps: PlayStep[] = src.map((s, i) => {
    const at = typeof s.at === "number" && Number.isFinite(s.at) ? Math.max(0, s.at) : cursor;
    // Logged without a time: still running when its text is (and it was logged with `at`), else as the Lab always drew it.
    const ms = s.ms !== null && s.ms !== undefined ? Math.max(0, s.ms) : running && typeof s.at === "number" ? undefined : msOf(s.ms);
    cursor = Math.max(cursor, at + (ms ?? 0));
    const out: PlayStep = { id: s.id || `${row.id}.${i}`, node: s.node, at, ok: s.ok !== false };
    if (ms !== undefined) out.ms = ms;
    if (s.data !== undefined) out.out = s.data;
    else if (s.out !== undefined) out.out = s.out;
    for (const k of ["in", "think", "calls", "model", "effort", "tokIn", "tokOut", "cost", "parent"] as const) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
    if (s.bg) out.bg = true;
    return out;
  });
  // The step the gateway names as running, when no logged step stands for it yet: it starts once the last one ended.
  if (running && live.hot && !steps.some((s) => s.node === live.hot && s.ms === undefined)) steps.push({ id: `${row.id}.running`, node: live.hot, at: cursor, ok: true });
  const sentAt = row.at;
  const texts = rows
    .filter((x) => x.tex && x.reply === row.id && !x.quiet && (x.text ?? "") !== "")
    .map((x) => ({ rowId: x.id, at: typeof x.at === "number" && typeof sentAt === "number" ? Math.max(0, x.at - sentAt) : cursor }));
  const ends = steps.map((s) => s.at + (s.ms ?? 0));
  let total = Math.max(0, ...ends, ...texts.map((t) => t.at));
  // Still running: as long as it has run so far, by the clock, and never less than what it logged.
  if (running && typeof sentAt === "number" && typeof live.now === "number") total = Math.max(total, live.now - sentAt);
  return { id: row.id, steps, texts, total, running };
}

/**
 * The steps behind one of Tex's texts: its `cause` ids, found in the text whose run logged them (the one it replies
 * to first). Null when the gateway gave no `cause`: the Lab never guesses which steps led to a text.
 */
export function texCauseRun(texRowId: string, rows: RunRowIn[], live: RunLive = {}): PlayRun | null {
  const tex = rows.find((r) => r.id === texRowId);
  if (!tex?.tex || !tex.cause?.length) return null;
  const first = tex.cause[0];
  const order = [...rows.filter((r) => r.id === tex.reply), ...rows.filter((r) => r.id !== tex.reply && !r.tex)];
  for (const r of order) {
    if (!r.steps?.some((s, i) => (s.id || `${r.id}.${i}`) === first)) continue;
    const run = sandboxRun(r, rows, live);
    if (!run) return null;
    // Tex's text counts as delivered even when the run is still going.
    const withText = run.texts.some((t) => t.rowId === texRowId) ? run : { ...run, texts: [...run.texts, { rowId: texRowId, at: typeof tex.at === "number" && typeof r.at === "number" ? Math.max(0, tex.at - r.at) : run.total }] };
    return causeRun(withText, texRowId, tex.cause);
  }
  return null;
}

/** A run by its id: a text's (`<rowId>`) or the steps behind one of Tex's (`<rowId>#<texRowId>`). */
export function runById(id: string, rows: RunRowIn[], live: RunLive = {}): PlayRun | null {
  const k = id.indexOf("#");
  if (k >= 0) {
    const run = texCauseRun(id.slice(k + 1), rows, live);
    return run && run.id === id ? run : null;
  }
  const row = rows.find((r) => r.id === id && !r.tex);
  return row ? sandboxRun(row, rows, live) : null;
}

/** Where a run starts: its first step (the steps behind one of Tex's texts start part way through the turn). */
export const runStart = (r: PlayRun) => (r.steps.length ? Math.min(...r.steps.map((s) => s.at)) : 0);

/**
 * What the canvas lights at `t`: every step started by then, done (1) or how far through (0 to 1; a step still
 * running with no time yet is at 0), and the newest one still running, for the node panel to follow.
 */
export function litAt(r: PlayRun, t: number): { lit: Map<string, number>; running: string | null } {
  const lit = new Map<string, number>();
  let newest: PlayStep | null = null;
  for (const s of r.steps) {
    if (s.at > t) continue;
    const runs = s.ms === undefined || t < s.at + s.ms;
    if (runs) {
      // A step done earlier and running again shows as running.
      lit.set(s.node, s.ms === undefined ? 0 : Math.min(1, Math.max(0, (t - s.at) / Math.max(1, s.ms))));
      if (!newest || s.at >= newest.at) newest = s;
    } else if (!lit.has(s.node)) lit.set(s.node, 1);
  }
  return { lit, running: newest?.node ?? null };
}

/** The steps a playback at `t` has reached, each as far as it got: for the node panel's run details. */
export function stepsAt(r: PlayRun, t: number): Array<PlayStep & { running: boolean; elapsed: number }> {
  return r.steps.filter((s) => s.at <= t).map((s) => ({ ...s, running: s.ms === undefined || t < s.at + s.ms, elapsed: Math.max(0, Math.min(t, s.ms === undefined ? t : s.at + s.ms) - s.at) }));
}

/** The timeline's tracks: each step's node once, in the order it first started. */
export function trackOrder(r: PlayRun): string[] {
  const out: string[] = [];
  for (const s of [...r.steps].sort((a, b) => a.at - b.at)) if (!out.includes(s.node)) out.push(s.node);
  return out;
}

/** How the timeline fits its rows into the height it has: 20px rows, 12px rows, or steps sharing rows. */
export type Density = "full" | "compact" | "packed";
export const densityFor = (avail: number, rows: number): Density => (avail >= rows * 20 ? "full" : avail >= rows * 12 ? "compact" : "packed");

/**
 * The packed timeline: steps in the order they started, each in the first row free by then; a step holds at least
 * `minMs` of its row (what the eye can see) so a short one never hides under the next.
 */
export function packSteps(steps: PlayStep[], minMs: number, until = Infinity): PlayStep[][] {
  const rows: PlayStep[][] = [];
  const free: number[] = [];
  for (const s of [...steps].sort((a, b) => a.at - b.at)) {
    const end = s.at + Math.max(s.ms ?? Math.max(0, until - s.at), minMs);
    const i = free.findIndex((f) => f <= s.at);
    if (i < 0) {
      rows.push([s]);
      free.push(end);
    } else {
      rows[i].push(s);
      free[i] = end;
    }
  }
  return rows;
}

/** The timeline's scale: a text still running grows with the playback, so no total is drawn before it's known. */
export const scaleOf = (r: PlayRun, t: number, live: boolean) => (live ? Math.max(t * 1.15, 4000) : Math.max(1, r.total));
