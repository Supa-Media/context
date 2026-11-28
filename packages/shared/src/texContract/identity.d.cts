/** Types for `identity.cjs`; see that file. */

export declare const PINNED_CONTEXT_NAME: "@context-lc";
export declare function actorFor(session: any): Record<string, unknown>;
export declare function personalNameFor(session: any): string | null;
export declare function editsPinnedContext(session: any): boolean;
export declare function contextsFor(session: any): { name: string; role: string; kind: string; current: boolean; canWrite: boolean; grantWrites: boolean; tier: string; askerOwn?: true }[];
export declare function contextNameFor(session: any): string;
