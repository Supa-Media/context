/**
 * The replies note: what each setup actually said on the cases where the
 * setups' results differ, so Compare in the console can put live's reply
 * beside a candidate's with the rule it missed (board 20 of the AI tools
 * plan, 2026-10-16: a person cannot judge a prompt change from pass counts
 * alone).
 *
 * Bounded on purpose. Only cases where one setup passed every run and another
 * did not, at most `MAX_CASES` of them, one run per setup (the first failed
 * run, else the first), each text cut at `MAX_TEXT`. Never an answer id, and
 * never the key: the note says which setup wrote a reply, which the key says
 * for every answer, so it is written after judging and only for the cases
 * that differ. The fixtures are invented people, so a reply quotes nobody's
 * real notes, the same reason `failedGateLog` may print them.
 */

const MAX_CASES = 12;
const MAX_TEXT = 1200;
const MAX_TURNS = 6;

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const cut = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/**
 * The note's text, or null when no case differs. `judged` is the latest
 * "## Judged by" section's blocks; `answers` and `key` as `scoreFile` reads them.
 */
export function repliesNote({ key, judged, answers, questions, front, date }) {
  const answered = (row) => judged.has(row.id) && !judged.get(row.id).skipped;
  const runPassed = (row) => judged.get(row.id).verdicts.every((v) => v.kind === "judge" || v.pass);
  const setups = [...new Set(key.map((row) => row.setup))];
  const numbers = [...new Set(key.map((row) => row.question))].sort((a, b) => a - b);

  const differing = [];
  for (const n of numbers) {
    const bySetup = setups.map((setup) => ({ setup, runs: key.filter((row) => row.setup === setup && row.question === n && answered(row)).sort((a, b) => a.run - b.run) }));
    const outcomes = bySetup.filter((item) => item.runs.length > 0).map((item) => item.runs.every(runPassed));
    if (!(outcomes.includes(true) && outcomes.includes(false))) continue;
    differing.push({ n, bySetup });
    if (differing.length === MAX_CASES) break;
  }
  if (differing.length === 0) return null;

  const lines = ["---", "role: benchmark-replies", `job: ${front.job ?? "unknown"}`, `date: ${front.date ?? date}`];
  if (front.test) lines.push(`test: ${front.test}`);
  lines.push("---", "", `# ${front.job ?? "unknown"}, ${front.date ?? date}: replies that differ`, "");
  lines.push("Written by the AI Benchmark. For each case where one setup passed every run and another did not: one run per setup, the first that failed, else the first.", "");

  for (const { n, bySetup } of differing) {
    const q = questions.get(n);
    lines.push(`## ${n}. ${oneLine(q?.text ?? "")}`, "");
    for (const { setup, runs } of bySetup) {
      if (runs.length === 0) continue;
      const shown = runs.find((row) => !runPassed(row)) ?? runs[0];
      const passed = runPassed(shown);
      lines.push(`### ${setup} · run ${shown.run} of ${runs.length} · ${passed ? "passed" : "failed"}`, "");
      for (const v of judged.get(shown.id).verdicts) {
        if (!v.pass && v.kind !== "judge") lines.push(`- missed ${v.kind}: ${oneLine(v.line)}`);
      }
      const turns = (answers.get(shown.id)?.conversation ?? []).slice(0, MAX_TURNS);
      for (const turn of turns) lines.push(`> ${turn.from === "person" ? "Person" : "Reply"}: ${cut(oneLine(turn.text))}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Where a result's replies note goes, beside its scores note and the result itself. */
export const repliesName = (resultBase) => `${resultBase} replies.md`;
