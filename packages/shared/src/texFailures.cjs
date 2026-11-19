/**
 * A Lab run's failing rows, read in one call (triage of a run took minutes, reading `runs { id }` (about 100 KB)
 * and then each conversation one by one; `tex_dev` `failures` answers the failing rows only, each with its ask, Tex's
 * reply, the tool calls and which failed, the gold label's must and never lines, and the judge's reasons).
 *
 * `parseDetail` reads a row's `detail`, the text `detailOf` builds in `scripts/tex-lab-run.mjs`: optional lines, in order,
 * "rounds:", "route:", "steps: tools <list> | ... | outcome: ...", then "must:" / "never:" lines (the judge's reason is
 * the last parenthesised group, which may hold parentheses of its own), "held:" lines, and "Tex: " with the reply, which
 * runs to the end of the text.
 *
 * Plain CommonJS with no imports, so the gateway and any reader of a run share these rules.
 */

const ASK_CHARS = 300;
const REPLY_CHARS = 500;
const GOLD_REPLY_CHARS = 300;
const REASON_CHARS = 240;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/** Text cut to `max` characters, "…" appended when cut. */
function cut(text, max) {
  const s = typeof text === "string" ? text : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** An object without its empty values: null, undefined, "", and empty arrays. */
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Splits "line (reason)" at the final balanced parenthesis group. The reason may hold parentheses of its own; a line
 * without a closing group has no reason.
 */
function splitReason(text) {
  if (!text.endsWith(")")) return { line: text, reason: null };
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ")") depth += 1;
    else if (text[i] === "(") {
      depth -= 1;
      if (depth === 0) return { line: text.slice(0, i).trimEnd(), reason: text.slice(i + 1, -1) };
    }
  }
  return { line: text, reason: null };
}

/** The steps line's tool list: `tools none`, or `tools name ok, name failed`; each item's first word is the tool. */
function toolsOf(first) {
  if (!first.startsWith("tools ")) return [];
  const list = first.slice("tools ".length).trim();
  if (list === "" || list === "none") return [];
  return list.split(", ").map((item) => ({ name: item.split(" ")[0], ok: !item.endsWith(" failed") }));
}

/**
 * A row's detail read back into its parts. Every part is optional; a detail with none of them reads as empty.
 * `steps` is the raw steps text (null when the row has no steps line), so a caller can tell "no tools" from "unknown".
 */
function parseDetail(detail) {
  const out = { rounds: null, route: null, steps: null, tools: [], outcome: null, misses: [], held: [], tex: "" };
  if (typeof detail !== "string" || detail === "") return out;
  const lines = detail.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("Tex:")) {
      out.tex = [line.slice("Tex:".length).replace(/^ /, ""), ...lines.slice(i + 1)].join("\n");
      break;
    }
    if (line.startsWith("rounds: ")) out.rounds = line.slice("rounds: ".length);
    else if (line.startsWith("route: ")) out.route = line.slice("route: ".length);
    else if (line.startsWith("steps: ")) {
      const steps = line.slice("steps: ".length);
      const segments = steps.split(" | ");
      out.steps = steps;
      out.tools = toolsOf(segments[0]);
      const outcome = segments.find((s) => s.startsWith("outcome: "));
      if (outcome !== undefined) out.outcome = outcome.slice("outcome: ".length);
    } else {
      const held = line.startsWith("held: ");
      const body = held ? line.slice("held: ".length) : line;
      const m = /^(must|never): (.*)$/.exec(body);
      if (m) {
        const { line: text, reason } = splitReason(m[2]);
        (held ? out.held : out.misses).push({ kind: m[1], line: text, reason });
      }
    }
  }
  return out;
}

/**
 * The rows a developer triages: not run (`ran: false`), not ambiguous, and either failed (`ok: false`) or a repeated row
 * that passed fewer of its repeats than it ran (a flaky row, 2 of 3, counts). Input order is kept.
 */
function failingRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => {
    if (!r || typeof r !== "object" || r.ran === false || r.ambiguous) return false;
    if (r.ok === false) return true;
    return Number.isInteger(r.runs) && r.runs > 1 && Number.isInteger(r.passes) && r.passes < r.runs;
  });
}

/** Front door rows first, then by conversation and message. */
function byTriage(a, b) {
  const fd = (a.node === "fd" ? 0 : 1) - (b.node === "fd" ? 0 : 1);
  if (fd !== 0) return fd;
  if (a.convId !== b.convId) return String(a.convId) < String(b.convId) ? -1 : 1;
  return (a.msgIndex ?? 0) - (b.msgIndex ?? 0);
}

/**
 * One failing row for the reader: the ask (from the conversation's message), Tex's reply, the tool calls and the
 * outcome from the detail, the gold label (fd: its must and never lines and reply; other nodes: want, and what it got),
 * and the judge's reasons. `convOf(id)` gives a conversation or null.
 */
function rowView(row, convOf) {
  const conv = convOf(row.convId);
  const msg = conv && Array.isArray(conv.msgs) ? conv.msgs[row.msgIndex] : null;
  const label = msg && msg.labels && typeof msg.labels === "object" ? msg.labels[row.node] || {} : {};
  const parsed = parseDetail(row.detail);
  const isFd = row.node === "fd";
  const gold = isFd
    ? compact({ must: Array.isArray(label.must) ? label.must : [], never: Array.isArray(label.never) ? label.never : [], reply: label.reply ? cut(label.reply, GOLD_REPLY_CHARS) : undefined })
    : compact({ want: row.want });
  const tools = parsed.steps === null ? undefined : parsed.tools.length === 0 ? "none" : parsed.tools.map((t) => (t.ok ? t.name : `${t.name} ✗`)).join(", ");
  const repeated = Number.isInteger(row.runs) && row.runs > 1;
  return compact({
    conv: row.convId,
    msg: row.msgIndex,
    node: row.node,
    passes: repeated ? `${row.passes ?? 0}/${row.runs}` : null,
    ok: row.ok,
    ask: msg ? compact({ who: msg.who, via: msg.via, text: cut(msg.text, ASK_CHARS) }) : undefined,
    reply: parsed.tex ? cut(parsed.tex, REPLY_CHARS) : undefined,
    tools,
    outcome: parsed.outcome ?? undefined,
    gold,
    got: !isFd && row.got !== undefined ? row.got : undefined,
    judge: parsed.misses.map((m) => `${m.kind}: ${m.line}${m.reason ? ` — ${cut(m.reason, REASON_CHARS)}` : ""}`),
  });
}

/**
 * The failure view of one run. `opts`: `node` (only that node's rows), `conv` (only that conversation), `limit` (default
 * 60, at most 200). `count` is every failing row the filters keep; `shown` is how many this answer holds.
 */
function failureView(run, convOf, opts = {}) {
  const results = run && run.results && typeof run.results === "object" ? run.results : {};
  const rows = failingRows(results.rows).filter((r) => (!opts.node || r.node === opts.node) && (!opts.conv || r.convId === opts.conv));
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, MAX_LIMIT) : DEFAULT_LIMIT;
  const shownRows = rows.slice().sort(byTriage).slice(0, limit);
  return {
    run: compact({
      id: run?.id,
      set: run?.set,
      repeats: run?.repeats,
      commit: run?.commit,
      score: results.score ?? null,
      pass: results.pass,
      total: results.total,
    }),
    count: rows.length,
    shown: shownRows.length,
    rows: shownRows.map((r) => rowView(r, convOf)),
    ambiguous: Array.isArray(results.ambiguous) ? results.ambiguous : [],
  };
}

module.exports = { parseDetail, failingRows, failureView, cut };
