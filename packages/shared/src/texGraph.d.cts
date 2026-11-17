/** Types for `texGraph.cjs`; see that file for the rules and the reasons. */

export type WireMode = "wait" | "background" | "uses" | "loop" | "job" | "provisional" | "generator";
export interface GraphWire { from: string; to: string; mode: string; when?: string[]; rounds?: number; /** A provisional wire's: what its target may do before the go. */ allow?: ProvisionalAllow }
export type ProvisionalAllow = "read" | "revertible";
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

export interface NodeRun { node: string; input: unknown; output: unknown; ms: number; /** `ms` less the time it waited on the nodes it called. */ own: number; ok: boolean; error?: string; at: number; via: string; handedOff?: boolean; /** This run's id, unique in the isolate (always set by the runner). */ id?: string; /** The run that started it (its caller, or the node whose wire fed it); none for the start. */ parent?: string }
/** A run as it starts, before its code runs: no output or time yet. */
export interface NodeStart { node: string; id: string; parent?: string; at: number; via: string; input: unknown }

export interface Graph<Ctx = Record<string, unknown>> {
  run(start: string, input: unknown, ctx?: Ctx, options?: { stopAt?: string[] }): Promise<{ outputs: Record<string, any>; ran: string[] }>;
  fire(from: string, to: string, input: unknown, ctx?: Ctx): Promise<any>;
  runNode(id: string, input: unknown, ctx: Ctx, via: string, parent?: string): Promise<{ ran: boolean; output?: any; handedOff?: boolean; id?: string }>;
  order(start: string): string[];
}

export declare const MODES: readonly WireMode[];
export declare class GraphError extends Error {}
export declare function createGraph<Ctx = Record<string, unknown>>(
  config: GraphConfig,
  impls: Record<string, NodeImpl<Ctx>>,
  options?: { log?: (run: NodeRun) => unknown; background?: (p: Promise<unknown>) => void; handOff?: (id: string, input: unknown, ctx: Ctx) => Promise<unknown>; now?: () => number; onStart?: (run: NodeStart) => void },
): Graph<Ctx>;
export declare function problemsOf(config: GraphConfig): string[];
export declare function coverageProblems(config: GraphConfig, processes: Record<string, string[]>, shelf?: string[]): string[];
export declare function checkShape(id: string, which: "input" | "output", value: unknown, schema?: GraphField[]): void;
export declare function fires(edge: GraphWire, output: unknown): boolean;
export declare function tagsOf(output: unknown): string[];
export declare function shaped(value: unknown, schema?: GraphField[]): unknown;
export declare function orderFrom(config: GraphConfig, start: string): string[];

/** How a config runs a step provisionally: its target and, per `provisional` wire with both ends on, the tags that stop or restart it and what it may do before the go. */
export interface ProvisionalWiring { on: boolean; target: string | null; sources: { from: string; stop: string[]; restart: string[]; allow: ProvisionalAllow }[] }
export declare const ALLOW: readonly ProvisionalAllow[];
export declare function provisionalWiring(config: GraphConfig): ProvisionalWiring;
