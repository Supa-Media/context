/**
 * How Tex talks, and the "Tex, settings" menu that changes it (Dev2,
 * 2026-11-01; `docs/decisions/texting-assistant/custom-instructions.md`).
 *
 * The people's own instructions are the one source of truth: a person's own
 * hold in their 1:1 chat, a group's in the group, and nobody's personal ones
 * ever reach a group. Quick picks (the menu's, or words like "Tex, no emoji")
 * edit that text: this Worker names a pick by its id, and the control plane,
 * which keeps the one catalog (`apps/convex/functions/lib/texInstructions.ts`),
 * writes its line. Beside them, progress updates (off, plan only, normal).
 * The gateway says the instructions to the model (`apps/mcp/src/agent/customInstructions.js`).
 *
 * The menu has two levels: "Tex, settings" lists the switches and the full
 * instructions, a number opens a list or acts, and a number or a name picks.
 * What it keeps, never text: `texmenu`, when the menu opened and which list is open.
 */

import { post, record, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import { sharingWords } from "./reviewSharing";

export type Updates = "off" | "planOnly" | "normal";
/** What a chat's settings are, as the control plane says them. */
export type Settings = { instructions?: string; updates?: Updates };
/** One change: a quick pick by id, the text cleared or put back as it was, and or a progress updates level. */
export type Ask = { pick?: string; clear?: true; undo?: true; updates?: Updates };
export type SettingStep = "engagement" | "updates" | "picks" | "clear";

const UPDATES: { value: Updates; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "planOnly", label: "Plan only" },
  { value: "normal", label: "Normal" },
];
/** The control plane's catalog, by id and label only (`texInstructions.ts` `QUICK_PICKS`), in its order. */
export const PICKS: readonly { id: string; label: string }[] = [
  ["professional", "Professional"], ["friendly", "Friendly"], ["candid", "Candid"], ["quirky", "Quirky"], ["efficient", "Efficient"], ["nerdy", "Nerdy"], ["cynical", "Cynical"],
  ["warmth_more", "More warmth"], ["warmth_less", "Less warmth"], ["enthusiasm_more", "More enthusiasm"], ["enthusiasm_less", "Less enthusiasm"],
  ["emoji_more", "More emoji"], ["emoji_less", "Less emoji"], ["emoji_none", "No emoji"], ["short", "Short answers"], ["detailed", "Detailed answers"],
  ["one_bubble", "One bubble"], ["humor_more", "More humor"], ["humor_less", "Less humor"], ["humor_none", "No humor"],
].map(([id, label]) => ({ id: id!, label: label! }));
const MAX_INSTRUCTIONS = 1_500;

/** Settings from the control plane, kept to what they may be; `{}` for none. */
export function readSettings(value: unknown): Settings {
  const body = record(value);
  const instructions = typeof body.instructions === "string" && body.instructions.length <= MAX_INSTRUCTIONS && body.instructions.trim() !== "" ? body.instructions : undefined;
  const updates = UPDATES.some((entry) => entry.value === body.updates) ? (body.updates as Updates) : undefined;
  return { ...(instructions ? { instructions } : {}), ...(updates ? { updates } : {}) };
}

/** The menu, numbered once per kind of chat: a group has when Tex speaks up. */
const menuOf = (group: boolean): { step: SettingStep; label: string }[] =>
  group
    ? [
        { step: "engagement", label: "When I speak up" },
        { step: "updates", label: "Progress updates" },
        { step: "picks", label: "Quick picks" },
        { step: "clear", label: "Clear instructions" },
      ]
    : [
        { step: "updates", label: "Progress updates" },
        { step: "picks", label: "Quick picks" },
        { step: "clear", label: "Clear instructions" },
      ];
const updatesLabel = (settings: Settings) => UPDATES.find((entry) => entry.value === (settings.updates ?? "normal"))!.label;

