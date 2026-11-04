/**
 * The one executor for what a chat's people may change about Tex (Dev2,
 * 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`), and since
 * 2026-11-01 its instructions, when it speaks up and progress updates
 * (`custom-instructions.md`).
 *
 * Two doors reach it. The texting Worker's exact short commands ("Tex, stop",
 * the settings menu) come through `/agent-texts/*` behind its secret, keyed by
 * the phone that texted (`textGroups.ts` `applyGroupTurn`, `texStyle.ts`).
 * The agent's tools come through `/gateway/tex/command` with the turn's own
 * grant (`texCommands.ts`), keyed by who that grant names. Both call these
 * functions, so the rules cannot drift between the fast path and the tools.
 */

import { refreshTexting } from "./textingRefresh";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { consumeRateLimit } from "./rateLimit";
import { applyInstructionsChange, type InstructionsChange, type SpeaksUp, type TexUpdates } from "./texInstructions";

/** Generous for someone trying every option, small for a client stuck in a loop. */
export const TEX_STYLE_WRITES_PER_HOUR = 120;
export const TEX_STYLE_WINDOW_MS = 60 * 60 * 1000;

/**
 * When Tex speaks up here. A row the migration has not reached yet (`texSettingsMigration.ts`) is read through its old
 * mute and style, so a chat that said "Tex, stop" before 2026-11-01 stays stopped.
 * TODO: drop the fallback once the migration has run everywhere.
 */
export function speaksUpOf(group: Doc<"textGroups">): SpeaksUp | undefined {
  if (group.speaksUp !== undefined) return group.speaksUp;
  return group.mutedAt !== undefined ? "off" : group.engagement;
}

/** Anyone in the chat may stop Tex: it cannot leave a group. The level it had is kept for "Tex, start". */
export async function muteChat(ctx: MutationCtx, group: Doc<"textGroups">, setBy: string): Promise<void> {
  const now = speaksUpOf(group);
  if (now === "off") return;
  await ctx.db.patch(group._id, { speaksUp: "off", speaksUpBefore: now, speaksUpSetBy: setBy, speaksUpSetAt: Date.now() });
}

/** Anyone in the chat may start Tex again, at the level it had before. */
export async function unmuteChat(ctx: MutationCtx, group: Doc<"textGroups">, setBy: string): Promise<void> {
  if (speaksUpOf(group) !== "off") return;
  const back = group.speaksUp === undefined ? group.engagement : group.speaksUpBefore;
  await ctx.db.patch(group._id, { speaksUp: back ?? "followAlong", speaksUpBefore: undefined, speaksUpSetBy: setBy, speaksUpSetAt: Date.now() });
}

/** When Tex speaks up in a chat, with who set it. */
export async function setSpeaksUp(ctx: MutationCtx, group: Doc<"textGroups">, level: Exclude<SpeaksUp, "off">, setBy: string): Promise<void> {
  await ctx.db.patch(group._id, { speaksUp: level, speaksUpBefore: undefined, speaksUpSetBy: setBy, speaksUpSetAt: Date.now() });
}

/** What a settings change asks: an instructions change, a progress updates level, or both. */
export type SettingsChange = { change?: InstructionsChange; updates?: TexUpdates };
export type Settings = { instructions?: string; updates?: TexUpdates };
export type SettingsRefusal = { refused: "bad_request" | "too_long" | "nothing_to_undo" };

function changed(kept: { instructions?: string; instructionsBefore?: string; updates?: TexUpdates }, ask: SettingsChange) {
  const text = ask.change === undefined ? null : applyInstructionsChange(kept, ask.change);
  if (text !== null && "refused" in text) return text;
  if (text === null && ask.updates === undefined) return { refused: "bad_request" as const };
  // Normal is the default: never kept.
  const updates = ask.updates === undefined ? kept.updates : ask.updates === "normal" ? undefined : ask.updates;
  return { text, updates };
}

/** A chat's instructions or progress updates changed, with who set them (a hash or a handle, never a number). The chat's settings now. */
export async function setChatSettings(ctx: MutationCtx, group: Doc<"textGroups">, ask: SettingsChange, setBy: string): Promise<Settings | SettingsRefusal> {
  await consumeRateLimit(ctx, { key: `texstyle:group:${group.groupKey}`, limit: TEX_STYLE_WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
  const next = changed(group, ask);
  if ("refused" in next) return next;
  const text = next.text === null ? {} : { instructions: next.text.instructions, instructionsBefore: next.text.instructionsBefore, instructionsSetBy: setBy, instructionsSetAt: Date.now() };
  await ctx.db.patch(group._id, { ...text, updates: next.updates });
  return settingsOf({ instructions: next.text === null ? group.instructions : next.text.instructions, updates: next.updates });
}

/** A person's own instructions or progress updates changed. Their settings now. */
export async function setPersonSettings(ctx: MutationCtx, userId: Id<"users">, ask: SettingsChange): Promise<Settings | SettingsRefusal> {
  await consumeRateLimit(ctx, { key: `texstyle:${userId}`, limit: TEX_STYLE_WRITES_PER_HOUR, windowMs: TEX_STYLE_WINDOW_MS });
  const row = await personRow(ctx, userId);
  const next = changed(row ?? {}, ask);
  if ("refused" in next) return next;
  const text = next.text === null ? {} : { instructions: next.text.instructions, instructionsBefore: next.text.instructionsBefore };
  const updatedAt = Date.now();
  // A new row holds only what is set; a patch's undefined is what clears a field.
  if (row === null) await ctx.db.insert("texStylePreferences", { userId, ...settingsOf(text), ...(next.updates ? { updates: next.updates } : {}), ...(text.instructionsBefore !== undefined ? { instructionsBefore: text.instructionsBefore } : {}), updatedAt });
  else await ctx.db.patch(row._id, { ...text, updates: next.updates, updatedAt });
  await refreshTexting(ctx, userId); // the style a text's session answers with (`lib/textingRefresh.ts`)
  return settingsOf({ instructions: next.text === null ? row?.instructions : next.text.instructions, updates: next.updates });
}

export async function personRow(ctx: { db: QueryCtx["db"] }, userId: Id<"users">): Promise<Doc<"texStylePreferences"> | null> {
  return await ctx.db
    .query("texStylePreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** Only what is set: an empty object is no instructions and normal updates. */
export function settingsOf(kept: { instructions?: string; updates?: TexUpdates }): Settings {
  return { ...(kept.instructions ? { instructions: kept.instructions } : {}), ...(kept.updates ? { updates: kept.updates } : {}) };
}
