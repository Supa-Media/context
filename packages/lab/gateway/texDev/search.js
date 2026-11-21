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
  const steps = side.steps.length ? side.steps.map((s) => `${s.node} ${s.ms} ms${s.ok ? "" : " (failed)"}`).join(" → ") : "(no steps logged)";
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
