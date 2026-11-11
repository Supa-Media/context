/**
 * TEX'S BASICS BEFORE THEIR OWN COUNTS BEGAN (Dev2, 2026-11-11: "we can't see past stats?").
 *
 * `tex_text_counts` and the `note` points began at `COUNTS_BEGAN`. For the part of a window before then, the basics
 * are read from what was already kept, each a little coarser, and the page says so:
 * - texts: `tex_text_timing` (`apps/agent/src/textTiming.ts`, since 2026-10-31), one point per text Tex answered,
 *   1:1 or group, with how many parts went out. Several texts answered together count once.
 * - people: `tex_entry` (`apps/mcp/src/agent/texEntryPoint.js`, since 2026-11-01), indexed by workspace: each
 *   personal workspace with a 1:1 turn is one person. Still written, so it is read over the whole window and the
 *   higher of it and the new count is kept, slot by slot: a person is never counted twice that way, only possibly
 *   under-counted where the two sources saw different people in one slot.
 * - notes created: `context_calls` workspace-object calls `ws.create` (since 2026-11-06), the one-call create path.
 *   Notes saved the long way and notes edited before counting began are not known.
 *
 * Numbers and fixed names only in the SQL, as in `texStats.ts`.
 */

/** When the basics' own counts went live in production (#3166's deploy). */
export const COUNTS_BEGAN = Date.UTC(2026, 10, 10, 23, 55);

export type BeforeNames = { timing: string; entry: string; calls: string };

export function beforeNames(staging: boolean): BeforeNames {
  const suffix = staging ? "_staging" : "";
  return { timing: `tex_text_timing${suffix}`, entry: `tex_entry${suffix}`, calls: `context_calls${suffix}` };
}

const seconds = (ms: number) => Math.floor(ms / 1000);
const between = (from: number, to: number) => `timestamp >= toDateTime(${seconds(from)}) AND timestamp < toDateTime(${seconds(to)})`;

/**
 * The older sources' SQL: texts and notes for `[from, min(to, COUNTS_BEGAN))`, people for the whole window. Null when
 * the window starts after counting began.
 */
export function beforeQueries(names: BeforeNames, from: number, to: number, bucket: "hour" | "day"): Record<string, string> | null {
  if (from >= COUNTS_BEGAN) return null;
  const early = between(from, Math.min(to, COUNTS_BEGAN));
  const whole = between(from, to);
  const slot = `toStartOfInterval(timestamp, INTERVAL '1' ${bucket === "hour" ? "HOUR" : "DAY"})`;
  const day = "toStartOfInterval(timestamp, INTERVAL '1' DAY)";
  const turn = "blob1 = 'gateway' AND blob2 = 'one'";
  return {
    texts: `SELECT ${slot} AS slot, blob1 AS chat, sum(_sample_interval) AS n, sumIf(double8 * _sample_interval, double8 > 0) AS parts FROM ${names.timing} WHERE ${early} GROUP BY slot, chat FORMAT JSON`,
    created: `SELECT ${slot} AS slot, sum(_sample_interval) AS n FROM ${names.calls} WHERE ${early} AND blob1 = 'object' AND blob2 = 'ws.create' GROUP BY slot FORMAT JSON`,
    peopleBySlot: `SELECT ${slot} AS slot, count(DISTINCT index1) AS n FROM ${names.entry} WHERE ${whole} AND ${turn} GROUP BY slot FORMAT JSON`,
    peopleByDay: `SELECT ${day} AS slot, count(DISTINCT index1) AS n FROM ${names.entry} WHERE ${whole} AND ${turn} GROUP BY slot FORMAT JSON`,
    peopleAll: `SELECT count(DISTINCT index1) AS n FROM ${names.entry} WHERE ${whole} AND ${turn} FORMAT JSON`,
  };
}
