/** Types for `labDraft.cjs`: search's config in a Lab draft. */
type Graph = { nodes: Array<Record<string, any>>; edges: Array<Record<string, any>>; [k: string]: any };
export declare const SEARCH_PAGE: "search";
export declare function isSearchStep(n: unknown): boolean;
export declare function labSearchGraph(config?: unknown): Graph;
export declare function searchConfigFromDraft(graph: unknown): Graph | null;
export declare function texSideOf<T>(graph: T): T;
