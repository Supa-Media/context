/**
 * THE ADVISOR CHECKS EVERY STOP OF A BACKGROUND JOB (Dev2, 2026-10-31).
 *
 * A job's turn used to count any answer as done. The a16z application job
 * read the form's first page, answered "I'll begin with the sign-in", and was
 * marked done after 44 seconds; the chat then told Dev2 it was still running.
 * A phrase list (`stopsShort.js`) knew only research phrases.
 *
 * Now, when a job's turn ends, the advisor (`advisor.js`, the same model and
 * the same way of reading a turn) is handed the job's brief, its finish line
 * (`doneWhen`, written when the job was started), the person's latest texts
 * about it, and the whole turn: every tool call and its
 * result, and the answer. It says one of:
 *
 * - `done`: the finish line is met.
 * - `keep_going`: it isn't, and there is a way forward; its advice goes to the
 *   job's next part (`jobPrompt`), which starts on it.
 * - `waiting`: only the person can give what is needed (a code, a captcha,
 *   card details, a decision only they can make).
 * - `stuck`: it tried, and there is no way forward; it says why.
 *
 * The Worker acts on it (`apps/agent/src/jobRun.ts`): another part for
 * `keep_going`, until the job's limit (30 minutes or 10 parts), and the
 * chat's own turn is told the verdict and the advice, so "how's it going?"
 * gets "stuck on the sign-in, trying the email link instead".
 *
 * When the advisor can't be reached the old phrase check decides, as before.
 * Its spend is metered under its own model, as the advisor's is.
 */

import { adviseOnce, advisorThinking } from "./advisorRoles/core.js";
import { JOB_CHECK_PROMPT } from "./advisorRoles/jobCheck.js";
import { ADVISOR_KNOWS_MAIL } from "./advisorRoles/knowsMail.js";
import { withoutTag } from "./promptFence.js";

// Its instructions live in `advisorRoles/jobCheck.js`, beside the other roles' (`advisorRoles/core.js`).
export { ADVISOR_KNOWS_MAIL, JOB_CHECK_PROMPT };

export const VERDICTS = ["done", "keep_going", "waiting", "stuck"];
const MAX_ADVICE = 600;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_RESULT_CHARS = 8_000;
const TAGS = ["job", "tex_instructions", "transcript", "their_ask", "their_texts", "job_note_mail"];



const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const quoted = (value) => TAGS.reduce((text, tag) => withoutTag(tag, text), String(value ?? ""));

function line(message) {
  if (!message || typeof message !== "object") return "";
  const said = typeof message.text === "string" ? message.text.trim() : "";
  if (message.role === "tool") {
    const cut = said.length > MAX_RESULT_CHARS ? `${said.slice(0, MAX_RESULT_CHARS)}\n[cut]` : said;
    return `[result of ${message.name ?? "a tool"}${message.isError ? ", failed" : ""}]\n${quoted(cut) || "(no result)"}`;
  }
  const calls = Array.isArray(message.toolCalls)
    ? message.toolCalls.map((made) => `[Tex calls ${made?.name ?? "a tool"} ${quoted(JSON.stringify(made?.args ?? {}).slice(0, 2_000))}]`).join("\n")
    : "";
  return [said ? `${message.role === "assistant" ? "Tex" : "Them"}: ${quoted(said)}` : "", calls].filter(Boolean).join("\n");
}

