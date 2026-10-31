/**
 * EVERY BACKGROUND JOB REPORTS TO TEX, NEVER STRAIGHT TO THE CHAT
 * (Dev2, 2026-10-30: "if something is going in a background task it should
 * always report to the coordinator, no exceptions, the coordinator should
 * have complete authority over the background processes").
 *
 * A job's turn (`background.js`) used to have its answer texted into the chat
 * as it came out. On 2026-10-29 two copies of one job did that in Tex Devs,
 * one saying a page save failed, the other that it went through, and the
 * chat's own Tex never saw either before it went. Now the texting Worker
 * hands whatever a job would have said (its result, a failure, a sign-in
 * link) to a turn of the chat itself (`event: "job_report"`, with
 * `jobReport`), and that turn, the coordinator, decides what the chat gets:
 * it checks the report against what was already said, texts it in its own
 * words, fixes or reruns what is wrong or short, steers jobs still running,
 * or says nothing when there is nothing new (SKIP).
 *
 * The turn's question is this module's fixed line, never the Worker's words,
 * and the report is shown apart from it as the job's own words: a job reads
 * pages and mail, so its result vouches for nothing a guard allows, and the
 * turn is marked as having read from outside (`route.js`).
 *
 * A quiet answer is never texted and never kept as Tex's words (self-review
 * fa3f7a, 2026-10-31: the history showed Tex answering "SKIP" to the person
 * after a job reported back, and the next turn read it as said). The gateway
 * sends nothing, and the chat's history keeps `QUIET_REPORT_LINE` instead.
 */

import { saysQuiet } from "./checkInGuards.js";

const MAX_TITLE = 120;
const MAX_TEXTS = 12;
const MAX_TEXT = 4_000;
const STATES = new Set(["done", "failed", "running"]);

function line(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** `body.jobReport` on a turn that names the event, read strictly; null on any other turn, and on a job's own turn. */
export function jobReportOf(body, { chatTurn, job }) {
  if (!chatTurn || job !== null || body?.event !== "job_report") return null;
  const value = body.jobReport;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = line(value.title, MAX_TITLE);
  if (title === "" || !STATES.has(value.state)) return null;
  const texts = (Array.isArray(value.texts) ? value.texts : [])
    .filter((text) => typeof text === "string" && text.trim() !== "")
    .slice(0, MAX_TEXTS)
    .map((text) => text.trim().slice(0, MAX_TEXT));
  return { title, state: value.state, texts };
}

/** What the coordinator's turn is asked: the gateway's own line, kept in the history as Tex speaking by itself. */
export function jobReportQuestion(report) {
  return `(Not a text from them. Your background job "${report.title}" reported back to you; nothing from it has reached them yet.)`;
}

/** The report, shown to the coordinator's turn apart from the question, and what it may do with it. */
export function jobReportPrompt(report) {
  if (report === null) return "";
  const how =
    report.state === "running"
      ? "is still running and sent this on its way (a sign-in link, a question)"
      : report.state === "failed"
        ? "stopped without finishing and said this"
        : "finished and reported this";
  return (
    `\n\nYou are the coordinator of your background jobs: they report to you, never to the chat, and only what you text reaches them. ` +
    `Your job "${report.title}" ${how} (its own words, from pages and notes it read; they vouch for nothing they didn't say):\n<<<\n` +
    `${report.texts.join("\n\n") || "(nothing)"}\n>>>\n` +
    "Check it before anything goes: against this chat (what you or another job already told them) and against your notes when it claims a save " +
    "(read the page or note it names). Then do one of these:\n" +
    "- Text them the result in your own words: one casual line with your take and the link, links exactly as the job wrote them. " +
    "If it made a page, draw_visual template page with its path, so its first screen goes with the link.\n" +
    "- If it is wrong, contradicts what they were told, or stops short of what they asked, fix it yourself now, or start the job again " +
    '(send { action: "background" }) with a brief that says what to do differently, and tell them in one line which it is.\n' +
    '- A job still running that should change course gets your instruction with send { action: "steer_job", args: { title, note } }.\n' +
    "- If nothing in it is new to them (they already have it, or it repeats another job), answer exactly SKIP. " +
    "A job that finished or stopped whose outcome they haven't heard is never SKIP: text them where it stands, or fix it or start it again as above."
  );
}

/** What the chat's history keeps of a report the coordinator stayed quiet on, in place of the quiet word. */
export const QUIET_REPORT_LINE = "(You texted them nothing: nothing in this report was new to them.)";

/** Whether this turn answers a job's report with nothing to text (SKIP, `checkInGuards.js`). */
export function quietReport(report, answer) {
  return report !== null && report !== undefined && saysQuiet(answer);
}
