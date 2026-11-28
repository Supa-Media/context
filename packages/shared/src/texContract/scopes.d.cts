/** Types for `scopes.cjs`; see that file for the reasons. */

export declare const SCOPE_READ: "context:read";
export declare const SCOPE_WRITE: "context:write";
export declare const SCOPE_PRIVATE: "context:private";
export declare function hasScope(session: { scopes?: readonly string[] } | null | undefined, scope: string): boolean;
