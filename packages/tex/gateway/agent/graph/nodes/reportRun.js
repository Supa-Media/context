/**
 * New run, node `reportRun`, kind `run` (`texRunNodes.cjs`; Dev2, 2026-11-26: the wire "report to intake" was drawn and
 * nothing read it). Where a finished background job's report starts a new run of its chat is this step's one wire: the
 * texting Worker reads it before it queues the report (`worker/jobTexts.ts` `reportStartsAt`), and queues nothing when
 * the step wires to nowhere. The run the report starts then runs this node first (`texEntryPoint/readTheText.js`
 * `jobReportEvent`), so the log shows where the run was started and why, as every step's does. No model and no reads.
 */

/** @param {{ starts?: string | null }} input  the input step the config wires this step to, or null for nowhere */
export async function reportRunNode(input) {
  const at = typeof input?.starts === "string" && input.starts !== "" ? input.starts : null;
  return at === null ? { to: "nowhere", when: ["nowhere"] } : { to: "start", at, when: ["start"] };
}
