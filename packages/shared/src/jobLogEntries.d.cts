/** Types for `jobLogEntries.cjs`; see that file. */

export type JobLogDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type JobLogRead = { etag: string; body: string } | { missing: true } | null;

export declare function clock(now: number, timeZone: string): string;
export declare function readWithEtag(dispatch: JobLogDispatch, path: string): Promise<JobLogRead>;
export declare function refusalWords(result: unknown): string;
export declare function appendLogEntry(dispatch: JobLogDispatch, path: string, entry: string, heading: string, extra?: { images?: unknown[] | null }): Promise<boolean>;
export declare function appendLogEntryWhy(dispatch: JobLogDispatch, path: string, entry: string, heading: string, options?: { images?: unknown[] | null }): Promise<string | null>;
