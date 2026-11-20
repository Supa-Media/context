/**
 * A workspace's whole access set as its workspace object keeps it (`apps/mcp/src/workspaceStore/accessRows.js`):
 * every row that carries a setting, before any overlay, with what the overlays need to be applied in the object the
 * way `accessRowsOf` applies them here. Sent with the push beside the rendered rules, from the same transaction, so
 * the object can render its own and compare (`docs/decisions/storage-and-credentials/object-row-writes.md`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { pinnedContextWorkspace } from "../pinnedContext";
import { accessStateOf, accessVersionOf, settingRowsOf } from "./accessRows";
import { livePending } from "./pendingAccess";
import type { Grantee } from "./rowAccess";
import { movingRowMoves } from "./rowMoveChunks";
import { sealsChatHomes } from "./sealedChats";

export interface ObjectAccessSet {
  version: number;
  rows: { token: string; kind: "file" | "folder"; path: string; base?: "private" | "team"; grantees: Grantee[] }[];
  pending: { path: string; kind: "file" | "folder"; base: "private" | "team"; at: number }[];
  /** `accounts` grants are honoured here: the pinned workspace (`withAccountsHonoured`). */
  accounts: boolean;
  /** The chat homes are sealed here (`withSealedChats`). */
  sealsChats: boolean;
  /**
   * Where the homes are sealed here, each home's chat key by its words, so the object places a new note in a home in
   * that chat's Tex object as `texHome.ts` `chatKeyOfHome` does, without asking (2026-11-20, Dev2: no note save needs
   * Convex). Words two chats share are left out, as `chatKeyOfHome` answers none for them.
   */
  chatHomes?: Record<string, string>;
  /** Chunked moves part way through, while which the rules name both paths (`withMovingAccess`). */
  moving: number;
}

export async function objectAccessSet(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<ObjectAccessSet> {
  const state = await accessStateOf(ctx, workspaceId);
  const rows = await settingRowsOf(ctx, workspaceId, state);
  const pinned = await pinnedContextWorkspace(ctx);
  const seals = await sealsChatHomes(ctx, workspaceId);
  return {
    version: await accessVersionOf(ctx, workspaceId),
    rows: rows.map((row) => ({
      token: row.noteId,
      kind: row.kind,
      path: row.path,
      ...(row.base !== undefined ? { base: row.base } : {}),
      grantees: row.grantees.map((grantee) => ({ kind: grantee.kind, id: grantee.id, role: grantee.role })),
    })),
    pending: livePending(state?.pending, Date.now()).map((entry) => ({ path: entry.path, kind: entry.kind, base: entry.base, at: entry.at })),
    accounts: pinned !== null && pinned._id === workspaceId,
    sealsChats: seals,
    ...(seals ? { chatHomes: await chatHomeKeys(ctx) } : {}),
    moving: (await movingRowMoves(ctx.db, workspaceId)).length,
  };
}

/** The most homes one set names: the object refuses a set naming more (`accessRows.js` `MAX_CHAT_HOMES`). */
const CHAT_HOMES_SENT = 20_000;
const HOME_WORDS = /^[a-z]+(?:-[a-z]+){2}$/;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/** Every chat home's key by its words, as `chatKeyOfHome` would answer each: words two chats name answer none. */
export async function chatHomeKeys(ctx: QueryCtx): Promise<Record<string, string>> {
  const chats = await ctx.db
    .query("textGroups")
    .withIndex("by_home_words", (q) => q.gt("homeWords", ""))
    .take(CHAT_HOMES_SENT + 1);
  // More than the object takes: none, so every home is asked of the control plane, as before.
  if (chats.length > CHAT_HOMES_SENT) return {};
  const keys = new Map<string, string | null>();
  for (const chat of chats) {
    const words = chat.homeWords;
    if (typeof words !== "string" || !HOME_WORDS.test(words) || !CHAT_KEY.test(chat.groupKey)) continue;
    keys.set(words, keys.has(words) ? null : chat.groupKey);
  }
  return Object.fromEntries([...keys].filter((entry): entry is [string, string] => entry[1] !== null));
}
