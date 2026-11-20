/** Types for `texModuleChange.cjs`; see that file. */
export type ChangeTier = "fixed" | "summary" | "grows" | "text";
export const TIERS: ChangeTier[];
export const TIER_NAMES: Record<ChangeTier, string>;
export function defaultChange(key: string): ChangeTier;
export function changeOf(key: string, modules?: Record<string, { changes?: string } | undefined> | null): ChangeTier;
export function runOrder(ctx: string[], modules?: Record<string, { changes?: string } | undefined> | null): string[];
export function runMoves(ctx: string[], modules?: Record<string, { changes?: string } | undefined> | null): Array<{ key: string; listed: number; runs: number; changes: ChangeTier }>;
