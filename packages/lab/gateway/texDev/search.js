/**
 * `tex_dev` `search` (`tool.js`): one search try-out on a draft's search config next to main's, as text an AI reads
 * (the Lab's Search page runs the same op on `/tex-lab/sandbox`, `labSandbox/search.js`). A try-out is never a real
 * search: it is not counted and nothing about it is kept, and the answer says so.
 */

/** One side's ranked keys and its step times, as lines. */
function sideLines(side) {
  const hits = side.hits.length
    ? side.hits.map((hit, i) => `${i + 1}. ${hit.key}${hit.title ? ` — ${hit.title}` : ""}${hit.meaningOnly ? " (found by meaning)" : ""}`)
    : ["(no matches)"];
  const steps = side.steps.length ? side.steps.map((s) => `${s.node}${typeof s.notes === "number" ? ` ${s.notes} notes` : ""} ${s.ms} ms${s.ok ? "" : " (failed)"}`).join(" → ") : "(no steps logged)";
  return [...hits, `steps: ${steps}`, `searched: ${side.searched.join(", ") || "their own workspace"}`];
}

/** The try-out as text: main's ranked keys and the draft's (or that it has no search steps), then the settings that differ. */
export function searchText(answer, draft = null) {
  const lines = [`Search "${answer.query}": a try-out, not a real search (not counted, nothing kept).`, "", "main:", ...sideLines(answer.main)];
  if (draft !== null) {
    lines.push("", answer.draft === null ? `draft ${draft}: has no search steps, so it searched as main does.` : `draft ${draft}:`);
    if (answer.draft !== null) lines.push(...sideLines(answer.draft));
    lines.push("", answer.changed.length ? `Settings that differ from main: ${answer.changed.join(", ")}.` : "Settings that differ from main: none.");
  }
  return lines.join("\n");
}

const scoreLine = (s) => `right note first ${s.first}/${s.n} (${s.firstPct}%), top 5 ${s.top5}/${s.n} (${s.top5Pct}%), found ${s.found}/${s.n}, MRR ${s.mrr}, p50 ${s.p50Ms} ms${s.errors ? `, ${s.errors} errors` : ""}`;
const rankWord = (rank) => (rank === null ? "missed" : `#${rank}`);

/** `search_bench`'s answer as text: both scores, the cases whose rank moved, and the misses. */
export function searchBenchText(answer, draft = null) {
  if (Array.isArray(answer.plans)) return answer.plans.length ? ["Benches with kept cases:", ...answer.plans.map((p) => `- ${p.bench}: ${p.cases} cases, kept ${new Date(p.at).toISOString()}`)].join("\n") : "No bench has kept cases yet: an eval_run of a Search bench on main keeps them.";
  const lines = [`${answer.bench}: ${answer.main.n} cases in ${(answer.ms / 1000).toFixed(1)} s on the standing bench objects (cases kept ${new Date(answer.keptAt).toISOString()}${answer.commit ? ` from ${answer.commit.slice(0, 8)}` : ""}).`, "", `main: ${scoreLine(answer.main)}`];
  if (draft !== null) lines.push(answer.draft === null ? `draft ${draft}: has no search steps, so it searched as main does.` : `draft ${draft}: ${scoreLine(answer.draft)}`);
  if (answer.changed.length) lines.push("", `Rank moved (${answer.changed.length}), worst loss first:`, ...answer.changed.slice(0, 40).map((c) => `- ${c.id} "${c.query.slice(0, 120)}": ${rankWord(c.main)} -> ${rankWord(c.draft)}${c.draftTop?.length ? ` (draft top: ${c.draftTop.join(", ")})` : ""}`));
  if (answer.misses.length) lines.push("", `Not first (${answer.misses.length})${draft !== null && answer.draft ? " on the draft" : ""}:`, ...answer.misses.slice(0, 40).map((m) => `- ${m.id} "${m.query.slice(0, 120)}": ${rankWord(m.rank)}${m.error ? ` error: ${m.error}` : m.top.length ? `, top: ${m.top.join(", ")}` : ""}`));
  return lines.join("\n");
}
