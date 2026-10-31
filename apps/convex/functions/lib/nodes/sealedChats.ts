/**
 * Group Tex's chat homes in the pinned workspace, sealed from every role there (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * Each group chat Tex is in keeps its home at `tex/groups/<words>/` in `@context-lc` (`CHAT_HOMES_FOLDER`), named
 * for the people in the chat. The pinned workspace is Context's own, so an ordinary private folder there would be
 * read by the people who run it. The owner asked for the folder to be sealed instead: what is under it is seen only
 * through a row token somebody was named on, and never through a role, an owner's included.
 *
 * Three pieces make that hold:
 *
 *  - **The rule** (`withSealedChats`): the folder renders as `SEALED` for every audience, and `canSee` answers a
 *    sealed path by name alone, before scope (`lib/privacy.ts`, mirrored in the gateway's engine). Every read,
 *    write, move, trash and search that asks `canSee` is closed to a role by that one line.
 *  - **Only people open it**: beneath the folder a grant reaches only a person, by account or by email. `members`,
 *    `accounts` and a group are each a role in the pinned workspace by another name, and are dropped.
 *  - **Only Tex changes it** (`sealedChange`): setting access at or beneath the folder, or moving, renaming or
 *    trashing it or anything around it, is refused to everyone but the chat homes' own client. Its path never
 *    changes, so the rule is a path and needs no flag on a row.
 */

import { CHAT_HOMES_FOLDER, PINNED_CONTEXT_SLUG } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { foldPath } from "../privacy";
import type { AccessRow } from "./rowAccess";

/** The client the chat homes are kept under; the only actor `sealedChange` lets through. */
export const CHAT_HOMES_CLIENT_ID = "context_chat_homes";

/** Whether this workspace seals the chat homes: the pinned workspace, by its name. */
export async function sealsChatHomes(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  // By the name alone, vouched for or not: a workspace that merely holds the name is sealed too, which only narrows.
  const workspace = await ctx.db.get(workspaceId);
  return workspace !== null && workspace.slug === PINNED_CONTEXT_SLUG;
}

/** Whether a path is the chat homes folder or beneath it, folded, so no spelling slips out from under it. */
export function inChatHomes(path: string): boolean {
  const folded = foldPath(path.replace(/^\/+|\/+$/g, ""));
  const root = foldPath(CHAT_HOMES_FOLDER);
  return folded === root || folded.startsWith(`${root}/`);
}

/**
 * Whether a change at `path` touches the chat homes: the folder, anything beneath it, or a folder it is beneath
 * (`tex`), whose move or trash would carry the homes with it.
 */
export function touchesChatHomes(path: string): boolean {
  const folded = foldPath(path.replace(/^\/+|\/+$/g, ""));
  if (folded === "") return false;
  return inChatHomes(folded) || foldPath(CHAT_HOMES_FOLDER).startsWith(`${folded}/`);
}

/**
 * Whether a change at these paths in this workspace must be refused to this client: true in the pinned workspace
 * for any path that touches the chat homes, unless the client is the chat homes' own.
 */
export async function sealedChange(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
  clientId: string | undefined,
): Promise<boolean> {
  if (clientId === CHAT_HOMES_CLIENT_ID) return false;
  if (!paths.some(touchesChatHomes)) return false;
  return await sealsChatHomes(ctx, workspaceId);
}

/** How deep a path sits inside the chat homes: 1 for a chat's home, 2 and on for what is in it; 0 outside. */
function depthInside(path: string): number {
  if (!inChatHomes(path)) return 0;
  return foldPath(path).split("/").length - foldPath(CHAT_HOMES_FOLDER).split("/").length;
}

/**
 * Whether a move (or a trash, `trash`) from `from` to `to` would carry anything out of, into or across the chat
 * homes in a workspace that seals them. What stays inside one home moves as anything does, judged by `canSee` like
 * every move, and a note in a home may be trashed, and restored, by whoever may see it: the trash keeps its rule
 * (`trash/bin.ts` `rulesAsTrashed`). Everything else touching them is refused: the homes folder, `tex` above it,
 * a whole home, and any move in or out, since a note carried out of the seal would be open to the people who run
 * the workspace, and one carried in would vanish from its owner.
 */
export function chatHomesMoveRefused(from: string, to: string, trash: boolean): boolean {
  if (!touchesChatHomes(from) && !touchesChatHomes(to)) return false;
  // Into the trash from inside a home, or back out of it to one; the trash holds nothing else of theirs.
  if (trash) return !(depthInside(from) >= 2 || (depthInside(to) >= 2 && !touchesChatHomes(from)));
  if (depthInside(from) < 2 || depthInside(to) < 2) return true;
  const homeOf = (path: string) => foldPath(path).split("/").slice(0, foldPath(CHAT_HOMES_FOLDER).split("/").length + 1).join("/");
  return homeOf(from) !== homeOf(to);
}

/**
 * In the pinned workspace, the chat homes folder (`CHAT_HOMES_FOLDER`) as a sealed row, and every row beneath it
 * holding only the people named on it (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/chat-homes.md`).
 *
 * The sealed row replaces any setting somebody gave that folder, so no base and no list on it ever reaches a reader.
 * Beneath it a grant reaches only a person, by account or by email: never `members`, `accounts` or a group, each of
 * which is a role in the pinned workspace by another name, and would hand a chat to the people who run it. A row
 * left with neither is dropped, and what is under it answers to the sealed rule: nobody. Every other workspace's
 * rows are returned as they are. One extra read (the workspace) per call.
 */
export async function withSealedChats(ctx: QueryCtx, workspaceId: Id<"workspaces">, rows: AccessRow[]): Promise<AccessRow[]> {
  if (!(await sealsChatHomes(ctx, workspaceId))) return rows;
  const root = foldPath(CHAT_HOMES_FOLDER);
  const beneath = (path: string) => foldPath(path).startsWith(`${root}/`);
  const out: AccessRow[] = [];
  for (const row of rows) {
    if (foldPath(row.path) === root) continue;
    if (!beneath(row.path)) {
      out.push(row);
      continue;
    }
    const grantees = row.grantees.filter((grantee) => grantee.kind === "user" || grantee.kind === "email");
    if (grantees.length > 0) out.push({ ...row, base: undefined, grantees });
  }
  out.push({ path: CHAT_HOMES_FOLDER, noteId: "sealed-chats", kind: "folder", grantees: [], sealed: true });
  return out;
}
