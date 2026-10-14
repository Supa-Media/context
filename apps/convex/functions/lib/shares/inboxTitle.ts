/**
 * What @shared calls a note and its sharer (board A2, Dev2 2026-10-14): the
 * note's own title and the person's name, rather than a file name and a handle.
 *
 * The title comes from the control plane's copy of the note's facts — its
 * front matter `title:` or first heading (`nodes.props`, `lib/nodes/facts.ts`)
 * — so the list costs no bucket read. A person share already lets its reader
 * open the whole note, so its heading discloses nothing the row's link does
 * not. A sealed note keeps no props and falls back to its file name, which the
 * client draws from `entryPath`.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { liveNode } from "../nodes/facts";

/** Long enough for any real title, short enough that a row cannot carry a paragraph. */
const MAX_TITLE = 200;

function oneLine(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
  return line === "" ? null : line;
}

/** A props row's title: front matter `title:` first, then its first heading. */
export function titleFromProps(props: string | undefined): string | null {
  if (props === undefined) return null;
  let parsed: { heading?: unknown; properties?: Record<string, unknown> };
  try {
    parsed = JSON.parse(props);
  } catch {
    return null;
  }
  return oneLine(parsed.properties?.title) ?? oneLine(parsed.heading);
}

/** The shared note's title, or `null` when the tree has none to give. */
export async function sharedNoteTitle(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  entryPath: string,
): Promise<string | null> {
  const row = await liveNode(ctx.db, workspaceId, entryPath);
  return row === null ? null : titleFromProps(row.props);
}

/** The sharer's own name, as their account spells it, or `null` for one with none. */
export async function sharerName(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const user = await ctx.db.get(userId);
  return oneLine(user?.name);
}
