/**
 * The one executor for what a chat's people may change about Tex (Jhonatan,
 * 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`).
 *
 * Two doors reach it. The texting Worker's exact short commands ("Tex, stop",
 * the settings menu) come through `/agent-texts/*` behind its secret, keyed by
 * the phone that texted (`textGroups.ts` `applyGroupTurn`, `texStyle.ts`).
 * The agent's tools come through `/gateway/tex/command` with the turn's own
 * grant (`texCommands.ts`), keyed by who that grant names. Both call these
 * functions, so the rules cannot drift between the fast path and the tools.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { consumeRateLimit } from "./rateLimit";
import { mergeTexStyle, type TexStyle } from "./texStyle";

/** Generous for someone trying every option, small for a client stuck in a loop. */
export const TEX_STYLE_WRITES_PER_HOUR = 120;
export const TEX_STYLE_WINDOW_MS = 60 * 60 * 1000;

export type Engagement = "quiet" | "attentive" | "followAlong" | "helpful";

/** Anyone in the chat may stop Tex: it cannot leave a group. */
export async function muteChat(ctx: MutationCtx, group: Doc<"textGroups">, by: Id<"users"> | null, now: number): Promise<void> {
  await ctx.db.patch(group._id, { mutedAt: now, ...(by !== null ? { mutedBy: by } : {}) });
}

/** Anyone in the chat may start Tex again. */
export async function unmuteChat(ctx: MutationCtx, group: Doc<"textGroups">): Promise<void> {
  await ctx.db.patch(group._id, { mutedAt: undefined, mutedBy: undefined });
}

/** A chat's style, `patch` laid over it, with who set it (a hash or a handle, never a number). The merged style. */
export async function setChatStyle(ctx: MutationCtx, group: Doc<"textGroups">, patch: TexStyle, setBy: string): Promise<TexStyle> {
  await consumeRateLimit(ctx, { key: `texstyle:group:${group.groupKey}`, limit: TEX_STYLE_WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
  const texStyle = mergeTexStyle(group.texStyle, patch);
  await ctx.db.patch(group._id, { texStyle, texStyleSetBy: setBy, texStyleSetAt: Date.now() });
  return texStyle;
}

/** When Tex speaks up in a chat, with who set it. */
export async function setChatEngagement(ctx: MutationCtx, group: Doc<"textGroups">, style: Engagement, setBy: string): Promise<void> {
  await ctx.db.patch(group._id, { engagement: style, engagementSetBy: setBy, engagementSetAt: Date.now() });
}

/** A person's own style, `patch` laid over it. The merged style. */
export async function setPersonStyle(ctx: MutationCtx, userId: Id<"users">, patch: TexStyle, replace = false): Promise<TexStyle> {
  await consumeRateLimit(ctx, { key: `texstyle:${userId}`, limit: TEX_STYLE_WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
  const row = await ctx.db
    .query("texStylePreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const texStyle = mergeTexStyle(replace ? {} : row?.texStyle, patch);
  const updatedAt = Date.now();
  if (row === null) await ctx.db.insert("texStylePreferences", { userId, texStyle, updatedAt });
  else await ctx.db.patch(row._id, { texStyle, updatedAt });
  return texStyle;
}