/** What the advisor reads: the job, their texts about it, and the whole part. */
export function jobCheckBrief({ job, messages, answer, exhausted }) {
  let body = (Array.isArray(messages) ? messages : []).map(line).filter(Boolean).join("\n\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) body = `(earlier part left out)\n\n${body.slice(-MAX_TRANSCRIPT_CHARS)}`;
  const followUps = (job.followUps ?? []).map((text) => `- ${quoted(text)}`).join("\n");
  const asked = (job.asked ?? []).map((text) => `- ${quoted(text)}`).join("\n");
  return (
    `<job>\nTitle: ${quoted(job.title)}\nBrief: ${quoted(job.brief)}\nFinish line: ${quoted(job.doneWhen || "(none written: judge by the brief)")}\n` +
    `This was part ${job.attempt}.${job.advice ? `\nYour advice before this part: ${quoted(job.advice)}` : ""}\n</job>\n\n` +
    // Who is on its note's mail (`jobNote.js` `rosterText`), so the advice can hand work to them.
    (job.roster ? `<job_note_mail>\n${ADVISOR_KNOWS_MAIL}\nWhat the job was told:\n${quoted(clip(job.roster, 4_000))}\n</job_note_mail>\n\n` : "") +
    // Their own words that started it, so the check reads the whole ask, not the brief's paraphrase (`openAsk.js`; Nov Babies, 2026-11-11).
    (asked ? `<their_ask>\n${asked}\n</their_ask>\n\n` : "") +
    (followUps ? `<their_texts>\n${followUps}\n</their_texts>\n\n` : "") +
    `<transcript>\n${body || "(nothing)"}\n\nTex's last words: ${quoted(answer) || "(none)"}${exhausted ? "\n(It ran out of steps in this part.)" : ""}\n</transcript>\n\n` +
    "Is the job finished?"
  );
}

/** The advisor's two lines, read strictly; null when they don't say a verdict. */
export function readVerdict(text) {
  const said = String(text ?? "");
  const verdict = /^\s*VERDICT:\s*(done|keep_going|keep going|waiting|stuck)\b/im.exec(said)?.[1]?.toLowerCase().replace(" ", "_");
  if (!VERDICTS.includes(verdict)) return null;
  const advice = /^\s*ADVICE:\s*([\s\S]+)/im.exec(said)?.[1]?.replace(/\s+/g, " ").trim().slice(0, MAX_ADVICE) ?? "";
  return { verdict, advice };
}

/**
 * Ask the advisor about a job's part that just ended. Null when no model can
 * be asked, it fails, or its answer names no verdict: the caller keeps the old check.
 */
export async function checkJob({ job, live, answer, exhausted = false, model, effort, request, meter = async () => {} }) {
  if (job === null || typeof model !== "string" || typeof request !== "function") return null;
  let reply;
  try {
    // Its thinking comes back in words, for the chat's history only (`workEntries.js` `jobChecked`).
    reply = await adviseOnce({ request, model, effort, prompt: JOB_CHECK_PROMPT, role: "jobCheck", brief: jobCheckBrief({ job, messages: live?.messages, answer, exhausted }) });
  } catch {
    await meter(null, true, model, false);
    return null;
  }
  await meter(reply?.usage ?? null, false, model, false);
  const read = readVerdict(reply?.text);
  const thought = advisorThinking(reply);
  return read !== null && thought ? { ...read, thinking: thought } : read;
}

/**
 * The answer's fields for a job's part: the verdict and its advice,
 * `unfinished` when it should carry on, as the Worker reads it, and
 * `untrusted` when this part read from outside the workspace. Without a
 * verdict, the old phrase check (`unfinished`) decides.
 *
 * `untrusted` is how the turn's mark reaches the parts after this one. It dies
 * with the request, and the Worker keeps it on the job's run record instead
 * (`apps/agent/src/jobRun.ts`), so every later part is asked with `tainted`
 * (`background.js` `jobOf`). They need it because they are built on this
 * part's words: its draft, which the next part is told to build on, and the
 * advice above, which it is told to start on — both written by a model that
 * had just read the page. In the gateway that mark is what refuses a write to
 * `tex/skills/` (`learnedSkills.js`) and what leaves a delegation unvouched.
 */
export function jobFields(check, { exhausted, unfinished, untrusted = false }) {
  const base = { ...(exhausted ? { exhausted: true } : {}), ...(untrusted ? { untrusted: true } : {}) };
  if (check === null) return { ...base, ...(!exhausted && unfinished ? { unfinished: true } : {}) };
  return { ...base, verdict: check.verdict, ...(check.advice ? { advice: check.advice } : {}), ...(check.thinking ? { thinking: check.thinking } : {}), ...(!exhausted && check.verdict === "keep_going" ? { unfinished: true } : {}) };
}

/**
 * The answer's fields for any turn: a job's part is checked by the advisor
 * (`checkJob`), any other turn keeps `exhausted` and the phrase check's
 * `unfinished` as before. `check` is how the advisor is asked: Job check on the graph runner
 * (`graph/bridges.js` `jobCheckOnGraph`), `checkJob` itself in tests.
 */
export async function jobTurnFields(job, turn, { unfinished, untrusted = false, model, efforts, request, meter, check: runCheck = checkJob }) {
  const exhausted = turn.exhausted === true;
  if (job === null) return exhausted ? { exhausted: true } : unfinished ? { unfinished: true } : {};
  const check = await runCheck({ job, live: turn.live, answer: turn.answer, exhausted, model, effort: efforts?.[model], request, meter });
  // `idle`: this part called no tool at all. Two such parts in a row that still aren't done end the job stuck (`jobRun.ts`):
  // three restarted jobs answered "it's running again" eight times each on 2026-10-31.
  return { ...jobFields(check, { exhausted, unfinished, untrusted }), ...(!Array.isArray(turn.steps) || turn.steps.length === 0 ? { idle: true } : {}) };
}
