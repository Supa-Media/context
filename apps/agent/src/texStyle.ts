/**
 * How Tex talks, and the "Tex, settings" menu that changes it (Dev2,
 * 2026-10-28; `docs/decisions/texting-assistant/tex-settings.md`).
 *
 * Settings, absent meaning default: a tone, warmth, enthusiasm and emoji
 * (more, default, less), a length, one bubble or several, and a humor
 * percentage in tens, an homage to TARS in Interstellar. A person's own style
 * holds in their 1:1 chat; a group has its own, set by any member, and never
 * uses anyone's personal one. The control plane keeps both
 * (`apps/convex/functions/texStyle.ts`); the gateway says them to the model
 * (`apps/mcp/src/agent/texStyle.js`).
 *
 * The menu has two levels: "Tex, settings" lists the settings by number, a
 * number opens that setting's choices, and a number or a name sets it. Plain
 * words do the common ones in one text ("Tex, less emoji", "Tex, humor 60%").
 * What it keeps, never text: `texmenu`, when the menu opened and which
 * setting is open; `texstyle`, the 1:1 style as the control plane last said.
 */

import { post, record, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";

export type Level = "more" | "default" | "less";
export type TexStyle = {
  tone?: "default" | "professional" | "friendly" | "candid" | "quirky" | "efficient" | "nerdy" | "cynical";
  warmth?: Level;
  enthusiasm?: Level;
  emoji?: Level;
  length?: "short" | "default" | "detailed";
  bubbles?: "multiple" | "one";
  humor?: number;
};
type Key = Exclude<keyof TexStyle, "humor">;
export type SettingStep = Key | "humor" | "engagement";

const TONES = ["default", "professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"] as const;
const LEVELS = ["more", "default", "less"] as const;
const CHOICES: Record<Key, readonly string[]> = {
  tone: TONES,
  warmth: LEVELS,
  enthusiasm: LEVELS,
  emoji: LEVELS,
  length: ["short", "default", "detailed"],
  bubbles: ["multiple", "one"],
};
export const DEFAULT_HUMOR = 75;
const isHumor = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 && value % 10 === 0;

/** A style from the control plane, kept to known settings and their sets; undefined when absent or off. */
export function readTexStyle(value: unknown): TexStyle | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "humor" ? !isHumor(entry) : !(key in CHOICES) || !CHOICES[key as Key].includes(entry as string)) return undefined;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? (out as TexStyle) : undefined;
}

/** The menu, numbered once for every chat; "When I speak up" only shows in a group. */
const MENU: { n: number; step: SettingStep; label: string }[] = [
  { n: 1, step: "engagement", label: "When I speak up" },
  { n: 2, step: "tone", label: "Tone" },
  { n: 3, step: "warmth", label: "Warmth" },
  { n: 4, step: "enthusiasm", label: "Enthusiasm" },
  { n: 5, step: "emoji", label: "Emoji" },
  { n: 6, step: "length", label: "Length" },
  { n: 7, step: "bubbles", label: "Bubbles" },
  { n: 8, step: "humor", label: "Humor" },
];
const LABEL = Object.fromEntries(MENU.map(({ step, label }) => [step, label])) as Record<SettingStep, string>;
const word = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const BUBBLE_WORDS: Record<string, string> = { multiple: "Several per answer", one: "One per answer" };
const shown = (step: Key, value: string) => (step === "bubbles" ? BUBBLE_WORDS[value]! : word(value));

function current(style: TexStyle, step: SettingStep): string {
  if (step === "humor") return `${style.humor ?? DEFAULT_HUMOR}%`;
  if (step === "engagement") return "";
  return shown(step, style[step] ?? (step === "bubbles" ? "multiple" : "default"));
}

/** "Tex, settings": every setting with what it is now. `engagement`: the group's style name, in a group. */
export function settingsMenu(style: TexStyle, engagement?: string): string {
  const rows = MENU.filter(({ step }) => step !== "engagement" || engagement !== undefined).map(({ n, step, label }) => `${n} ${label} (${step === "engagement" ? engagement : current(style, step)})`);
  return `My settings here:\n\n${rows.join("\n")}\n\nReply with a number.`;
}

/** One setting's choices, numbered, with what it is now. */
export function settingChoices(step: Exclude<SettingStep, "engagement">, style: TexStyle): string {
  if (step === "humor") return `Humor is at ${current(style, "humor")}. Reply with a percent from 0 to 100, in tens.`;
  const rows = CHOICES[step].map((value, index) => `${index + 1} ${shown(step, value)}`);
  return `${LABEL[step]} (now ${current(style, step)}):\n\n${rows.join("\n")}\n\nReply with a number.`;
}

/** What a set says back: "Humor set to 60% (set by jhon)." */
export function styleSet(patch: TexStyle, by?: string): string {
  const parts = Object.entries(patch).map(([key, value]) => (key === "humor" ? `Humor set to ${value}%` : `${LABEL[key as Key]} set to ${shown(key as Key, value as string)}`));
  return `${parts.join(", ")}${by ? ` (set by ${by})` : ""}.`;
}

export type MenuState = { at: number; step?: SettingStep };
const MENU_KEY = "texmenu";
export const MENU_OPEN_MS = 30 * 60_000;

/** The menu open (or a setting in it), as of `now`, or undefined when it closed or timed out. */
export async function menuState(storage: InboxStorage, now: number): Promise<MenuState | undefined> {
  const open = await storage.get<MenuState>(MENU_KEY);
  return open !== undefined && now - open.at < MENU_OPEN_MS ? open : undefined;
}

export async function openMenu(storage: InboxStorage, now: number, step?: SettingStep): Promise<void> {
  await storage.put<MenuState>(MENU_KEY, { at: now, ...(step ? { step } : {}) });
}

