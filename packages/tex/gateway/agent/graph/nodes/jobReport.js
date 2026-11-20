/**
 * A job reports, node `jobReport`, an input (`texNodeShelf.json` until a Lab draft wires `job -> jobReport`;
 * `../../jobReport.js`). A background job never texts the chat: the texting Worker hands what it would have said to a
 * new run of the chat itself (`event: "job_report"`), never part of the run that started the job (Dev2's generators
 * model, 2026-11-16; jobs as config step 7, 2026-11-17).
 *
 * It reads the Worker's report strictly and gives the run its fixed question (the gateway's own line, never the job's
 * words as the person's). No model and no reads; logged like every node.
 */
import { jobReportOf, jobReportQuestion } from "../../jobReport.js";

/** @param {{ jobReport: object }} input */
export async function jobReportNode(input) {
  const report = jobReportOf({ event: "job_report", jobReport: input?.jobReport }, { chatTurn: true, job: null });
  if (report === null) return { to: "refuse", why: "the report could not be read" };
  return { to: "report", report, question: jobReportQuestion(report) };
}
