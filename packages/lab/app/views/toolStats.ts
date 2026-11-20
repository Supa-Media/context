/**
 * The Lab's Tools view helpers (pure, no React): the artifact's `readToolLog`
 * and `med`, and the live feed's rows turned into the same per-key shape the
 * table reads. The feed is `functions/texLabToolStats.ts` (`toolStats`).
 */

import type { LabGraph, LabNode } from "../types";

/** The steps that call Tex's tools: those that read the tool list, or that have a wire into the Tools step. */
export const toolUsers = (g: LabGraph): LabNode[] => g.nodes.filter((n) => n.ctx.includes("tools") || g.edges.some((e) => e.to === "tools" && e.from === n.id));

/** One tool's or one tool action's numbers: the shape the artifact's `toolStats` kept. */
export type ToolStat = { calls: number; ms: number[]; err: number; why: Record<string, number> };
/** Keyed by `tool` for a tool, `tool.action` for one of its actions. */
export type ToolStats = Record<string, ToolStat>;

/** One row of the live feed, as the Convex query returns it (`lib/adminFns/texToolStats.ts`). */
export type FeedRow = {
  key: string;
  tool: string;
  action: string | null;
  calls: number;
  errors: number;
  medianMs: number | null;
  why: Array<{ why: string; cause: string; count: number }>;
};
export type Feed = { days: number; truncated: boolean; turns: number; calls: number; failuresTotal: number; rows: FeedRow[]; rules?: ToolRules };

/** The middle sample of a list of durations (the artifact's `med`): `b[floor(n/2)]` of the sorted list. */
/** Rule 2's limit for one tool: its own budget when it has one. */
export function limitFor(r: { limit: number; limits?: Record<string, number> }, tool: string): number {
  return r.limits?.[tool] ?? r.limit;
}

export function med(a: number[]): number | null {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
}

/** Lines of a paste that parse as JSON; anything that does not parse is skipped. */
function jsonLines(txt: string): unknown[] {
  return txt
    .split(/\n+/)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The fields of one pasted entry that the count reads. */
type Entry = { kind?: unknown; name?: unknown; tool?: unknown; args?: { action?: unknown }; ms?: unknown; ok?: unknown; reason?: unknown; error?: unknown };

/** The tool entries of a pasted record: a JSON array, `{entries}` or `{ledger}`, or JSONL (one entry a line). */
function pasteRows(txt: string): unknown[] {
  try {
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j;
    if (j && typeof j === "object" && (j.entries || j.ledger)) return j.entries || j.ledger;
    return jsonLines(txt);
  } catch {
    return jsonLines(txt);
  }
}

/**
 * The artifact's `readToolLog`, on the text of the paste box. Counts each
 * `kind: "tool"` entry under its tool and under `tool.action`; `ok: false`
 * entries are errors, with their reason cut to 60 characters. `n` is how many
 * tool entries there were (0 means nothing usable was pasted).
 */
export function readToolLog(text: string): { stats: ToolStats; n: number } {
  const rows = pasteRows(text.trim());
  const stats: ToolStats = {};
  let n = 0;
  for (const r of rows as Array<Entry | null>) {
    if (r?.kind !== "tool") continue;
    const name = String(r.name || r.tool || "");
    if (!name) continue;
    n++;
    const act = String(r.args?.action || "");
    for (const k of [name, act ? `${name}.${act}` : null]) {
      if (!k) continue;
      const x = stats[k] || (stats[k] = { calls: 0, ms: [], err: 0, why: {} });
      x.calls++;
      if (Number(r.ms)) x.ms.push(Number(r.ms));
      if (r.ok === false) {
        x.err++;
        const w = String(r.reason || r.error || "failed").slice(0, 60);
        x.why[w] = (x.why[w] || 0) + 1;
      }
    }
  }
  return { stats, n };
}

/**
 * The live feed as the table's numbers: a tool's median is one sample, so
 * `med` gives it back; reasons are keyed by their text (two causes with the
 * same text add up).
 */
export function fromFeed(feed: Pick<Feed, "rows">): ToolStats {
  const out: ToolStats = {};
  for (const row of feed.rows) {
    const why: Record<string, number> = {};
    for (const w of row.why) why[w.why] = (why[w.why] || 0) + w.count;
    out[row.key] = { calls: row.calls, ms: row.medianMs != null ? [row.medianMs] : [], err: row.errors, why };
  }
  return out;
}

/** The four tool rules as production ran them (`toolRulesValidator` in `lib/adminFns/texToolStats.ts`). */
export type ToolRules = {
  limit: number;
  /** Tools with a budget of their own (send: 8,000), by name; the rest are held to `limit`. */
  limits?: Record<string, number>;
  turnsWithList: number;
  sizes: Array<{ tool: string; kind: string; chars: number }>;
  lists: { distinct: number; byKind: Array<{ kind: string; distinct: number; turns: number }>; toolForms: Array<{ tool: string; forms: number }>; mostInOneChat: number };
  notHeld: number;
  stateWrites: Array<{ file: string; count: number }>;
  errors: { actionable: number; partial: number; not: number; worst: Array<{ why: string; count: number; rating: string }> };
};

/** Each rule's pass line, read from the numbers alone so the Lab and tex_dev agree. */
export function ruleChecks(r: ToolRules): Array<{ rule: string; ok: boolean; line: string }> {
  const over = r.sizes.filter((s) => s.chars > limitFor(r, s.tool));
  const shells = r.stateWrites.reduce((n, s) => n + s.count, 0);
  const errs = r.errors.actionable + r.errors.partial + r.errors.not;
  const oneToOne = r.lists.byKind.filter((k) => k.kind !== "group").reduce((n, k) => Math.max(n, k.distinct), 0);
  return [
    { rule: "1. One tool list", ok: r.lists.mostInOneChat <= 1 && r.notHeld === 0, line: `${r.lists.distinct} different lists; one chat saw up to ${r.lists.mostInOneChat}${oneToOne ? ` (1:1 kinds up to ${oneToOne})` : ""}; ${r.notHeld} calls to a tool the turn didn't hold` },
    { rule: `2. Each tool under ${r.limit.toLocaleString()} chars${r.limits?.send ? ` (send ${r.limits.send.toLocaleString()})` : ""}`, ok: over.length === 0, line: over.length ? `${over.length} over: ${over.slice(0, 4).map((s) => `${s.tool} ${s.chars.toLocaleString()} (${s.kind})`).join(", ")}` : "all under" },
    { rule: "3. State through its own tools", ok: shells === 0, line: shells ? `${shells} plain writes to Tex's state files` : "no plain writes to state files" },
    { rule: "4. Errors say what to do next", ok: errs === 0 || r.errors.not === 0, line: errs ? `${Math.round((r.errors.actionable / errs) * 100)}% say what next, ${Math.round((r.errors.partial / errs) * 100)}% only list options, ${Math.round((r.errors.not / errs) * 100)}% don't` : "no failures" },
  ];
}
