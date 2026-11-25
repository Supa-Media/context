/** Types for `areaBots.cjs`; see that file for the reasons. */

export type BotKind = "grok";
export type ReachKind = "webhook" | "mail";
export type ModeName = "Visionary" | "Manager" | "Doer";

export declare const BOT_KINDS: readonly BotKind[];
export declare const REACH_KINDS: readonly ReachKind[];
export declare const MODE_MEANINGS: Readonly<Record<ModeName, string>>;
export declare const MODE_ORDER: readonly ModeName[];
export declare function botLabel(kind: unknown): string;
export declare function mailJoinName(bot: unknown): string;
export declare function botKind(raw: unknown): BotKind | "";
export declare function reachKind(raw: unknown): ReachKind;
export declare function knownModes(modes: unknown): ModeName[];
export declare function modeLines(modes: unknown, ownerWord?: string): string[];
export declare function areaPrompt(input: {
  bot: string;
  kind?: string;
  whose?: string;
  workspace?: string;
  area: string;
  title?: string;
  modes?: readonly string[];
  reach?: ReachKind;
}): string;
export declare function delegatePrompt(input: { bot: string; kind?: string; whose?: string; workspace?: string }): string;
