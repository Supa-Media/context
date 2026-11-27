/** Types for `jobResume.cjs`; see that file for the rule and the reasons. */
export interface ResumableEntry { state?: string; startedAt?: number | null; finishedAt?: number | null; resumeAt?: number | null }
export declare const RESUME_MS: number;
export declare function resumeEndsAt(entry: ResumableEntry | null | undefined): number;
export declare function canResume(entry: ResumableEntry | null | undefined, now: number): boolean;
