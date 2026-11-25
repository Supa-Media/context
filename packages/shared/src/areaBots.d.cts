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
  /** The bot's card, `areas/people/pipeline.md`: the prompt then has it put its logo there. */
  card?: string;
}): string;
export declare function delegatePrompt(input: { bot: string; kind?: string; whose?: string; workspace?: string; card?: string }): string;

export interface OwnedArea {
  folder: string;
  title?: string;
  modes?: readonly string[];
}
export declare function areasPrompt(input: { bot: string; kind?: string; whose?: string; workspace?: string; areas: readonly OwnedArea[]; reach?: ReachKind }): string;
export declare function setupPrompt(input: {
  bot: string;
  kind?: string;
  whose?: string;
  workspace?: string;
  areas: readonly OwnedArea[];
  reach?: ReachKind;
  /** The bot's card, when it has no logo yet: it is told to put its own there. */
  card?: string;
  /** The MCP address, https://mcp.context.lc/mcp by default. */
  endpoint?: string;
}): string;
