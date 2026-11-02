/**
 * How Tex talks (Dev2, 2026-10-28; `docs/decisions/texting-assistant/tex-settings.md`):
 * a tone, three More/Less dials, a length, one bubble or several, and a humor
 * percentage (an homage to TARS in Interstellar). Kept per person
 * (`texStylePreferences`) and per group chat (`textGroups.texStyle`); a group
 * uses only its own. A setting at its default is never stored, so an empty
 * object is "every default" and the row says only what someone changed.
 */

import { v, type Infer } from "convex/values";

export const TEX_TONES = ["default", "professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"] as const;
export const TEX_LEVELS = ["more", "default", "less"] as const;
export const TEX_LENGTHS = ["short", "default", "detailed"] as const;
export const TEX_BUBBLES = ["multiple", "one"] as const;
/** TARS's own setting was a percentage; Tex starts where Cooper first set it. */
export const DEFAULT_HUMOR = 75;

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
  /** 0 to 100 in tens, checked by `readTexStyle` before it is ever stored. */
  humor: v.optional(v.number()),
});

export type TexStyle = Infer<typeof texStyleValidator>;

const CLOSED: Record<string, readonly string[]> = {
  tone: TEX_TONES,
  warmth: TEX_LEVELS,
  enthusiasm: TEX_LEVELS,
  emoji: TEX_LEVELS,
  length: TEX_LENGTHS,
  bubbles: TEX_BUBBLES,
};

const isHumor = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 && value % 10 === 0;

/**
 * A style as given by a caller (the Worker's route, the app): only known keys,
 * each from its closed set, humor a whole ten from 0 to 100. Anything else is
 * refused whole (null), never trimmed into something nobody asked for.
 */
export function readTexStyle(value: unknown): TexStyle | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "humor") {
      if (!isHumor(entry)) return null;
    } else if (!(key in CLOSED) || typeof entry !== "string" || !CLOSED[key]!.includes(entry)) {
      return null;
    }
    out[key] = entry;
  }
  return out as TexStyle;
}

/** `patch` laid over `base`; a setting put back to its default is dropped, so only changes are kept. */
export function mergeTexStyle(base: TexStyle | undefined, patch: TexStyle): TexStyle {
  const merged: Record<string, unknown> = { ...(base ?? {}), ...patch };
  for (const [key, entry] of Object.entries(merged)) {
    if (entry === undefined || entry === "default" || (key === "bubbles" && entry === "multiple") || (key === "humor" && entry === DEFAULT_HUMOR)) delete merged[key];
  }
  return merged as TexStyle;
}

/** Whether anything differs from every default. */
export const hasTexStyle = (style: TexStyle | undefined): style is TexStyle => style !== undefined && Object.keys(style).length > 0;
