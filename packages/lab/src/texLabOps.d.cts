/** Types for `texLabOps.cjs`; see that file. */
export type LabGraphJson = { nodes: Array<Record<string, unknown> & { id: string }>; edges: Array<{ from: string; to: string; mode: string; when: string[] }>; [k: string]: unknown };
export type LabOp =
  | { op: "set"; node: string; field: string; value: unknown }
  | { op: "move"; node: string; x: number; y: number }
  | { op: "add"; node: Record<string, unknown> & { id: string } }
  | { op: "remove"; node: string }
  | { op: "wire"; from: string; to: string; mode: string; when?: string[] }
  | { op: "unwire"; from: string; to: string; mode?: string }
  | { op: "module"; key: string; value: Record<string, unknown> | null }
  | { op: "convo"; field: string; value: unknown }
  | { op: "convo_tool"; tool: string; on: boolean | null }
  | { op: "model"; key: string; value: Record<string, unknown> | null }
  | { op: "put"; graph: LabGraphJson };
export const MODES: string[];
export const NODE_FIELDS: Set<string>;
export const MAX_OPS: number;
export const KEPT_STEPS: Set<string>;
export const FALLBACK_MODEL: string;
export class OpError extends Error {}
export function applyOps<G extends LabGraphJson>(graph: G, ops: LabOp[]): { graph: G; keys: string[]; said: string[]; full: string[] };
export function diffGraphs(a: LabGraphJson, b: LabGraphJson): LabOp[];
export function keysOf(op: LabOp): string[];
export function overlaps(a: string, b: string): boolean;
export function conflicts(keys: string[], touched: string[]): string[];
