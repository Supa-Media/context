/**
 * Where a time sits on the timeline. A finished run is drawn from its first step to its end, and a stretch where
 * nothing ran for longer than GAP_MS is drawn GAP_DRAWN_MS wide with a break mark saying how long it was, so a turn whose
 * background steps ran minutes later still fills the lane (Dev2, 2026-11-16: a 301 s lane with its steps in the last
 * 15%). Playback crosses a folded stretch in GAP_DRAWN_MS of its own time. A text still running is drawn as it is: from
 * its arrival, on a scale that grows with the playback, nothing folded.
 */
import type { PlayRun } from "./playRun";
import { scaleOf } from "./sandboxRun";

export const GAP_MS = 3_000;
export const GAP_DRAWN_MS = 1_200;

/** A folded stretch: real times `from` to `to`, drawn at lane fraction `x` to `x2`. */
export type Gap = { from: number; to: number; x: number; x2: number };
export type TimeMap = {
  /** Lane fraction (0 to 1) of a real time. */
  x: (ms: number) => number;
  /** Real time at a lane fraction. */
  at: (f: number) => number;
  /** The drawn length of the lane, in ms of drawn time, for minimum bar widths. */
  span: number;
  /** Drawn time of a real time, and back: what playback advances in. */
  drawn: (ms: number) => number;
  real: (d: number) => number;
  gaps: Gap[];
};

const linear = (from: number, span: number): TimeMap => ({
  x: (ms) => Math.min(1, Math.max(0, (ms - from) / span)),
  at: (f) => from + Math.min(1, Math.max(0, f)) * span,
  span,
  drawn: (ms) => ms,
  real: (d) => d,
  gaps: [],
});

export function timeMap(r: PlayRun, t: number, live: boolean): TimeMap {
  if (live) return linear(0, scaleOf(r, t, live));
  const spans = [...r.steps.map((s) => [s.at, s.at + (s.ms ?? 0)] as const), ...r.texts.map((x) => [x.at, x.at] as const)].sort((a, b) => a[0] - b[0]);
  if (!spans.length) return linear(0, Math.max(1, r.total));
  // Busy stretches, merged across short pauses.
  const busy: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = busy[busy.length - 1];
    if (last && a - last[1] <= GAP_MS) last[1] = Math.max(last[1], b);
    else busy.push([a, b]);
  }
  const end = Math.max(r.total, busy[busy.length - 1][1]);
  busy[busy.length - 1][1] = end;
  const pad = Math.max(200, busy.reduce((n, [a, b]) => n + b - a, 0) * 0.02);
  const start = Math.max(0, busy[0][0] - pad);
  // Knots: real time -> drawn time, piecewise linear.
  const knots: Array<[number, number]> = [[start, 0]];
  let d = busy[0][0] - start;
  knots.push([busy[0][0], d]);
  const folds: Array<{ from: number; to: number; d: number }> = [];
  for (let i = 0; i < busy.length; i++) {
    d += busy[i][1] - busy[i][0];
    knots.push([busy[i][1], d]);
    const next = busy[i + 1];
    if (next) {
      folds.push({ from: busy[i][1], to: next[0], d });
      d += GAP_DRAWN_MS;
      knots.push([next[0], d]);
    }
  }
  d += pad;
  knots.push([end + pad, d]);
  const total = Math.max(1, d);
  const drawn = (ms: number) => {
    if (ms <= knots[0][0]) return 0;
    for (let i = 1; i < knots.length; i++) {
      const [r1, d1] = knots[i];
      if (ms <= r1) {
        const [r0, d0] = knots[i - 1];
        return r1 === r0 ? d1 : d0 + ((ms - r0) / (r1 - r0)) * (d1 - d0);
      }
    }
    return total;
  };
  const real = (dv: number) => {
    if (dv <= 0) return knots[0][0];
    for (let i = 1; i < knots.length; i++) {
      const [r1, d1] = knots[i];
      if (dv <= d1) {
        const [r0, d0] = knots[i - 1];
        return d1 === d0 ? r1 : r0 + ((dv - d0) / (d1 - d0)) * (r1 - r0);
      }
    }
    return knots[knots.length - 1][0];
  };
  return {
    x: (ms) => Math.min(1, Math.max(0, drawn(ms) / total)),
    at: (f) => real(Math.min(1, Math.max(0, f)) * total),
    span: total,
    drawn,
    real,
    gaps: folds.map((g) => ({
      from: g.from,
      to: g.to,
      x: g.d / total,
      x2: (g.d + GAP_DRAWN_MS) / total,
    })),
  };
}
