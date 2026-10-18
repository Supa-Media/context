/**
 * What @shared calls a note and its sharer (board A2, Dev2 2026-10-14): the
 * note's own title and the person's name, rather than a file name and a handle.
 *
 * The title comes from the control plane's copy of the note's facts — its
 * front matter `title:` or first heading (`nodes.props`, `lib/nodes/facts.ts`)
 * — so the list costs no bucket read. A sealed note keeps no props and falls
 * back to its file name, which the client draws from `entryPath`.
 *
 * ## AND IT IS RE-DERIVED, BECAUSE A SHARE ROW IS NOT A READ
 *
 * This first reasoned that "a person share already lets its reader open the
 * whole note, so its heading discloses nothing the row's link does not". That
 * is true when the share is made and false the moment the owner narrows the
 * note, which is the case the rest of the feature is built around:
 * `shareStillStands` says in as many words that it "does NOT decide what the
 * reader may see … the only place that answer can be current is the read
 * itself", and `readThroughShare` duly refuses the body. The row went on
 * carrying the heading — the note's own first line of prose, which says more
 * than the file name beside it.
 *
 * So the title is asked the same question the read is, off the same rules
 * mirror the share-link mint uses (`nodes.teamShareable`): `team` scope with
 * no granted names, which is how `readThroughShare` opens it. No rules, an
 * unparsable manifest or a narrowed note each give no title rather than a
 * stale one. The row itself still stands — only its title is withheld — so
 * nothing here tells the recipient whether the note is gone or merely closed.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { canSee } from "../privacy";
import { liveNode } from "../nodes/facts";
import { mirrorRules } from "../nodes/log";
import { readerMirror } from "../nodes/readerRules";
import type { Rules } from "../nodes/log";

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

/**
 * What a link's readers would be allowed to see in one context, read once.
 *
 * Hoisted out of the row loop deliberately: the rules are per workspace and a
 * list is mostly rows from a handful of them, so parsing the manifest per row
 * would be the bucket read this list exists to avoid, paid in CPU instead.
 * `null` where there is nothing readable to judge against, which withholds
 * every title in that context rather than guessing one.
 */
export async function shareableRules(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Rules | null> {
  const mirror = await readerMirror(ctx, workspaceId);
  if (mirror?.invalid === true) return null;
  return await mirrorRules(mirror);
}

/** The shared note's title, or `null` when it is not the recipient's to be told. */
export async function sharedNoteTitle(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  entryPath: string,
  rules: Rules | null,
): Promise<string | null> {
  if (rules === null || !canSee(entryPath, "team", rules.rules, rules.overrides)) return null;
  const row = await liveNode(ctx.db, workspaceId, entryPath);
  return row === null ? null : titleFromProps(row.props);
}

/** The sharer's own name, as their account spells it, or `null` for one with none. */
export async function sharerName(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const user = await ctx.db.get(userId);
  return oneLine(user?.name);
}
