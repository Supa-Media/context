/**
 * TURNS THE TEXTING WORKER QUEUES ITSELF, AND WHAT THE CHAT KEEPS OF THEM (Dev2, 2026-11-17: "there shouldn't be can't
 * run rows ... let's make sure everything can run"). A Dev conversation's trigger rows (`texSets.cjs` TRIGGERS: a
 * check-in, a routine, a job's report) run here the way production runs them, and the earlier ones are kept in the
 * chat's ledger the way production keeps them, so the Front door sees the history a real chat would have.
 *
 * Running one (`run.mjs` `converse`):
 *  - a group's routine: the routine's words in a note in the chat's home, and one turn of the chat, its writer's tag in
 *    the Worker's own words (`apps/agent/src/groupRoutines.ts` `chatRoutineMessage`, words in
 *    `packages/shared/src/groupRunQuestions.cjs`);
 *  - a group's check-in: the email lands in the writer's mailbox, shared with the chat (a group check-in reads only mail
 *    shared with the chat or sent to its address, so a "Gmail:" row means a shared mailbox: the bench's assumption),
 *    and one turn asked the Worker's check-in words (`chatLookQuestion`), with `group.mail` naming the mailbox;
 *  - a job's report: one turn with `event: "job_report"` and the report (`apps/agent/src/jobTexts.ts`), the job in the
 *    chat's `running` list as `chatJobs({ results: true })` lists it. The gateway asks its own question
 *    (`jobReport.js`).
 * None posts a text of theirs or covers one: the Worker keeps no inbound event for them (`queueByCode`).
 *
 * Keeping an earlier one (`world.mjs` `earlier`), with production's own writers:
 *  - a one-to-one check-in's text: a `note` under `checkInAbout` (`heartbeat.js` -> `appendConversation`), its email in
 *    the mailbox;
 *  - a one-to-one routine's text: the routine turn's `note` { routine, outcome } (`finishARoutine.js`), which the history
 *    shows only as `sentByItself` places it;
 *  - a one-to-one job's report: its `job` entry (`reportEntry`), then Tex's texts as the Worker posts them;
 *  - in a group, Tex's texts as the Worker's `say` posts them, covering nothing.
 * Tex's own tapbacks are left out, as production logs them only as a `react` step that no history draws.
 */

import { chatLookQuestion, chatRoutineQuestion, lastRanWords } from "../../../packages/shared/src/groupRunQuestions.cjs";
import { appendConversation } from "../src/agent/conversation.js";
import { checkInAbout } from "../src/agent/checkInTexts.js";
import { ledgerFor, ONE_TO_ONE_CHAT, wordsEntry } from "../src/agent/ledger.js";
import { reportEntry } from "../src/agent/workEntries.js";

/** Where a bench routine's words are kept: the person's own routines, or a group's home's. */
export const BENCH_ROUTINE = "routines/daily/bench-routine.md";
export const routinePath = (group) => (group ? `${group.home}/${BENCH_ROUTINE}` : `tex/${BENCH_ROUTINE}`);

/** A bench job's id, as the Worker names one (`jobs.ts`): letters, digits and hyphens. */
export const benchJobId = (n) => `bench-job-${n}`;

/**
 * A job's report as the Worker hands it to the chat's turn (`jobTexts.ts` `reportOf`): `{ id, title, state, texts }`.
 * `report` is a case's `- job reports:` value.
 */
export function jobReportOf(report, n = 1) {
  return { id: benchJobId(n), title: String(report.title), state: report.state, texts: [String(report.text)] };
}

/**
 * The job as the chat's `running` list shows it to the report's turn (`jobs.ts` `chatJobs` with `results`): started
 * `ago` ms before, and, once it ended, when and with what result.
 */
export function runningJob(report, now, ago = 11 * 60_000) {
  const ended = report.state !== "running";
  return { id: report.id, title: report.title, state: report.state, startedAt: now - ago, ...(ended ? { finishedAt: now, result: report.texts.join("\n\n") } : {}) };
}

/** The group turn's words for a routine at `path` or a check-in, as the Worker asks them, last run `since`. */
export const groupRoutineQuestion = (path, since, timeZone) => chatRoutineQuestion(path, lastRanWords(since, timeZone));
export const groupCheckInQuestion = (since, timeZone) => chatLookQuestion(since, lastRanWords(since, timeZone));

/**
 * Keep an earlier one-to-one trigger's answer as production does. `trigger` is `{ via, ... }` from the case's earlier
 * lines, `texts` Tex's texts after it, `at` when it went. Answers the Tex texts still to post as the Worker posts them
 * (a job report's), or [] when the note holds them.
 */
export async function keepOneToOne({ env, workspaceId, trigger, texts, at, turn }) {
  const ledger = ledgerFor(env, { person: workspaceId });
  if (ledger === null) throw new Error("the bench has no ledger for the person");
  const text = texts.join("\n\n");
  if (trigger.via === "checkin") {
    if (text !== "") await appendConversation({ texLedger: () => ledger }, "texts", checkInAbout({}), text, { at, entry: { turn } });
    return [];
  }
  if (trigger.via === "routine") {
    if (text !== "") await ledger.append(ONE_TO_ONE_CHAT, [wordsEntry("note", text, { turn, at, routine: routinePath(null), outcome: "answered" })]);
    return [];
  }
  if (trigger.via === "job") {
    await ledger.append(ONE_TO_ONE_CHAT, [reportEntry(jobReportOf(trigger.report), { turn, at })]);
    return texts;
  }
  throw new Error(`an earlier ${trigger.via} row can't be kept`);
}

/**
 * How a case that starts at a turn the Worker queues itself is asked, or null when it starts at a text: the words of
 * the turn (`message`), what `world.text` is told (`options`) and the chat's `running` list. A one-to-one check-in or
 * routine is not one: it runs on its own client (`run.mjs` `startedBy`).
 */
export async function byCodeStart(world, question, { running = null, now = Date.now() } = {}) {
  if (question.jobReport) {
    const report = jobReportOf(question.jobReport);
    return { message: String(question.jobReport.asked ?? ""), options: { byCode: true, cause: "job_report", event: { event: "job_report", jobReport: report } }, running: [...(running ?? []), runningJob(report, now)] };
  }
  if (!(question.checkinMail || question.checkinCalendar || question.routine)) return null;
  const chat = world.chatSide();
  if (chat.group === null) return null;
  if (question.routine) {
    await world.placeInHome(BENCH_ROUTINE, `${question.routine}\n`);
    return { message: groupRoutineQuestion(routinePath(chat.group), undefined, chat.timeZone), options: { byCode: true, cause: "routine" }, running };
  }
  if (question.checkinMail) world.mailArrives(question.checkinMail);
  if (question.checkinCalendar) world.calendarArrives(question.checkinCalendar);
  const mailbox = world.chatSide().mailbox;
  return { message: groupCheckInQuestion(now - 60 * 60_000, chat.timeZone), options: { byCode: true, cause: "check_in", groupMail: [{ handle: chat.handle, address: mailbox }] }, running };
}
