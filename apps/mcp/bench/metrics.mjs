/**
 * FRONT DOOR COMPLETION METRICS (Dev2, 2026-11-26; `@supa projects/tex-quality/eval-metrics.md`, Area 1).
 *
 * A case line may name the metrics it measures, at its end:
 *
 *   - must call: calendar_event [metrics: task_completion_rate, cant_first_rate]
 *   - must not: tell her to move it herself [metrics: unnecessary_handback_rate]
 *
 * The tag is taken off before the line is read (`load.mjs`), so the judge and the record checks see the line as it
 * would be without it. A metric is scored per answered run, from the verdicts of the lines tagged with it:
 *
 *   - a "higher" metric (a share of runs that did the thing well) counts a run when every tagged line passed;
 *   - a "lower" metric (a share of runs that showed the failure, target 0%) counts a run when any tagged line failed.
 *
 * A run with no line tagged for a metric is not in that metric's count. Judge lines are never graded, so they carry
 * no tag. The rates are printed under the scores (`score.mjs` scoreSection) by their ids, as the metrics note names them.
 */

/** Every metric a line may name: its direction, and what one run counted in it means. */
export const METRICS = {
  task_completion_rate: { better: "higher", means: "every part of the ask finished" },
  cant_first_rate: { better: "lower", means: "said it can't or punted with the tools to do it" },
  unnecessary_handback_rate: { better: "lower", means: "handed the person a step Tex could do" },
  write_and_confirm_accuracy: { better: "higher", means: "the write happened and Tex said what it saved" },
  tool_attempt_before_punt_rate: { better: "higher", means: "checked the next source before saying it doesn't know" },
  turns_to_resolution_clean: { better: "higher", means: "resolved in one pass, no filler or needless permission ask" },
};

const fold = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

const TAG = /\s+\[metrics?:\s*([^\]]*)\]\s*$/;

/**
 * A case line without its metrics tag, and the ids it named: `{ line, ids }`. A line with no tag comes back as it
 * was with no ids. An id the table does not have, or an empty tag, throws, so a typo fails when the test is read.
 */
export function splitMetrics(line) {
  const m = TAG.exec(line);
  if (!m) return { line, ids: [] };
  const ids = m[1].split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error(`metrics tag on "${line.trim()}" names no metric`);
  for (const id of ids) if (!METRICS[id]) throw new Error(`metrics tag names "${id}", which is not one of ${Object.keys(METRICS).join(", ")}`);
  return { line: line.slice(0, m.index), ids: [...new Set(ids)] };
}

/** Each metric's rate per setup: `{ [setup]: { [id]: { runs, counted, rate } } }`, only for metrics a line names. */
export function metricRates({ key, judged, questions }) {
  const out = {};
  for (const row of key) {
    const q = questions.get(row.question);
    const block = judged.get(row.id);
    if (!q?.metrics?.length || !block || block.skipped) continue;
    const mine = (out[row.setup] ??= {});
    for (const id of new Set(q.metrics.flatMap((tag) => tag.ids))) {
      const tagged = q.metrics.filter((tag) => tag.ids.includes(id));
      // A result note keeps a line with its whitespace folded (`resultNote.mjs`), so lines are matched folded.
      const verdicts = tagged.map((tag) => block.verdicts.find((v) => v.kind === tag.kind && fold(v.line) === fold(tag.line))).filter(Boolean);
      if (verdicts.length === 0) continue;
      const counts = METRICS[id].better === "higher" ? verdicts.every((v) => v.pass) : verdicts.some((v) => !v.pass);
      const cell = (mine[id] ??= { runs: 0, counted: 0, rate: null });
      cell.runs += 1;
      if (counts) cell.counted += 1;
      cell.rate = (cell.counted / cell.runs) * 100;
    }
  }
  return out;
}

/** The metrics table under the scores, or no lines when no case names a metric. */
export function metricLines(rates, setups) {
  const ids = Object.keys(METRICS).filter((id) => setups.some((setup) => rates[setup]?.[id]));
  if (ids.length === 0) return [];
  const out = ["### Metrics", "", `| metric | better | ${setups.join(" | ")} |`, `| --- | --- |${setups.map(() => " --- |").join("")}`];
  for (const id of ids) {
    const cells = setups.map((setup) => {
      const cell = rates[setup]?.[id];
      return cell ? `${Number(cell.rate.toFixed(1))}% (${cell.counted} of ${cell.runs})` : "n/a";
    });
    out.push(`| \`${id}\` | ${METRICS[id].better} | ${cells.join(" | ")} |`);
  }
  out.push("");
  return out;
}
