/**
 * A background job's word reaching its chat (`jobs.ts`, `jobRun.ts`): never
 * texted straight in. Dev2, 2026-10-30: "if something is going in a background
 * task it should always report to the coordinator, no exceptions, the
 * coordinator should have complete authority over the background processes".
 *
 * The chat's inbox keeps the job's status as before, and whatever the job
 * would have said (its result, the line saying it couldn't finish, a sign-in
 * link on its way) is queued as a turn of the chat itself, with
 * `event: "job_report"` and the words as `jobReport`: in a 1:1 chat as a turn
 * this Worker asks for (`queueByCode`), in a group as its asker's tag, run the
 * way a chat routine's is (`queueGroupByCode`, `JOB_REPORT_PATH`). That turn,
 * the coordinator (`apps/mcp/src/agent/jobReport.js`), checks it against the
 * chat, and texts it, fixes it, starts the job again, steers what is still
 * running, or says nothing (SKIP). A job's pictures are not sent: the
 * coordinator draws a page's cover itself when it texts the link.
 *
 * Each report carries who asked and their words (`asked`), so a job the
 * coordinator starts again runs on the person's own words, as the first did.
 * One update is one report: offered again, it is already queued.
 */

import { queueByCode, type InboxStorage } from "./inbox";
import { queueGroupByCode, type GroupDeps } from "./groupInbox";
import { JOB_PREFIX, log, noteJobUpdate, type JobEntry, type JobReport, type JobUpdate } from "./jobs";
import { watchForSave } from "./vaultWatch";
import type { LineDeps } from "./line";

export type JobTextDeps = LineDeps & GroupDeps;

/** A group report's routine path: it runs as a routine's turn does (no ack, no binding, SKIP), and no run waits on it. */
export const JOB_REPORT_PATH = "(job report)";

/** What the coordinator is handed: the job's words, or null when it said nothing. */
export function reportOf(entry: JobEntry, update: JobUpdate): JobReport | null {
  const texts = (update.texts ?? []).filter((text) => text.trim() !== "");
  return texts.length === 0 ? null : { title: entry.title, state: update.state, texts };
}

/** `POST /job-update`: false only when the job is not this chat's. Throws when the report could not be queued, so the job offers it again. */
export async function jobUpdate(storage: InboxStorage, deps: JobTextDeps, update: JobUpdate): Promise<boolean> {
  const entry = await storage.get<JobEntry>(`${JOB_PREFIX}${update.id}`);
  if (entry === undefined) return false;
  const noted = await noteJobUpdate(storage, update, deps.now());
  if (noted === null) return false;
  // A link to save a login went out through the coordinator: watch for the save (`vaultWatch.ts`).
  if (!noted.quiet && update.vaultWatch !== undefined && noted.groupId === undefined) await watchForSave(storage, update.vaultWatch, deps.now());
  if (noted.quiet) return true;
  const report = reportOf(noted, update);
  if (report === null) return true;
  if (update.asked === undefined) {
    // Only a job's object from before reports carried their ask: never texted straight in, so it is logged and dropped.
    log("report_unaddressed", update.id);
    return true;
  }
  const eventId = `job-report:${update.id}:${update.pass ?? ""}:${update.first ?? 0}`;
  const queued =
    noted.groupId !== undefined && noted.line !== undefined
      ? (await queueGroupByCode(storage, groupReport(noted, update, report, eventId), deps.now())) === "queued"
      : noted.chatId !== undefined
        ? (await queueByCode(storage, phoneReport(noted, update, report, eventId), deps.now()), true)
        : false;
  if (!queued) throw new Error("job report not queued");
  log("reported", update.id);
  return true;
}

function phoneReport(entry: JobEntry, update: JobUpdate, report: JobReport, eventId: string) {
  return {
    kind: "message" as const,
    eventId,
    chatId: entry.chatId!,
    from: update.asked!.from,
    // Under the ask it answers; the gateway asks its own line, and these words only start the job again.
    messageId: entry.messageId ?? "",
    text: update.asked!.text,
    event: "job_report" as const,
    jobReport: report,
    ...(entry.channel === "simulator" ? { channel: "simulator" as const } : {}),
  };
}

function groupReport(entry: JobEntry, update: JobUpdate, report: JobReport, eventId: string) {
  return {
    kind: "group-message" as const,
    eventId,
    groupId: entry.groupId!,
    line: entry.line!,
    // Run as its asker's tag, only while they are still in the chat, as a routine is.
    from: update.asked!.from,
    participants: [],
    messageId: entry.messageId ?? "",
    text: update.asked!.text,
    routine: { runId: `job:${update.id}`, path: JOB_REPORT_PATH },
    jobReport: report,
  };
}
