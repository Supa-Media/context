/** Types for `texRunBand.cjs`; see that file for the rules and the reasons. */
export interface RunScore { mean: number; min: number; max: number; lo: number; hi: number; repeats: number; total: number }
export type BandVerdict = "wins" | "loses" | "within noise" | "no band" | "no base";
export declare const DEFAULT_REPEATS: number;
export declare const MAX_REPEATS: number;
export declare function repeatsOf(value: unknown): number | null;
export declare function bandOf(passes: readonly number[], total: number): RunScore;
export declare function scoreOfResults(results: unknown): RunScore | null;
export declare function bandVerdict(draft: unknown, base: unknown): { verdict: BandVerdict; why: string };
export declare const CC_FIDELITY: string;
export declare const CC_FIDELITY_WHY: string;
export declare function fidelityOf(models: string | null | undefined): string | null;
