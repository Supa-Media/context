/**
 * Replay's timeline by step (Dev2, 2026-11-14: "what determines what gets its own timeline here? the judge having its
 * own seems weird, what about helpers?"). Each turn of a moment, at its measured times (`realTimes.ts`), gives one row
 * per canvas step that ran, in the order they started, and each helper's row sits right under the step that waited
 * on it. A step's bar spans the helpers it waited on, as the canvas's time over it does.
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import type { LabGraph } from "../types";
import { realTimes, withReal } from "./realTimes";
import type { Bar, Moment } from "./replay";
import { fmtS, simulate } from "./sim";
import { G, node } from "./state";

export type StepRow = { id: string; label: string; helper: boolean; bars: Bar[] };

export function stepRows(m: Moment, entries: LedgerEntry[], g: LabGraph = G()): StepRow[] {
  const rows = new Map<string, StepRow>();
  const firstAt = new Map<string, number>();
  const callerOf = (id: string) => g.edges.find((e) => e.mode === "uses" && e.to === id && rows.has(e.from))?.from ?? null;
  const seen = new Set<string>();
  for (const b of m.lanes.Turn) {
    if (b.kind !== "turn" || !b.turn || b.zero === undefined || seen.has(b.turn)) continue;
    seen.add(b.turn);
    const real = realTimes(entries, b.turn);
    if (!real) continue;
    // From what started it: a text, or a check-in, a routine or a ping, whatever the canvas traced last.
    const sim = withReal(simulate(g, "own", null, real, m.from), real, g);
    for (const [id, t] of Object.entries(sim.T)) {
      // The wait in the queue is the Queue row; a start step is the Texts row's.
      const n = node(id, g);
      if (!n || id === "lanes" || n.kind === "input" || t.end - t.start <= 0) continue;
      const row = rows.get(id) ?? { id, label: n.label, helper: false, bars: [] };
      row.bars.push({ kind: "turn", start: Math.max(0, b.zero + t.start), end: Math.max(0, b.zero + t.end), label: fmtS(t.ms), turn: b.turn });
      rows.set(id, row);
      firstAt.set(id, Math.min(firstAt.get(id) ?? Infinity, b.zero + t.start));
    }
  }
  const order = [...rows.values()].sort((a, b) => (firstAt.get(a.id) ?? 0) - (firstAt.get(b.id) ?? 0));
  const out: StepRow[] = [];
  for (const r of order) {
    if (callerOf(r.id)) continue;
    out.push(r);
    // Its helpers under it, in the order they started.
    for (const h of order) if (callerOf(h.id) === r.id) out.push({ ...h, helper: true });
  }
  return out;
}

/** A bar in the compact timeline: named, since its track no longer is. */
export type PackedBar = Bar & { name: string };

/**
 * The compact timeline (Dev2, 2026-11-14: "a version where the tracks are not labeled but the items are, so we can fit
 * everything into the minimum number of tracks needed to show whats happening simultaneously"). Every bar of every row
 * goes into the first track free when it starts, so the number of tracks is the most things running at once. A bar
 * takes at least `minMs` of the track (what the eye can see) and keeps `gapMs` clear after it.
 */
export function packTracks(rows: Array<{ key: string; label: string; bars: Bar[] }>, minMs = 0, gapMs = 0): PackedBar[][] {
  const all: PackedBar[] = [];
  for (const r of rows)
    for (const b of r.bars) all.push({ ...b, name: r.key === "Texts" || r.key === "Sent" ? b.label : `${r.label} · ${b.label}` });
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const tracks: PackedBar[][] = [];
  const free: number[] = [];
  for (const b of all) {
    const until = Math.max(b.end, b.start + minMs) + gapMs;
    const i = free.findIndex((f) => f <= b.start);
    if (i < 0) {
      tracks.push([b]);
      free.push(until);
    } else {
      tracks[i].push(b);
      free[i] = until;
    }
  }
  return tracks;
}
