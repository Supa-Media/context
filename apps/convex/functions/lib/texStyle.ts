/**
 * The seven style dials Tex had before custom instructions (Dev2, 2026-10-28,
 * replaced 2026-11-01; `docs/decisions/texting-assistant/custom-instructions.md`):
 * a tone, three More/Less dials, a length, one bubble or several, and a humor
 * percentage. Kept on old rows (`texStylePreferences.texStyle`,
 * `textGroups.texStyle`) and read only by the migration that wrote their lines
 * (`texSettingsMigration.ts`, `texInstructions.ts` `linesFromStyle`), and by the app's Tex page, which still sets
 * them as quick picks (`texPage.ts`, `readTexStyle`).
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

const CLOSED: Record<string, readonly string[]> = {
  tone: ["default", "professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"],
  warmth: ["more", "default", "less"],
  enthusiasm: ["more", "default", "less"],
  emoji: ["more", "default", "less"],
  length: ["short", "default", "detailed"],
  bubbles: ["multiple", "one"],
};
const isHumor = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 && value % 10 === 0;

/** Dials as a caller gave them: only known keys from their closed sets, humor a whole ten; anything else is refused whole (null). */
export function readTexStyle(value: unknown): TexStyle | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "humor" ? !isHumor(entry) : !(key in CLOSED) || typeof entry !== "string" || !CLOSED[key]!.includes(entry)) return null;
    out[key] = entry;
  }
  return out as TexStyle;
}
