/**
 * The quick half of hiding old copies (owner, 2026-10-22: "isn't the first
 * step just to hide it? Hiding it is an instant thing"): the Inbox folders
 * only the copying passes wrote into — calendar, contacts, email, google-chat
 * and imessage — are hidden whole, each one row move of the folder, as the
 * Trash takes a folder (`rowTrash.ts`). A folder past one move's cap moves its
 * root here and the rows beneath follow in pages on their own
 * (`rowMoveChunks.ts`), exactly as a big folder goes to the Trash.
 *
 * A copy written before its workspace was keyed may still read at its path
 * (no `storageKey`), and a row move refuses such a row ("unkeyed"); a chunked
 * one leaves it behind. Hiding is a move nobody reads through again but the
 * owner's Download, so each such row is pinned first: its `storageKey` set to
 * the path its bytes are at, which the cleanup counts as read and never
 * removes (`lib/cleanup/rows.ts`), and the move goes ahead. A refused move
 * takes the pins back, so nothing is left changed.
 *
 * Nothing in those folders is the person's (owner, same day: "there's no
 * handwritten things in contacts or iMessage or email"), so nothing is read
 * first. The note-by-note pass (`hiding.ts`) still runs after, for copies a
 * pass wrote anywhere else.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { OLD_COPIES_ROOT } from "../fileOps/store";
import { folderJobsOf } from "../nodes/folderJobs";
import { applyRowMove, rowAt, type RowMoveRefusal } from "../nodes/rowMove";
import { dayOf } from "./classify";
import { rowsBelow } from "../nodes/paths";

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

/** Give each unkeyed file row its own path as its key, so a row move takes it; answers the rows pinned. */
export async function pinUnkeyed(ctx: MutationCtx, rows: readonly Doc<"nodes">[]): Promise<Id<"nodes">[]> {
  const pinned: Id<"nodes">[] = [];
  for (const row of rows) {
    if (row.kind !== "file" || row.goneAt !== undefined || row.storageKey !== undefined) continue;
    await ctx.db.patch(row._id, { storageKey: row.path });
    pinned.push(row._id);
  }
  return pinned;
}

/** Take back pins a refused move did not use. */
export async function unpin(ctx: MutationCtx, pinned: readonly Id<"nodes">[]): Promise<void> {
  for (const id of pinned) await ctx.db.patch(id, { storageKey: undefined });
}

/** The live rows under `folder`. */
async function rowsUnder(ctx: MutationCtx, workspaceId: Id<"workspaces">, folder: string): Promise<Doc<"nodes">[]> {
  return await rowsBelow(ctx.db, workspaceId, folder);
}

/** What is in `rows`, counted as the Settings page counts it. */
function countOf(rows: readonly Doc<"nodes">[], contacts: boolean): FoldersHidden {
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

/**
 * The channel folders to hide: under the folder doing the Inbox job, and under
 * a root `inbox` or `0-inbox` too, since a rename of the Inbox can leave the
 * rows it could not carry under the old name (`rowMoveChunks.ts`).
 */
async function channelFolders(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<string[]> {
  const job = (await folderJobsOf(ctx.db, workspaceId)).jobs.inbox;
  const roots = [...new Set([job, "inbox", "0-inbox"].filter((root): root is string => typeof root === "string" && root !== ""))];
  const found: string[] = [];
  for (const root of roots) {
    for (const name of CHANNEL_FOLDERS) {
      const row = await rowAt(ctx.db, workspaceId, `${root}/${name}`);
      if (row !== null && row.goneAt === undefined && row.kind === "folder") found.push(row.path);
    }
  }
  return found;
}

/** Hide each channel folder in the Inbox whole. Folders already gone, or not there, are passed over. */
export async function hideChannelFolders(ctx: MutationCtx, workspaceId: Id<"workspaces">, now: number): Promise<FoldersHidden> {
  const total: FoldersHidden = { days: 0, contacts: 0, files: 0 };
  for (const from of await channelFolders(ctx, workspaceId)) {
    const rows = await rowsUnder(ctx, workspaceId, from);
    const counted = countOf(rows, from.endsWith("/contacts"));
    const pinned = await pinUnkeyed(ctx, rows);
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
      await unpin(ctx, pinned);
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
