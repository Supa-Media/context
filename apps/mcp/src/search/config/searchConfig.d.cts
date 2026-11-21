/** Types for `searchConfig.cjs`: search's config as `searchConfig.json` has it, and its schema. */
export declare const SEARCH_SCHEMA_VERSION: number;
export declare const SEARCH_SETTINGS_BOUNDS: Readonly<Record<string, { min: number; max: number; integer: boolean }>>;
export declare const SETTINGS_OF: Readonly<Record<string, readonly string[]>>;
export declare const SEARCH_CONFIG: typeof import("./searchConfig.json");
export declare function searchConfigProblems(config: unknown): string[];
export declare function searchConfigOf<T>(config: T): T;
export declare function settingProblem(name: string, value: unknown): string | null;
export declare function settingsOf(id: string, config?: unknown): Record<string, number>;
