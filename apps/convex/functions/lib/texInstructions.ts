/**
 * How Tex talks, in the people's own words (Dev2, 2026-11-01;
 * `docs/decisions/texting-assistant/custom-instructions.md`): one text per
 * person (their 1:1 chat only) and one per group chat. Quick picks edit that
 * text with a line of our own wording each; the catalog lives here alone, and
 * the Worker and the app name a pick by its id. Beside it, the progress
 * updates switch (`updates`), absent meaning normal.
 */

import { v, type Infer } from "convex/values";
import type { TexStyle } from "./texStyle";

/** The most a text may hold, as one custom-instructions box does. */
export const MAX_INSTRUCTIONS = 1_500;

export const TEX_UPDATES = ["off", "planOnly", "normal"] as const;
export type TexUpdates = (typeof TEX_UPDATES)[number];
export const texUpdatesValidator = v.union(v.literal("off"), v.literal("planOnly"), v.literal("normal"));

/** When Tex speaks up in a group, mute folded in as `off` (`textGroups.speaksUp`). */
export const SPEAKS_UP = ["off", "quiet", "attentive", "followAlong", "helpful"] as const;
export type SpeaksUp = (typeof SPEAKS_UP)[number];
export const speaksUpValidator = v.union(v.literal("off"), v.literal("quiet"), v.literal("attentive"), v.literal("followAlong"), v.literal("helpful"));

type Family = "tone" | "warmth" | "enthusiasm" | "emoji" | "length" | "bubbles" | "humor";

/** Every pick: its id, a label for a menu, the family one line of which a text holds, and the line it writes. */
export const QUICK_PICKS: readonly { id: string; label: string; family: Family; line: string }[] = [
  { id: "professional", label: "Professional", family: "tone", line: "Be professional. Write with polish and precision, courteous and to the point, the way a trusted advisor texts a client. Skip small talk and slang." },
  { id: "friendly", label: "Friendly", family: "tone", line: "Be friendly. Sound warm and relaxed, like a good friend who happens to know the answer. Keep it natural and kind." },
  { id: "candid", label: "Candid", family: "tone", line: "Be candid. Say plainly what you think, including when it is not what they hoped to hear. Stay kind, and give your reasons briefly." },
  { id: "quirky", label: "Quirky", family: "tone", line: "Be quirky. Let some playfulness and an odd turn of phrase show now and then. Never let it get in the way of the answer." },
  { id: "efficient", label: "Efficient", family: "tone", line: "Be efficient. Give the answer and stop: no greeting, no recap, no sign-off, no filler. Stay polite, but keep every word working." },
  { id: "nerdy", label: "Nerdy", family: "tone", line: "Be nerdy. Enjoy the details and share the interesting why behind things when it helps. Lead with the answer, then the fun part." },
  { id: "cynical", label: "Cynical", family: "tone", line: "Be a little cynical. Keep a dry wit and a light touch of sarcasm. Still give the practical answer straight." },
  { id: "warmth_more", label: "More warmth", family: "warmth", line: "Be warmer: show that you care." },
  { id: "warmth_less", label: "Less warmth", family: "warmth", line: "Keep it neutral and skip the reassurance." },
  { id: "enthusiasm_more", label: "More enthusiasm", family: "enthusiasm", line: "Be upbeat and energetic." },
  { id: "enthusiasm_less", label: "Less enthusiasm", family: "enthusiasm", line: "Stay calm and matter-of-fact, with no exclamation marks." },
  { id: "emoji_more", label: "More emoji", family: "emoji", line: "Use emoji freely where they fit." },
  { id: "emoji_less", label: "Less emoji", family: "emoji", line: "Use emoji sparingly." },
  { id: "emoji_none", label: "No emoji", family: "emoji", line: "Use no emoji." },
  { id: "short", label: "Short answers", family: "length", line: "Keep answers short: the answer and nothing more." },
  { id: "detailed", label: "Detailed answers", family: "length", line: "Give detailed answers: the reasons, the options and the next step." },
  { id: "one_bubble", label: "One bubble", family: "bubbles", line: "Send each answer as one text, with no blank lines." },
  { id: "humor_more", label: "More humor", family: "humor", line: "Joke more when it fits." },
  { id: "humor_less", label: "Less humor", family: "humor", line: "Joke rarely." },
  { id: "humor_none", label: "No humor", family: "humor", line: "No jokes." },
];

/** One change to a text: a pick, a line added or taken out, the whole text, cleared, or put back as it was. */
export const instructionsChangeValidator = v.object({
  pick: v.optional(v.string()),
  add: v.optional(v.string()),
  remove: v.optional(v.string()),
  replace: v.optional(v.string()),
  clear: v.optional(v.boolean()),
  undo: v.optional(v.boolean()),
});
export type InstructionsChange = Infer<typeof instructionsChangeValidator>;

/** What a text and its undo look like, as kept on a row. */
export type Kept = { instructions?: string; instructionsBefore?: string };

const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

/**
 * `kept` with `change` applied: the text and undo to store, or a refusal code. A text past `MAX_INSTRUCTIONS`, a pick
 * nobody made, or a change that names nothing is refused whole, never cut short. An undo with nothing to undo is
 * `nothing_to_undo`.
 */
