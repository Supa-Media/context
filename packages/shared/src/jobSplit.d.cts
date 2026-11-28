/** Types for `jobSplit.cjs`; see that file for the rules and the reasons. */
export interface JobSplit { id: string; title: string }
export declare function splitOf(value: unknown): JobSplit | null;
export declare function restartSet<T extends { id: string; title: string; split?: JobSplit | null }>(entries: readonly T[], picked: readonly { id: string }[], resumable: (entry: T) => boolean, names?: readonly string[]): T[];
export declare function groupedJobs<T extends { split?: JobSplit | null }>(entries: readonly T[]): Array<{ job: T } | { split: JobSplit; parts: T[] }>;
export declare function decideSplit(input: { entries?: unknown[]; picked?: unknown[]; resumable?: string[]; names?: string[] }): { restart: string[] };
