/**
 * A background job's word reaching its chat (`jobs.ts`, `jobRun.ts`): the
 * chat's inbox keeps the status and texts what the job wrote, under the ask it
 * came from, so the result reads as the answer to it. Texts are counted per
 * job (`sent`), so an update offered again repeats none of them on a line
 * with no idempotency key.
 */

import { lineFor, type LineDeps } from "./line";
import { record } from "./simulator";
import { rememberText } from "./threads";
import { groupJobUpdate, type GroupDeps } from "./groupInbox";
import { JOB_PREFIX, noteJobSent, noteJobUpdate, type JobEntry, type JobUpdate } from "./jobs";
import type { InboxStorage } from "./inbox";
import { watchForSave } from "./vaultWatch";

export type JobTextDeps = LineDeps & GroupDeps;

/** `POST /job-update`: false only when the job is not this chat's. Throws when a text failed, so the job offers it again. */
export async function jobUpdate(storage: InboxStorage, deps: JobTextDeps, update: JobUpdate): Promise<boolean> {
  const entry = await storage.get<JobEntry>(`${JOB_PREFIX}${update.id}`);
  if (entry === undefined) return false;
  if (entry.groupId !== undefined) return groupJobUpdate(storage, deps, update);
  const noted = await noteJobUpdate(storage, update, deps.now());
  // A link to save a login went from the job: watch for the save (`vaultWatch.ts`).
  if (noted !== null && !noted.quiet && update.vaultWatch !== undefined) await watchForSave(storage, update.vaultWatch, deps.now());
  if (noted === null || noted.quiet || noted.chatId === undefined) return noted !== null;
  const chatId = noted.chatId;
  for (const [i, text] of (update.texts ?? []).entries()) {
    const index = (update.first ?? 0) + i;
    if (index < (noted.sent ?? 0)) continue;
    if (noted.channel === "simulator") await record(storage, "in", text, deps.now());
    else {
      const handle = await lineFor(deps, chatId).sendText(chatId, text, `job:${update.id}:${index}`, noted.messageId);
      await rememberText(storage, chatId, handle, text, deps.now());
    }
    await noteJobSent(storage, update.id, index + 1);
  }
  return true;
}