/** "Tex, settings": the switches and the full instructions. `speaksUp`: the group's level by name, in a group. */
export function settingsMenu(settings: Settings, speaksUp?: string): string {
  const group = speaksUp !== undefined;
  const rows = menuOf(group).map(({ step, label }, index) => `${index + 1} ${label}${step === "engagement" ? ` (${speaksUp})` : step === "updates" ? ` (${updatesLabel(settings)})` : ""}`);
  const text = settings.instructions ?? "Nothing yet.";
  return group
    ? `My settings in this chat:\n\n${rows.join("\n")}\n\nHow I talk here (anyone here can change it):\n${text}\n\nPersonal instructions don't apply in groups.\n\nReply with a number.`
    : `My settings here:\n\n${rows.join("\n")}\n\nHow I talk to you:\n${text}\n\nReply with a number, or tell me "from now on ..." to change how I talk.`;
}

/** One list's choices, numbered. */
export function settingChoices(step: "updates" | "picks", settings: Settings): string {
  if (step === "updates") return `Progress updates (now ${updatesLabel(settings)}):\n\n${UPDATES.map((entry, index) => `${index + 1} ${entry.label}`).join("\n")}\n\nReply with a number.`;
  return `Quick picks, each adds a line to how I talk:\n\n${PICKS.map((pick, index) => `${index + 1} ${pick.label}`).join("\n")}\n\nReply with a number.`;
}

/** What a saved change says back. `by`: who changed a group's, so the chat knows and anyone can undo. */
export function settingSaid(ask: Ask, saved: Settings, by?: string): string {
  const undo = by !== undefined ? 'Anyone here can text "Tex, undo the change" to put it back.' : 'Text "Tex, undo the change" to put it back.';
  if (ask.pick !== undefined) return `${by !== undefined ? `${by} set` : "Saved"}: "${saved.instructions?.split("\n").at(-1) ?? ""}". ${undo}`;
  if (ask.clear) return `${by !== undefined ? `${by} cleared` : "Cleared"} how I talk here. ${undo}`;
  if (ask.undo) return `${by !== undefined ? `${by} put it back` : "Put back"}. How I talk here now:\n${saved.instructions ?? "Nothing yet."}`;
  return `Progress updates set to ${updatesLabel(saved)}${by !== undefined ? ` (set by ${by})` : ""}.`;
}

/** Said when an undo had nothing to undo, or a change was refused. */
export const NOTHING_TO_UNDO = "There's nothing to undo.";

export type MenuState = { at: number; step?: SettingStep };
const MENU_KEY = "texmenu";
export const MENU_OPEN_MS = 30 * 60_000;

/** The menu open (or a list in it), as of `now`, or undefined when it closed or timed out. */
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

/** A reply the open menu reads: a list to open, or a change to save. */
export type SettingReply = { kind: "menu"; step: "engagement" | "updates" | "picks" } | { kind: "set"; ask: Ask };

const bare = (text: string) =>
  text
    .trim()
    .replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "")
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?@?(?:tex|context)(?![\w-])[\s,:!.-]*/i, "")
    .replace(/[.!)]+$/, "")
    .trim()
    .toLowerCase();

/** A reply to the open menu: a number (or a name) opens a list or acts, then a number or a name picks. */
export function menuReply(text: string, state: MenuState, group: boolean): SettingReply | null {
  const words = bare(text);
  const nth = <T>(list: readonly T[]) => list[Number(words) - 1];
  if (state.step === undefined) {
    const menu = menuOf(group);
    const picked = nth(menu) ?? menu.find(({ label }) => label.toLowerCase() === words);
    if (picked === undefined) return null;
    if (picked.step === "clear") return { kind: "set", ask: { clear: true } };
    return { kind: "menu", step: picked.step };
  }
  if (state.step === "updates") {
    const level = nth(UPDATES) ?? UPDATES.find((entry) => entry.label.toLowerCase() === words);
    return level === undefined ? null : { kind: "set", ask: { updates: level.value } };
  }
  if (state.step === "picks") {
    const pick = nth(PICKS) ?? PICKS.find((entry) => entry.label.toLowerCase() === words);
    return pick === undefined ? null : { kind: "set", ask: { pick: pick.id } };
  }
  return null;
}

const TONE = /^(?:tone|be)\s+(professional|friendly|candid|quirky|efficient|nerdy|cynical)$/;
const DIAL = /^(more|less|fewer|no)\s+(warmth|warm|enthusiasm|enthusiastic|emoji|emojis|humou?r|jokes)$/;

/**
 * Plain words for a quick pick, an undo or a clear, the whole text: "no emoji", "less emoji", "tone efficient",
 * "one bubble", "short answers", "more humor", "undo the change", "clear instructions".
 */
