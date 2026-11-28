/** Types for `scopeClamp.cjs`; see that file. */

export declare function visibilityTierForGrant(grantScopes: Iterable<string>, role: string): "private" | "team";
export declare function effectiveScopes(grantScopes: Iterable<string>, role: string): string[];
export declare function reachForRole(session: unknown, role: string): { tier: "private" | "team"; canWrite: boolean; grantWrites: boolean };
