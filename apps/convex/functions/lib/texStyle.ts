/**
 * The seven style dials Tex had before custom instructions (Dev2, 2026-10-28,
 * replaced 2026-11-01; `docs/decisions/texting-assistant/custom-instructions.md`):
 * a tone, three More/Less dials, a length, one bubble or several, and a humor
 * percentage. Kept on old rows (`texStylePreferences.texStyle`,
 * `textGroups.texStyle`) and read only by the migration that wrote their lines
 * (`texSettingsMigration.ts`, `texInstructions.ts` `linesFromStyle`).
 * TODO: drop the fields and this validator once the migration has run everywhere.
 */

import { v, type Infer } from "convex/values";

const level = v.union(v.literal("more"), v.literal("default"), v.literal("less"));

export const texStyleValidator = v.object({
  tone: v.optional(
    v.union(
      v.literal("default"),
      v.literal("professional"),
      v.literal("friendly"),
      v.literal("candid"),
      v.literal("quirky"),
      v.literal("efficient"),
      v.literal("nerdy"),
      v.literal("cynical"),
    ),
  ),
  warmth: v.optional(level),
  enthusiasm: v.optional(level),
  emoji: v.optional(level),
  length: v.optional(v.union(v.literal("short"), v.literal("default"), v.literal("detailed"))),
  bubbles: v.optional(v.union(v.literal("multiple"), v.literal("one"))),
  /** 0 to 100 in tens. */
  humor: v.optional(v.number()),
});

export type TexStyle = Infer<typeof texStyleValidator>;

