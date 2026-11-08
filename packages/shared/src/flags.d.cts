/** Types for `flags.cjs`; see that file for the rules and the reasons. */

export type FlagMode = "off" | "people" | "everyone";

export interface FlagInfo {
  label: string;
  description: string;
  /** `YYYY-MM-DD`, the day the flag was added. */
  added: string;
  /** `YYYY-MM-DD`, at most `MAX_FLAG_DAYS` after `added`. */
  expires: string;
}

export declare const FLAGS: Readonly<Record<string, FlagInfo>>;
export declare const FLAG_MODES: readonly FlagMode[];
export declare const MAX_FLAG_DAYS: number;
export declare const FLAG_DUE_DAYS: number;
export declare function isFlagId(value: unknown): value is string;
export declare function daysLeft(flag: Pick<FlagInfo, "expires">, today: string): number;
export declare function todayOf(now?: number): string;
export declare function flagProblems(flags: Readonly<Record<string, unknown>>, today: string): string[];
