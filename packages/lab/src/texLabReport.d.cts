/** Types for `texLabReport.cjs`; see that file. */
export type AreaScore = { practice: [number, number]; held: [number, number]; usd: number };
export type ParsedReport = { at: number; raw: string; areas: Record<string, AreaScore>; pass?: boolean; headline?: string; regressed?: number | null };
export const RAW_MAX: number;
export const REPLAY_HEADING: string;
export function parseReport(txt: string, at?: number): ParsedReport;
export function keptPart(txt: string): string;