export async function closeMenu(storage: InboxStorage): Promise<void> {
  await storage.delete(MENU_KEY);
}

export type SettingReply = { kind: "menu"; step: SettingStep } | { kind: "set"; patch: TexStyle };

const bare = (text: string) =>
  text
    .trim()
    .replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "")
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?@?(?:tex|context)(?![\w-])[\s,:!.-]*/i, "")
    .replace(/[.!)]+$/, "")
    .trim()
    .toLowerCase();

/** A reply to the open menu: a number picks a setting, then a number or a name (or a percent, for humor) sets it. */
export function menuReply(text: string, state: MenuState, group: boolean): SettingReply | null {
  const words = bare(text);
  if (state.step === undefined) {
    const picked = MENU.find(({ n, label }) => String(n) === words || label.toLowerCase() === words);
    if (picked === undefined || (picked.step === "engagement" && !group)) return null;
    return { kind: "menu", step: picked.step };
  }
  if (state.step === "engagement") return null;
  if (state.step === "humor") {
    const humor = /^(\d{1,3})\s*%?$/.exec(words);
    return humor && isHumor(Number(humor[1])) ? { kind: "set", patch: { humor: Number(humor[1]) } } : null;
  }
  const choices = CHOICES[state.step];
  const value = choices[Number(words) - 1] ?? choices.find((choice) => choice === words || shown(state.step as Key, choice).toLowerCase() === words);
  return value === undefined ? null : { kind: "set", patch: { [state.step]: value } as TexStyle };
}

const DIAL_WORDS = /^(more|less|fewer|no)\s+(warmth|warm|enthusiasm|enthusiastic|emoji|emojis)$/;

/** Plain words for the common settings, the whole text: "less emoji", "humor 60%", "tone efficient", "one bubble", "short answers". */
export function styleWords(text: string): TexStyle | null {
  const words = bare(text);
  const humor = /^(?:set\s+)?humou?r(?:\s+(?:to|at))?\s+(\d{1,3})\s*%?$/.exec(words);
  if (humor) return isHumor(Number(humor[1])) ? { humor: Number(humor[1]) } : null;
  const tone = /^(?:tone|be)\s+(\w+)$/.exec(words);
  if (tone && (TONES as readonly string[]).includes(tone[1]!)) return { tone: tone[1] as TexStyle["tone"] };
  const dial = DIAL_WORDS.exec(words);
  if (dial) {
    const key = dial[2]!.startsWith("warm") ? "warmth" : dial[2]!.startsWith("enthus") ? "enthusiasm" : "emoji";
    return { [key]: dial[1] === "more" ? "more" : "less" } as TexStyle;
  }
  if (/^(?:one|1|single)\s+(?:bubble|text)(?:\s+(?:per|an?)\s+answer)?$/.test(words)) return { bubbles: "one" };
  if (/^(?:several|multiple|many)\s+(?:bubbles|texts)$/.test(words)) return { bubbles: "multiple" };
  if (/^(?:short|shorter)(?:\s+answers)?$/.test(words)) return { length: "short" };
  if (/^(?:detailed|longer|more detailed)(?:\s+answers)?$/.test(words)) return { length: "detailed" };
  return null;
}

/** "Tex, settings" on its own, with or without the name. */
export const asksForSettings = (text: string): boolean => bare(text) === "settings" || bare(text) === "settings?";

type Saved = TexStyle | null;
async function saveStyle(fetcher: Fetch, origin: string, secret: string, path: string, body: Record<string, unknown>): Promise<Saved> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}${path}`, secret, body);
  const answer = record(json);
  return status === 200 && answer.ok === true ? (readTexStyle(answer.style) ?? {}) : null;
}

/** `POST /agent-texts/style`: a 1:1 setting, laid over the linked person's style. The style now, or null unlinked. */
export const saveTextsStyle = (fetcher: Fetch, origin: string, secret: string, phone: string, patch: TexStyle) =>
  saveStyle(fetcher, origin, secret, "/agent-texts/style", { phone, style: patch });

/** `POST /agent-texts/group/style`: a group setting, with who set it. The group's style now, or null for a chat Tex has no row for. */
export const saveGroupStyle = (fetcher: Fetch, origin: string, secret: string, line: string, groupId: string, patch: TexStyle, setBy: string) =>
  saveStyle(fetcher, origin, secret, "/agent-texts/group/style", { line, groupId, style: patch, setBy });

const STYLE_KEY = "texstyle";
/** The 1:1 style as the control plane last said, so the quick tapback can be left off without asking it again. */
export const keepTexStyle = (storage: InboxStorage, style: TexStyle | undefined) => storage.put<TexStyle>(STYLE_KEY, style ?? {});
export const keptTexStyle = async (storage: InboxStorage): Promise<TexStyle> => (await storage.get<TexStyle>(STYLE_KEY)) ?? {};

/**
 * A 1:1 text that is about the settings: the menu, a reply to it, or plain
 * words. The text to send back, or null when it is anything else.
 */
export async function textSettings(
  text: string,
  style: TexStyle,
  menu: { state: () => Promise<MenuState | undefined>; open: (step?: SettingStep) => Promise<void>; close: () => Promise<void> },
  save: (patch: TexStyle) => Promise<Saved>,
): Promise<string | null> {
  if (asksForSettings(text)) return await menu.open(), settingsMenu(style);
  const state = await menu.state();
  const reply = state ? menuReply(text, state, false) : null;
  if (reply?.kind === "menu" && reply.step !== "engagement") return await menu.open(reply.step), settingChoices(reply.step, style);
  const patch = reply?.kind === "set" ? reply.patch : styleWords(text);
  if (patch === null) return null;
  await menu.close();
  return (await save(patch)) === null ? null : styleSet(patch);
}