export function styleWords(text: string): Ask | null {
  const words = bare(text);
  // Never a bare "undo": that is often about an email or an event, and goes to the model.
  if (/^undo (?:the|that|my|your|this) (?:last )?(?:settings? )?change$/.test(words)) return { undo: true };
  if (/^clear (?:the |my |your )?instructions$/.test(words)) return { clear: true };
  const tone = TONE.exec(words);
  if (tone) return { pick: tone[1] };
  const dial = DIAL.exec(words);
  if (dial) {
    const family = dial[2]!.startsWith("warm") ? "warmth" : dial[2]!.startsWith("enthus") ? "enthusiasm" : dial[2]!.startsWith("emoji") ? "emoji" : "humor";
    const how = dial[1] === "more" ? "more" : dial[1] === "no" ? "none" : "less";
    return how === "none" && (family === "warmth" || family === "enthusiasm") ? null : { pick: `${family}_${how}` };
  }
  if (/^(?:one|1|single)\s+(?:bubble|text)(?:\s+(?:per|an?)\s+answer)?$/.test(words)) return { pick: "one_bubble" };
  if (/^(?:short|shorter)(?:\s+answers)?$/.test(words)) return { pick: "short" };
  if (/^(?:detailed|longer|more detailed)(?:\s+answers)?$/.test(words)) return { pick: "detailed" };
  return null;
}

/**
 * A 1:1 text that is about the settings: the menu asked for, plain words for
 * a pick, a reply the open menu reads, or a yes or no to sharing chats with
 * the devs (`reviewSharing.ts`).
 */
export async function isSettingsText(storage: InboxStorage, text: string, now: number): Promise<boolean> {
  if (asksForSettings(text) || styleWords(text) !== null || sharingWords(text) !== null) return true;
  const state = await menuState(storage, now);
  return state !== undefined && menuReply(text, state, false) !== null;
}

/** "Tex, settings" on its own, with or without the name. */
export const asksForSettings = (text: string): boolean => bare(text) === "settings" || bare(text) === "settings?";

/** What a save answers: the settings now, `nothing_to_undo`, or null when it didn't go (unlinked, no row, refused). */
export type Saved = Settings | "nothing_to_undo" | null;
async function saveSettings(fetcher: Fetch, origin: string, secret: string, path: string, body: Record<string, unknown>): Promise<Saved> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}${path}`, secret, body);
  const answer = record(json);
  if (status === 200 && answer.ok === false && answer.refused === "nothing_to_undo") return "nothing_to_undo";
  return status === 200 && answer.ok === true ? readSettings(answer) : null;
}

/** `POST /agent-texts/style`: a 1:1 change to the linked person's own settings. */
export const saveTextsStyle = (fetcher: Fetch, origin: string, secret: string, phone: string, ask: Ask) =>
  saveSettings(fetcher, origin, secret, "/agent-texts/style", { phone, ...ask });

/** `POST /agent-texts/group/style`: a group change, with who made it. */
export const saveGroupStyle = (fetcher: Fetch, origin: string, secret: string, line: string, groupId: string, ask: Ask, setBy: string) =>
  saveSettings(fetcher, origin, secret, "/agent-texts/group/style", { line, groupId, setBy, ...ask });

/**
 * A 1:1 text that is about the settings: the menu, a reply to it, or plain
 * words. The text to send back, or null when it is anything else.
 */
export async function textSettings(
  text: string,
  settings: Settings,
  menu: { state: () => Promise<MenuState | undefined>; open: (step?: SettingStep) => Promise<void>; close: () => Promise<void> },
  save: (ask: Ask) => Promise<Saved>,
): Promise<string | null> {
  if (asksForSettings(text)) return await menu.open(), settingsMenu(settings);
  const state = await menu.state();
  const reply = state ? menuReply(text, state, false) : null;
  if (reply?.kind === "menu" && reply.step !== "engagement") return await menu.open(reply.step), settingChoices(reply.step, settings);
  const ask = reply?.kind === "set" ? reply.ask : styleWords(text);
  if (ask === null) return null;
  await menu.close();
  const saved = await save(ask);
  if (saved === "nothing_to_undo") return NOTHING_TO_UNDO;
  return saved === null ? null : settingSaid(ask, saved);
}
