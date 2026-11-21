/** Types for `architectures.cjs`: every architecture with a config of its own, and moving steps between a draft and its file. */
type Graph = { nodes: Array<Record<string, any>>; edges: Array<Record<string, any>>; [k: string]: any };
export type Architecture = {
  page: string; label: string; file: string; versionKey: string; config: any;
  problems: (config: unknown) => string[]; nodeKeys: readonly string[]; edgeKeys: readonly string[]; promoted: readonly string[]; runs: string;
};
export declare const ARCHITECTURES: readonly Architecture[];
export declare function architectureOf(page: string): Architecture | null;
export declare function isOwnStep(n: unknown): boolean;
export declare function draftStepsOf(entry: Architecture, config?: unknown): Graph;
export declare function ownGraphs(): Graph;
export declare function configFromDraft(graph: unknown, entry: Architecture): Graph | null;
export declare function texSideOf<T>(graph: T): T;
export declare function ownProblems(graph: unknown): string[];
export declare function ownVsMain(graph: unknown): string[];
export declare function promotedConfig(entry: Architecture, graph: unknown, current: any): { config?: any; refused?: string };