export function applyInstructionsChange(kept: Kept, change: InstructionsChange): { instructions?: string; instructionsBefore?: string } | { refused: "bad_request" | "too_long" | "nothing_to_undo" } {
  const now = kept.instructions ?? "";
  if (change.undo === true) {
    if (kept.instructionsBefore === undefined) return { refused: "nothing_to_undo" };
    return kept.instructionsBefore === "" ? {} : { instructions: kept.instructionsBefore };
  }
  let next: string;
  if (change.pick !== undefined) {
    const pick = QUICK_PICKS.find((entry) => entry.id === change.pick);
    if (pick === undefined) return { refused: "bad_request" };
    const family = new Set(QUICK_PICKS.filter((entry) => entry.family === pick.family).map((entry) => entry.line));
    next = [...now.split("\n").filter((line) => !family.has(line.trim())), pick.line].join("\n");
  } else if (change.add !== undefined) {
    next = `${now}\n${change.add}`;
  } else if (change.remove !== undefined) {
    const gone = tidy(change.remove);
    next = now.split("\n").filter((line) => line.trim() !== gone).join("\n");
  } else if (change.replace !== undefined) {
    next = change.replace;
  } else if (change.clear === true) {
    next = "";
  } else {
    return { refused: "bad_request" };
  }
  const text = tidy(next);
  if (text.length > MAX_INSTRUCTIONS) return { refused: "too_long" };
  // Nothing changed (a line removed that was not there): the last real change stays the one to undo.
  if (text === now) return { ...(text !== "" ? { instructions: text } : {}), ...(kept.instructionsBefore !== undefined ? { instructionsBefore: kept.instructionsBefore } : {}) };
  return { ...(text !== "" ? { instructions: text } : {}), instructionsBefore: now };
}

const line = (id: string) => QUICK_PICKS.find((entry) => entry.id === id)!.line;

/** The lines an old style's dials stand for (`texSettingsMigration.ts`), in the catalog's order; "" for every default. */
export function linesFromStyle(style: TexStyle | undefined): string {
  if (style === undefined) return "";
  const lines: string[] = [];
  if (style.tone !== undefined && style.tone !== "default") lines.push(line(style.tone));
  for (const dial of ["warmth", "enthusiasm"] as const) if (style[dial] === "more" || style[dial] === "less") lines.push(line(`${dial}_${style[dial]}`));
  // The old "less" said "Use no emoji in your texts".
  if (style.emoji === "more") lines.push(line("emoji_more"));
  if (style.emoji === "less") lines.push(line("emoji_none"));
  if (style.length === "short" || style.length === "detailed") lines.push(line(style.length));
  if (style.bubbles === "one") lines.push(line("one_bubble"));
  // 75 was the default: 70 and 80 say nothing.
  const humor = style.humor;
  if (humor === 0) lines.push(line("humor_none"));
  else if (humor !== undefined && humor <= 60) lines.push(line("humor_less"));
  else if (humor !== undefined && humor >= 90) lines.push(line("humor_more"));
  return lines.join("\n");
}

/**
 * The Tex page in the app still shows and sets the dials (`texPage.ts`, from before 2026-11-01): a dial set there
 * is its quick pick, written into the text in place of its family's line ("default" takes the line out), so the
 * text stays the one source of truth. TODO: move the page to the text itself.
 */
export function withStyle(text: string, patch: TexStyle): string {
  const lines = text === "" ? [] : text.split("\n");
  let kept = lines;
  for (const key of Object.keys(patch) as (keyof TexStyle)[]) {
    const family = key === "length" ? "length" : key === "bubbles" ? "bubbles" : key;
    const theirs = new Set(QUICK_PICKS.filter((pick) => pick.family === family).map((pick) => pick.line));
    kept = [...kept.filter((entry) => !theirs.has(entry.trim())), ...linesFromStyle({ [key]: patch[key] }).split("\n").filter(Boolean)];
  }
  return kept.join("\n");
}

const DIAL_OF: Record<string, TexStyle> = {
  ...Object.fromEntries(["professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"].map((tone) => [tone, { tone }])),
  warmth_more: { warmth: "more" }, warmth_less: { warmth: "less" },
  enthusiasm_more: { enthusiasm: "more" }, enthusiasm_less: { enthusiasm: "less" },
  emoji_more: { emoji: "more" }, emoji_less: { emoji: "less" }, emoji_none: { emoji: "less" },
  short: { length: "short" }, detailed: { length: "detailed" }, one_bubble: { bubbles: "one" },
  humor_more: { humor: 100 }, humor_less: { humor: 40 }, humor_none: { humor: 0 },
} as Record<string, TexStyle>;

/** The dials a text's quick-pick lines stand for, for the page; a person's own lines show as no dial. */
export function styleOf(text: string | undefined): TexStyle {
  const lines = new Set((text ?? "").split("\n").map((entry) => entry.trim()));
  return Object.assign({}, ...QUICK_PICKS.filter((pick) => lines.has(pick.line)).map((pick) => DIAL_OF[pick.id]));
}
