export declare const NIGHTLY_PAGE: "nightly";
export declare const NIGHTLY_PATH: string;
export declare const NIGHTLY_VERSION: number;
export declare const NIGHTLY_ABOUT: string;
export declare function joinConfigs<T>(tex: T, nightly: unknown): T;
export declare function splitConfig<T extends { nodes: Array<{ id: string; graph?: string }>; edges: Array<{ from: string; to: string }> }>(config: T): { tex: T; nightly: { nightlyConfig: number; about: string; nodes: unknown[]; edges: unknown[] } };
export declare function nightlyText(nightly: { nightlyConfig: number; about: string; nodes: unknown[]; edges: unknown[] }): string;
