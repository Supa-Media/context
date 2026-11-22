/**
 * What the step panel's "Run details" card shows (Lab live sandbox, approved mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): one step as it ran for the test text picked in the test chat, and
 * which step is running now so the panel can follow it.
 *
 * The gateway logs a step when it finishes, so nothing here shows a step's output, calls, tokens or cost before then:
 * a running step is only "running" with how long it has been. A text being played back shows a step only as far as
 * the playback has come. The per-step fields past `{node, out, ms, ok}` (`in`, `think`, `calls`, `tokIn`, `cost` ...)
 * arrive from the gateway as the contract grows, so every one is read as optional.
 */

/** A tool call a step made: a read ran for real, a write landed in the sandbox, `prod` ran in prod (a real text). */
export type StepCall = { tool: string; kind: "read" | "write" | "prod"; ms: number; d: string };

/** The fields of a logged step past `{node, out, ms, ok}` (all optional: older rows have none). */
export type StepExtra = {
  id?: string;
  at?: number;
  in?: unknown;
  /** `out` as the gateway sent it when it was JSON, not text. */
  data?: unknown;
  think?: string;
  calls?: StepCall[];
  model?: string;
  effort?: string;
  tokIn?: number;
  tokOut?: number;
  cost?: number;
  bg?: boolean;
  parent?: string;
};
export type RunStep = { node: string; out: string; ms: number | null; ok?: boolean } & StepExtra;

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The optional fields of one step as the gateway sent it; only those that are there. */
export function stepExtra(x: Record<string, unknown>): StepExtra {
  const e: StepExtra = {};
  if (typeof x.id === "string") e.id = x.id;
  if (num(x.at) !== undefined) e.at = num(x.at);
  if (x.in !== undefined && x.in !== null) e.in = x.in;
  if (x.out !== undefined && x.out !== null && typeof x.out !== "string") e.data = x.out;
  if (typeof x.think === "string" && x.think) e.think = x.think;
  if (Array.isArray(x.calls))
    e.calls = x.calls
      .map(rec)
      .filter((c): c is Record<string, unknown> => c !== null && typeof c.tool === "string")
      .map((c) => ({ tool: String(c.tool), kind: c.kind === "write" ? "write" : c.kind === "prod" ? "prod" : "read", ms: num(c.ms) ?? 0, d: typeof c.d === "string" ? c.d : "" }));
  if (typeof x.model === "string" && x.model) e.model = x.model;
  if (typeof x.effort === "string" && x.effort) e.effort = x.effort;
  for (const k of ["tokIn", "tokOut", "cost"] as const) if (num(x[k]) !== undefined) e[k] = num(x[k]);
  if (x.bg === true) e.bg = true;
  if (typeof x.parent === "string") e.parent = x.parent;
  return e;
}

/** A step's output as an object when it is one (sent as JSON, or text that is a JSON object), else null. */
export function outObject(s: RunStep): Record<string, unknown> | null {
  const d = rec(s.data);
  if (d) return d;
  const t = s.out.trim();
  if (t.startsWith("{")) {
    try {
      return rec(JSON.parse(t));
    } catch {
      return null;
    }
  }
  return null;
}

/** "some_key" as "Some key". */
export const humanKey = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A value on one line: nested values flattened as "Key: value · Key: value", lists comma-joined. */
export function flat(v: unknown): string {
  if (Array.isArray(v)) return v.map(flat).join(", ");
  const o = rec(v);
  if (o) return Object.entries(o).map(([k, x]) => `${humanKey(k)}: ${flat(x)}`).join(" · ");
  return v === null || v === undefined ? "" : String(v);
}

export type Summary = {
  decided: string[];
  said: { kind: "Wrote" | "Sent"; text: string } | null;
  why: string;
  details: Array<[string, string]>;
};

/** The Summary tab's words for a step's output: what it decided, said and why, and the rest as plain rows. */
export function summaryOf(s: RunStep): Summary {
  const o = outObject(s) ?? {};
  const decided = o.when === undefined || o.when === null || o.when === "" ? [] : ([] as unknown[]).concat(o.when).map(String);
  const text = typeof o.sent === "string" && o.sent ? o.sent : typeof o.reply === "string" && o.reply ? o.reply : "";
  const said = text ? { kind: (typeof o.sent === "string" && o.sent ? "Sent" : "Wrote") as "Wrote" | "Sent", text } : null;
  const why = typeof o.why === "string" && o.why ? o.why : (s.think ?? "").split(/(?<=\.)\s/)[0];
  const details = Object.entries(o)
    .filter(([k]) => !["when", "reply", "sent", "why"].includes(k))
    .map(([k, v]): [string, string] => [humanKey(k), flat(v)]);
  return { decided, said, why, details };
}

/** "Tool calls · 3 real reads, 1 sandbox write", or "· 4 in prod" for a text that really ran. */
export function callsHeading(calls: StepCall[]): string {
  const n = (k: StepCall["kind"]) => calls.filter((c) => c.kind === k).length;
  if (calls.some((c) => c.kind === "prod")) return `Tool calls · ${calls.length} in prod`;
  const r = n("read");
  const w = n("write");
  return `Tool calls · ${r} real read${r === 1 ? "" : "s"}, ${w} test write${w === 1 ? "" : "s"}`;
}
