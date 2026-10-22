/**
 * The quick half of hiding old copies (owner, 2026-10-22: "isn't the first
 * step just to hide it? Hiding it is an instant thing"): the Inbox folders
 * only the copying passes wrote into — calendar, contacts, email, google-chat
 * and imessage — are hidden whole, each one row move of the folder, as the
 * Trash takes a folder (`rowTrash.ts`). A folder past one move's cap moves its
 * root here and the rows beneath follow in pages on their own
 * (`rowMoveChunks.ts`), exactly as a big folder goes to the Trash.
 *
 * Nothing in those folders is the person's (owner, same day: "there's no
 * handwritten things in contacts or iMessage or email"), so nothing is read
 * first. The note-by-note pass (`hiding.ts`) still runs after, for copies a
 * pass wrote anywhere else.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { OLD_COPIES_ROOT } from "../fileOps/store";
import { folderJobsOf } from "../nodes/folderJobs";
import { applyRowMove, rowAt, type RowMoveRefusal } from "../nodes/rowMove";
import { dayOf } from "./classify";

/** The Inbox folders the mail, calendar, chat, contacts and iMessage passes wrote into. */
export const CHANNEL_FOLDERS = ["calendar", "contacts", "email", "google-chat", "imessage"] as const;

/** A refusal that is about the workspace, not the folder: try again on the next look. */
const STOPPING: ReadonlySet<RowMoveRefusal> = new Set<RowMoveRefusal>(["not_keyed", "not_served", "busy"]);

export interface FoldersHidden {
  days: number;
  contacts: number;
  files: number;
  firstDay?: string;
  lastDay?: string;
  /** Why a folder could not be hidden yet; the next look tries again. */
  stopped?: RowMoveRefusal;
}

/** What is under `folder`, counted as the Settings page counts it. */
async function countUnder(ctx: MutationCtx, workspaceId: Id<"workspaces">, folder: string, contacts: boolean) {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", `${folder}/`).lt("path", `${folder}0`))
    .collect();
  const counted: FoldersHidden = { days: 0, contacts: 0, files: 0 };
  for (const row of rows) {
    if (row.kind !== "file" || row.goneAt !== undefined) continue;
    if (!row.path.endsWith(".md")) counted.files += 1;
    else if (contacts) counted.contacts += 1;
    else {
      counted.days += 1;
      const day = dayOf(row.path);
      if (day !== null && (counted.firstDay === undefined || day < counted.firstDay)) counted.firstDay = day;
      if (day !== null && (counted.lastDay === undefined || day > counted.lastDay)) counted.lastDay = day;
    }
  }
  return counted;
}

/** Hide each channel folder in the Inbox whole. Folders already gone, or not there, are passed over. */
export async function hideChannelFolders(ctx: MutationCtx, workspaceId: Id<"workspaces">, now: number): Promise<FoldersHidden> {
  const inbox = (await folderJobsOf(ctx.db, workspaceId)).jobs.inbox;
  const total: FoldersHidden = { days: 0, contacts: 0, files: 0 };
  if (typeof inbox !== "string" || inbox === "") return total;
  for (const name of CHANNEL_FOLDERS) {
    const from = `${inbox}/${name}`;
    const row = await rowAt(ctx.db, workspaceId, from);
    if (row === null || row.goneAt !== undefined || row.kind !== "folder") continue;
    const counted = await countUnder(ctx, workspaceId, from, name === "contacts");
    const moved = await applyRowMove(ctx, {
      workspaceId,
      from,
      to: `${OLD_COPIES_ROOT}/${from}`,
      privacyEtag: null,
      now,
      trash: true,
      chunk: { scope: "private", grantedNames: [] },
    });
    if (!moved.ok) {
      if (STOPPING.has(moved.reason)) return { ...total, stopped: moved.reason };
      // Some of it was hidden note by note already: the pass after this finishes the rest.
      continue;
    }
    total.days += counted.days;
    total.contacts += counted.contacts;
    total.files += counted.files;
    for (const day of [counted.firstDay, counted.lastDay]) {
      if (day === undefined) continue;
      if (total.firstDay === undefined || day < total.firstDay) total.firstDay = day;
      if (total.lastDay === undefined || day > total.lastDay) total.lastDay = day;
    }
  }
  return total;
}
