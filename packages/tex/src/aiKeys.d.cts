/** Types for `aiKeys.cjs`; see that file. */

export interface AiKeyDef {
  /** Short id. */
  key: string;
  /** The alias on the AI Gateway's Provider Keys page. */
  alias: string;
  /** Whose key it is. */
  owner: string;
  /** The credit it holds, when known. */
  capUsd: number | null;
  /** How much of it is used, as of `usedAsOf`, when known. */
  usedUsd: number | null;
  usedAsOf: string | null;
  /** When it began paying (ISO). */
  since: string;
  /** When its credit lapses (ISO), or null. */
  expires: string | null;
  /** When it refills (ISO), or null. */
  resets: string | null;
  /** Skipped until then (ISO), or null. */
  retiredUntil: string | null;
  note?: string;
  /** The uses it is tried for. */
  uses: readonly string[];
}

export declare const AI_KEYS: readonly AiKeyDef[];
export declare const USES: readonly string[];
export declare const KEY_ALIAS: RegExp;
export declare const MAX_KEY_ALIASES: number;
export declare function keyState(key: AiKeyDef, now?: number): "retired" | "expired" | "used up" | null;
export declare function keysForUse(use: string, now?: number): AiKeyDef[];
export declare function aliasesForUse(use: string, now?: number): string[];
export declare function cleanAliases(list: string | readonly string[] | null | undefined): string[];
export declare function findKey(name: unknown): AiKeyDef | null;
export declare function keyAliasesOf(env: Record<string, unknown> | null | undefined, now?: number): string[];
export declare function keysReport(now?: number): { order: Record<string, string[]>; keys: Array<AiKeyDef & { leftUsd: number | null; state: string }> };
