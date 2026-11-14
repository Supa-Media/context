/** Types for `texGraph.cjs`; see that file for the rules and the reasons. */

export type WireMode = "wait" | "background" | "uses" | "loop" | "job";
export interface GraphWire { from: string; to: string; mode: string; when?: string[]; rounds?: number }
export interface GraphField { name: string; type?: "text" | "yesno" | "score" | "number" | "choice" | "ids" | "list" | "object" | "any" | string; options?: string; optional?: boolean }
export interface GraphNode { id: string; on?: boolean; rounds?: number; kind?: string; inSchema?: GraphField[]; outSchema?: GraphField[]; [key: string]: unknown }
export interface GraphConfig { nodes: GraphNode[]; edges: GraphWire[] }

export interface NodeIO<Ctx = Record<string, unknown>> {
  node: GraphNode;
  ctx: Ctx;
  /** The nodes this one's `uses` wires reach; any other name throws. */
  use: Record<string, (input: unknown) => Promise<unknown>>;
  /** The nodes this one's `loop` wires reach, at most their `rounds` times; the target runs, then the wait path back to this node. */
  back: Record<string, (input: unknown) => Promise<unknown>>;
  /** The nodes this one's `job` wires reach, started in the background. */
  job: Record<string, (input: unknown) => Promise<unknown>>;
}
export type NodeImpl<Ctx = Record<string, unknown>> = (input: any, io: NodeIO<Ctx>) => Promise<any>;

export interface NodeRun { node: string; input: unknown; output: unknown; ms: number; ok: boolean; error?: string; at: number; via: string; handedOff?: boolean }

export interface Graph<Ctx = Record<string, unknown>> {
  run(start: string, input: unknown, ctx?: Ctx, options?: { stopAt?: string[] }): Promise<{ outputs: Record<string, any>; ran: string[] }>;
  fire(from: string, to: string, input: unknown, ctx?: Ctx): Promise<any>;
  runNode(id: string, input: unknown, ctx: Ctx, via: string): Promise<{ ran: boolean; output?: any; handedOff?: boolean }>;
  order(start: string): string[];
}

export declare const MODES: readonly WireMode[];
export declare class GraphError extends Error {}
export declare function createGraph<Ctx = Record<string, unknown>>(
  config: GraphConfig,
  impls: Record<string, NodeImpl<Ctx>>,
  options?: { log?: (run: NodeRun) => unknown; background?: (p: Promise<unknown>) => void; handOff?: (id: string, input: unknown, ctx: Ctx) => Promise<unknown>; now?: () => number },
): Graph<Ctx>;
export declare function problemsOf(config: GraphConfig): string[];
export declare function coverageProblems(config: GraphConfig, processes: Record<string, string[]>): string[];
export declare function checkShape(id: string, which: "input" | "output", value: unknown, schema?: GraphField[]): void;
export declare function fires(edge: GraphWire, output: unknown): boolean;
export declare function tagsOf(output: unknown): string[];
export declare function shaped(value: unknown, schema?: GraphField[]): unknown;
export declare function orderFrom(config: GraphConfig, start: string): string[];
