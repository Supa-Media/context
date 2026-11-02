/**
 * Which group chats have their home in the pinned workspace, and which are
 * still kept in their bound workspace (2026-11-01). Every chat is meant to
 * have one (`lib/textGroupHome.ts`, `docs/decisions/texting-assistant/chat-homes.md`),
 * but making one gives up quietly when it fails, and a turn whose chat has no
 * home writes the old note in the bound workspace with nothing logged.
 *
 * Read only. It answers counts and fixed codes, never an id, a path, a name or
 * a key: it is run from the `Tex chat homes census` workflow, whose log is
 * public. `match` picks one chat by the first characters of the hash its
 * memory note is named by (`chat-<12 hex>.md`), so the run can say how that
 * one chat stands without naming it.
 */

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { chatHomeOf, chatHomePath } from "./lib/textGroupHome";
import { liveNodeAt } from "./lib/nodes/paths";
import { grantedNamesFor } from "./lib/grantedNames";
import { listFolderFromNodes } from "./lib/nodes/listing";
import { clearanceOf } from "./lib/clearance";
import { scopeForRole } from "./lib/filesFns/access";

/** How one chat's home stands, as a code. */
type HomeCode = "ok" | "no_words" | "folder_missing" | "not_a_folder" | "no_note_id" | "bound_to_pin";

async function homeCode(ctx: QueryCtx, chat: Doc<"textGroups">, pinned: Id<"workspaces"> | null): Promise<HomeCode> {
  if (pinned !== null && chat.workspaceId === pinned) return "bound_to_pin";
  if (chat.homeWords === undefined) return "no_words";
  if (pinned === null) return "folder_missing";
  const row = await liveNodeAt(ctx.db, pinned, chatHomePath(chat.homeWords));
  if (row === null) return "folder_missing";
  if (row.kind !== "folder") return "not_a_folder";
  if ((await chatHomeOf(ctx, chat._id)) === null) return "no_note_id";
  return "ok";
}

async function noteHash(groupKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(groupKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const census = internalQuery({
  args: { match: v.optional(v.string()) },
  handler: async (ctx, { match }) => {
    const pin = await pinnedContextWorkspace(ctx);
    const pinned = pin?._id ?? null;
    const chats = await ctx.db.query("textGroups").collect();
    const counts: Record<string, number> = {};
    const now = Date.now();
    let matched: Record<string, unknown>[] = [];
    const wanted = typeof match === "string" && /^[0-9a-f]{8,64}$/.test(match) ? match : null;
    for (const chat of chats) {
      const code = await homeCode(ctx, chat, pinned);
      counts[code] = (counts[code] ?? 0) + 1;
      if (wanted !== null && typeof chat.groupKey === "string" && (await noteHash(chat.groupKey)).startsWith(wanted)) {
        matched.push({
          home: code,
          homeUsers: chat.homeUsers?.length ?? 0,
          sponsored: chat.sponsorId !== undefined,
          boundToAWorkspace: chat.workspaceId !== undefined,
          hoursSinceSeen: Math.round((now - chat.lastSeenAt) / 3_600_000),
        });
      }
    }
    if (matched.length > 3) matched = matched.slice(0, 3);
    return {
      pin: pinned === null ? "none" : "ok",
      chats: chats.length,
      homes: counts,
      owners: pinned === null ? [] : await ownersSee(ctx, pinned, chats),
      ...(wanted !== null ? { matched } : {}),
    };
  },
});

/**
 * What each owner and editor of the pin sees of the homes, as counts (2026-11-02: an owner saw `tex/` empty in the app): how
 * many chats name them among a home's people, how many row names their grants give them in the pin, and how many
 * entries their own listing of `tex` and `tex/groups` returns, as the app's tree asks (`nodesListing.listFolder`).
 */
async function ownersSee(ctx: QueryCtx, pinned: Id<"workspaces">, chats: Doc<"textGroups">[]) {
  // Every role that can change the pin, not only owners: the one who saw `tex/` empty may hold another (2026-11-02).
  const owners = (await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", pinned)).collect()).filter(
    (row) => row.role === "owner" || row.role === "editor",
  );
  const out: Record<string, unknown>[] = [];
  for (const owner of owners.slice(0, 10)) {
    const names = await grantedNamesFor(ctx, pinned, owner.userId);
    const clearance = clearanceOf(scopeForRole(owner.role), names);
    const listed = async (path: string) => {
      try {
        const listing = await listFolderFromNodes(ctx, pinned, path, clearance);
        return listing.entries.length;
      } catch {
        return -1;
      }
    };
    out.push({
      role: owner.role,
      inHomeUsers: chats.filter((chat) => (chat.homeUsers ?? []).includes(owner.userId)).length,
      names: names.length,
      tex: await listed("tex"),
      groups: await listed("tex/groups"),
    });
  }
  return out;
}
