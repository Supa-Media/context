/** Types for `texKeys.cjs`; see that file. */

export declare const TEX_KEY: RegExp;
export declare function isTexKey(key: unknown): boolean;
export declare function isTexStateKey(key: unknown): boolean;
export declare function isTexStoreUnavailable(error: unknown): boolean;
export declare const AGENT_HOME_FOLDERS: string[];
export declare const AGENT_HOME_PREFIX: RegExp;
export declare function isAgentHomeKey(key: unknown): boolean;
export declare function splitTexKey(key: unknown): { owner: string; key: string } | null;
export declare function goesToObject(key: unknown, options?: { prefix?: boolean }): boolean;
export declare function texKeyFor(owner: string, idKey: string): string;
export declare function texStateKeyFor(chat: string, name: string): string;
