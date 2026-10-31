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
 * Staying quiet is a flag, never a word that could be texted (self-reviews
 * fa3f7a and a0365e, 2026-10-31: "SKIP" stood as Tex's reply to three job
 * reports, two of them finished jobs whose results never reached the person).
 * `reportReply` reads the model's answer: a report still running may be met
 * with nothing (`quiet`, answered "" and kept in the history as
 * `QUIET_REPORT_LINE`), and a job that finished or stopped always gets a line:
 * the model's own words without the control word, or, when it said only that,
 * one plain status line with the job's result (`reportStatusLine`).
 */

import { saysQuiet } from "./checkInGuards.js";

const MAX_TITLE = 120;
const MAX_TEXTS = 12;
const MAX_TEXT = 4_000;
const STATES = new Set(["done", "failed", "running", "waiting", "stuck"]);
const MAX_RESULT = 600;
/** A whole answer that is only a word meant for us: SKIP, NOOP, NO_REPLY, QUIET, NONE (capitals), null. */
const CONTROL_ONLY = /^[\s\W]*(?:(?:skip(?:ped)?|no[ _-]?op|no[ _-]?reply|stay[ _-]?quiet|quiet|silent|null|undefined)|NONE)[\s\W]*$/i;
/** SKIP said at the start or the end of words that are otherwise a text (`checkInGuards.js`). */
const CONTROL_EDGE = /^\W*SKIP\b[\s.:;,!—-]*|[\s:;,—-]*\bSKIP[.!]?\s*$/g;

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
        : report.state === "waiting"
          ? "has ended waiting on them: your advisor checked it and only they can give what's needed. Ask them for exactly that in one line; " +
            "on their answer, start it again with a brief that says where it got to. It said this"
          : report.state === "stuck"
            ? "has ended stuck: your advisor checked it and found no way forward, or it ran out of time. Tell them plainly why, and what you'd try; it said this"
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
    (report.state === "running"
      ? "- If nothing in it is new to them (they already have it, or it repeats another job), answer exactly SKIP: nothing is texted."
      : "- It has ended, so they always get one line from you saying where it stands and what it found, even when that repeats what they have. Never answer SKIP.")
  );
}

/** Whether a reply is only a control word, never a text to anyone (NONE counts in capitals only: "None." answers a question). */
export function isControlWord(text) {
  const said = String(text ?? "").trim();
  return said !== "" && CONTROL_ONLY.test(said) && (!/^\W*none\W*$/i.test(said) || /NONE/.test(said));
}

/** What the chat's history keeps of a report the coordinator stayed quiet on, in place of any word. */
export const QUIET_REPORT_LINE = "(You texted them nothing: nothing in this running job's report was new to them.)";

/**
 * The reply a report's turn sends: `{ answer, quiet }`. `answer` is the
 * model's own unless it said nothing, or only a control word. Then a running
 * job's report is quiet, and an ended job's gets `reportStatusLine`.
 * Any other turn keeps its answer exactly.
 */
export function reportReply(report, answer) {
  if (report === null || report === undefined) return { answer, quiet: false };
  const said = String(answer ?? "").trim();
  const nothing = said === "" || isControlWord(said) || saysQuiet(said);
  if (report.state === "running") return nothing ? { answer: "", quiet: true } : { answer, quiet: false };
  const words = nothing ? said.replace(CONTROL_EDGE, "").trim() : said;
  return { answer: words === "" || isControlWord(words) ? reportStatusLine(report) : words, quiet: false };
}

/** One plain line for a job that ended: its state and title, then its own result, a link in it kept whole. */
export function reportStatusLine(report) {
  const head =
    report.state === "done"
      ? `Done: ${report.title}.`
      : report.state === "failed"
        ? `"${report.title}" stopped before it finished.`
        : report.state === "waiting"
          ? `"${report.title}" needs something from you to go on.`
          : `"${report.title}" got stuck.`;
  const result = resultOf(report.texts);
  return result === "" ? head : `${head} ${result}`;
}

function resultOf(texts) {
  const all = texts.filter((text) => !isControlWord(text)).join(" ").replace(/\s+/g, " ").trim();
  if (all.length <= MAX_RESULT) return all;
  const cut = all.slice(0, MAX_RESULT).replace(/\s+\S*$/, "");
  const link = /https?:\/\/\S+/.exec(all)?.[0];
  return `${cut}…${link !== undefined && !cut.includes(link) ? ` ${link}` : ""}`;
}
