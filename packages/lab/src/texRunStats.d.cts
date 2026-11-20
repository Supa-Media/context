/** Types for `texRunStats.cjs`; see that file for the rules and the reasons. */
import type { BandVerdict } from "./texRunBand.d.cts";

export declare const Z80: number;
export declare function t975(df: number): number;
export declare function rowKey(row: { convId: string; msgIndex: number; node: string }): string;

export interface CountedRow { key: string; convId: string; msgIndex: number; node: string; runs: number; passes: number; rate: number }
export declare function countedRows(results: unknown): CountedRow[];

export interface WilsonInterval { p: number; lo: number; hi: number }
export declare function wilson(passes: number, n: number, z?: number): WilsonInterval;

export interface ClusteredMean { n: number; clusters: number; mean: number; naiveSe: number; clusteredSe: number | null; se: number; df: number }
export declare function clusteredMean(values: readonly number[], clusters: readonly unknown[]): ClusteredMean;

export declare function passHatK(n: number, c: number, k: number): number | null;

export interface RunStatsResult {
  rows: number;
  conversations: number;
  k: number;
  rate: number;
  se: number;
  clustered: boolean;
  lo: number;
  hi: number;
  wilson: { lo: number; hi: number };
  passK: { k: number; rate: number; allPass: number };
}
export declare function runStats(results: unknown): RunStatsResult | null;

export type PairedVerdict = BandVerdict | "too few conversations" | "no shared rows";

export interface PairedRow { convId: string; msgIndex: number; node: string; draft: number; base: number; diff: number }

export interface PairedResult {
  verdict: PairedVerdict;
  why: string;
  rows: number;
  conversations: number;
  onlyDraft: number;
  onlyBase: number;
  mean: number;
  se: number;
  naiveSe: number;
  clustered: boolean;
  lo: number;
  hi: number;
  mde: number;
  meanRows: number;
  loRows: number;
  hiRows: number;
  mdeRows: number;
  world: { draftMisses: number | null; baseMisses: number | null };
  sameWorld: boolean;
  perRow: PairedRow[];
}

export interface PairedNoShared { verdict: "no shared rows"; why: string; rows: 0; onlyDraft: number; onlyBase: number }

export type Paired = PairedResult | PairedNoShared;

export declare function pairedCompare(draft: unknown, base: unknown): Paired;

export interface ComparedRuns {
  verdict: PairedVerdict;
  why: string;
  paired: Paired | null;
  band: { verdict: BandVerdict; why: string };
}
export declare function compareRuns(draft: unknown, base: unknown): ComparedRuns;

export declare function pairedWords(p: Paired | null | undefined): string;
export declare function statsWords(s: RunStatsResult | null | undefined): string;
