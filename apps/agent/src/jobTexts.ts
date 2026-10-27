/**
 * A background job's word reaching its chat (`jobs.ts`, `jobRun.ts`): the
 * chat's inbox keeps the status and texts what the job wrote, under the ask it
 * came from, so the result reads as the answer to it. Texts are counted per
 * job (`sent`), so an update offered again repeats none of them on a line
 * with no idempotency key.
 *
 * A job's answer may carry pictures, a page's cover above all (owner,
 * 2026-10-27: "the first screen image should be the og image preview ... that
 * way we can just send the link"). They go first, counted with the texts, and
 * once one went a bare note link is texted with no name card drawn for it
 * (`noteCards.ts`): one picture, then the link alone.
 * A cover that would not send is skipped, and the link then gets its name
 * card as before: the picture is never the only way to the page.
 */

import { lineFor, type LineDeps } from "./line";
import { record } from "./simulator";
import { rememberText } from "./threads";
import { type GroupDeps } from "./groupInbox";
import { groupLineFor } from "./groupLine";
import { logOut, say } from "./groupSay";
import { shrinkPicture, type OutgoingPicture } from "./outgoing";
import { JOB_PREFIX, log, noteJobSent, noteJobUpdate, type JobEntry, type JobUpdate } from "./jobs";
import type { InboxStorage } from "./inbox";
import { watchForSave } from "./vaultWatch";

export type JobTextDeps = LineDeps & GroupDeps;

/** What one update sends, in order: its pictures, then its texts, each at its place in the job's count. */
type Item = { kind: "picture"; picture: OutgoingPicture } | { kind: "text"; text: string };

function itemsOf(update: JobUpdate): Item[] {
  return [
    ...(update.pictures ?? []).map((picture): Item => ({ kind: "picture", picture })),
    ...(update.texts ?? []).map((text): Item => ({ kind: "text", text })),
  ];
}

/** Once a picture went, a note link draws no name card of its own (`noteCards.ts`). */
function afterPicture<T extends { noteCardPicture?: unknown }>(deps: T, pictured: boolean): T {
  return pictured ? { ...deps, noteCardPicture: undefined } : deps;
}

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
  const line = lineFor(deps, chatId);
  // A picture an earlier offer of this update sent counts as sent.
  let pictured = false;
  for (const [i, item] of itemsOf(update).entries()) {
    const index = (update.first ?? 0) + i;
    const done = index < (noted.sent ?? 0);
    if (item.kind === "picture") {
      if (done) pictured = true;
      else if (noted.channel === "simulator") {
        await record(storage, "in", "[picture]", deps.now());
        pictured = true;
      } else {
        try {
          const media = "url" in item.picture ? { url: item.picture.url } : await line.uploadPicture(await shrinkPicture(deps.images, item.picture));
          await line.sendMedia(chatId, media, `job:${update.id}:${index}`, noted.messageId);
          pictured = true;
        } catch {
          // Skipped, never retried: the words still go, and the link its own name card.
          log("picture_failed", update.id);
        }
      }
    } else if (!done) {
      const text = item.text;
      if (noted.channel === "simulator") await record(storage, "in", text, deps.now());
      else {
        const handle = await lineFor(afterPicture(deps, pictured), chatId).sendText(chatId, text, `job:${update.id}:${index}`, noted.messageId);
        await rememberText(storage, chatId, handle, text, deps.now());
      }
    }
    if (!done) await noteJobSent(storage, update.id, index + 1);
  }
  return true;
}

/** A background job's word in a group (`jobRun.ts`): its status kept, its pictures and texts sent under the message it answers. */
async function groupJobUpdate(storage: InboxStorage, deps: GroupDeps, update: JobUpdate): Promise<boolean> {
  const entry = await noteJobUpdate(storage, update, deps.now());
  if (entry === null || entry.quiet || entry.line === undefined || entry.groupId === undefined || entry.messageId === undefined) return entry !== null;
  const where = { line: entry.line, groupId: entry.groupId, messageId: entry.messageId };
  let pictured = false;
  for (const [i, item] of itemsOf(update).entries()) {
    const index = (update.first ?? 0) + i;
    const done = index < (entry.sent ?? 0);
    if (item.kind === "picture") {
      if (done) pictured = true;
      else {
        try {
          const url = "url" in item.picture ? item.picture.url : deps.hostPicture ? await deps.hostPicture(await shrinkPicture(deps.images, item.picture)) : null;
          if (url === null) throw new Error("no host");
          await groupLineFor(deps, where.groupId).sendMedia({ line: where.line, groupId: where.groupId }, url, where.messageId);
          await logOut(storage, deps, where.groupId, { kind: "picture", text: url, delivered: true }, {});
          pictured = true;
        } catch {
          log("picture_failed", update.id);
        }
      }
    } else if (!done) await say(storage, afterPicture(deps, pictured), where, item.text);
    if (!done) await noteJobSent(storage, update.id, index + 1);
  }
  return true;
}
