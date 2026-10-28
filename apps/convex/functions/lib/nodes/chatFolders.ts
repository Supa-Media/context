/**
 * A Tex guest chat's reach, in the access rows (`lib/textGroupGuests.ts`;
 * `docs/decisions/texting-assistant/group-guests.md`).
 *
 * A guest chat reads only the rows shared with its own group. Three things
 * make that one answer for every reader:
 *
 *  - **The chat's folder is shared with the group before it has a row.** A
 *    list can't wait on a path with no row (`setAccess.ts`), and the chat's
 *    first note is written there. So while the folder has no row of its own,
 *    the chat's binding stands in for it here, as a row carrying only the
 *    group's grant behind a token of its own (`withChatFolders`). Every reader
 *    sees it the same way: members as a `team` row, the chat as a row it
 *    holds. The first turn after the row exists gives the row that grant for
 *    real.
 *  - **The chat's names** (`chatNamesFor`): `READS_AS_GUEST`, so every reader
 *    renders the rows for a guest and shuts `team`; `READS_AS_CHAT`; the
 *    group's own name, for a vault key given to it; and the tokens of the rows
 *    granted to the group. Nothing else: no member grant, no `accounts`.
 *  - **The folder is shared both ways** (the owner, 2026-10-28, choosing
 *    "Whole folder shared both ways"): what a member saves there the chat
 *    reads, and what the chat saves there the members read. A row under the
 *    folder that is open to the workspace (`team`) carries the group's grant
 *    beside it, and a folder row with no base of its own is `team` for the
 *    members, so the chat's notes, which inherit it, are theirs too. A note
 *    someone made private, or a folder the owner closed, stays as they set it;
 *    a folder the owner took from the chat's group is left alone entirely.
 *    On 2026-10-28 a page a member saved in a WhatsApp guest chat's folder
 *    was invisible to the chat, Tex's page under the same name was refused,
 *    and the chat's own notes were invisible to the members' Claude.
 *  - **The rules the chat's store holds** (`chatRules`): the guest rendering,
 *    with each row the chat holds read as `team` and every other row as
 *    `private`. The gateway's tools judge by a store's rules at `team` tier
 *    without names, so this is what makes them see exactly the chat's rows.
 *    A row held only to view is listed in `readOnly`: read, never changed.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { PrivacyOverrides, READS_AS_GUEST } from "../privacy";
import { accessNamesFor, type AccessRow, type RenderedAccess } from "./rowAccess";
import type { Rules } from "./log";

/**
 * The name a guest chat's grant holds beside `READS_AS_GUEST`, so the binding renders its rules for it
 * (`chatRules`) and the gateway judges them as folded. Shaped like a row token, as `READS_AS_GUEST` is, and spelled
 * with letters no row id has. Mirrored in `apps/mcp/src/privacy/engine.js`.
 */
export const READS_AS_CHAT = "@#reads-as-chat";

/** As a granted name is stored and sent: without its `@`. */
export const READS_AS_CHAT_NAME = READS_AS_CHAT.slice(1);
const READS_AS_GUEST_NAME = READS_AS_GUEST.slice(1);

/** Most chats read per workspace when standing in for their folders; no workspace has this many guest chats. */
const MAX_CHATS = 64;

/** Whether these names (with or without `@`) are a guest chat's. */
export function readsAsChat(names: Iterable<string> | undefined): boolean {
  for (const name of names ?? []) if (name === READS_AS_CHAT || name === READS_AS_CHAT_NAME) return true;
  return false;
}

/**
 * The rows, with each guest chat's folder shared both ways (see the header): a folder with no row with a setting
 * stands in as a row granted to its group at edit and open to the members; a folder row with no base is open to the
 * members; and every row under the folder open to the workspace carries the group's grant at edit. A folder whose
 * row has had the grant and no longer carries it was taken from the chat by its owner, and is left as it is.
 */
export async function withChatFolders(ctx: QueryCtx, workspaceId: Id<"workspaces">, rows: AccessRow[]): Promise<AccessRow[]> {
  const chats = await ctx.db
    .query("textGroups")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_CHATS);
  let out = rows;
  const extra: AccessRow[] = [];
  for (const chat of chats) {
    if (chat.guestGroupId === undefined || chat.guestFolder === undefined || chat.guestToken === undefined) continue;
    const groupId = chat.guestGroupId;
    const folder = chat.guestFolder;
    const own = out.find((row) => row.kind === "folder" && row.path === folder);
    const holds = (row: AccessRow) => row.grantees.some((grantee) => grantee.kind === "group" && grantee.id === groupId);
    // Its row has had the grant; from then on the row alone says whether the chat reads it (`ensureChatFolderGrant`).
    if (chat.guestFolderGranted === true && (own === undefined || !holds(own))) continue;
    const granted = (row: AccessRow): AccessRow => (holds(row) ? row : { ...row, grantees: [...row.grantees, { kind: "group", id: groupId, role: "edit" }] });
    out = out.map((row) => {
      if (row === own) return row.base === undefined ? { ...row, base: "team" } : row;
      return row.path.startsWith(`${folder}/`) && row.base === "team" ? granted(row) : row;
    });
    if (own === undefined && !extra.some((row) => row.path === folder)) {
      extra.push({ path: folder, noteId: chat.guestToken, kind: "folder", base: "team", grantees: [{ kind: "group", id: groupId, role: "edit" }] });
    }
  }
  return extra.length === 0 ? out : [...out, ...extra];
}

/** The names a guest chat's grant holds in its workspace, without `@` (see the header). */
export function chatNamesOf(groupId: string, groupName: string, rows: readonly AccessRow[]): string[] {
  const held = accessNamesFor({ groupIds: [groupId] }, rows).map((name) => name.slice(1));
  return [READS_AS_GUEST_NAME, READS_AS_CHAT_NAME, groupName, ...held];
}

/**
 * The guest rendering of the rows, read for one chat: a row token it holds is `team`, anything else `private`, and
 * the rows it holds only to view are named in `readOnly`. `names` are the chat's, with or without `@`.
 */
export function chatRules(guest: Rules, names: Iterable<string>): RenderedAccess & { readOnly: { folders: string[]; notes: string[] } } {
  const held = new Set([...names].map((name) => (name.startsWith("@") ? name : `@${name}`)));
  const readOnly = { folders: [] as string[], notes: [] as string[] };
  const read = (vis: string, path: string, list: string[]): "team" | "private" => {
    if (!vis.startsWith("@#") || !held.has(vis)) return "private";
    // A token is `@#<id>` and its edit name `@#<id>!edit` (`editNameFor`).
    if (!held.has(`${vis}!edit`)) list.push(path);
    return "team";
  };
  const rules = guest.rules.map((rule) => ({ prefix: rule.prefix, vis: read(rule.vis, rule.prefix, readOnly.folders) }));
  const overrides = new PrivacyOverrides();
  for (const [path, vis] of guest.overrides) overrides.set(path, read(vis, path, readOnly.notes));
  return { rules, overrides, readOnly };
}
