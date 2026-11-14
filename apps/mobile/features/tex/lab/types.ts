/**
 * The Tex Architecture Lab's shapes (tex.lc/lab). The Lab is a port of
 * the "Tex Architecture Lab" artifact (Dev2, 2026-11-13: "EXACTLY like the
 * artifact"), so these name what that page's script kept in plain objects.
 */

/** How a wire runs: the next step, a helper inside a step, after the reply, a background job, or a send-back. */
export type WireMode = "wait" | "uses" | "behind" | "job" | "loop";

export type FieldType = "yesno" | "choice" | "score" | "text";
export type OutField = { name: string; type: FieldType | string; options?: string };

export type LabNode = {
  id: string;
  label: string;
  goal: string;
  log: boolean;
  on: boolean;
  rounds: number;
  out: number;
  ctx: string[];
  ms: number;
  timeoutS: number;
  areas: string[];
  file: string;
  note: string;
  icon: string;
  model: string;
  effort?: string;
  kind?: "input" | "tool";
  outSchema?: OutField[];
  sendBack?: number;
  x: number;
  y: number;
  /** The config group this step belongs to (`texConfig.json`'s node `group`); a folded group's box has none. */
  group?: string;
};

export type LabEdge = { from: string; to: string; mode: WireMode; when: string[] };

export type LabModel = {
  name: string;
  full: string;
  id?: string;
  c: string;
  runs: "subscription" | "api" | "code";
  base?: number;
  perTok?: number;
  /** Milliseconds per input token not read from the cache; 0.006 when unset. */
  perIn?: number;
  cacheR?: number;
  cacheW?: number;
  outP?: number;
  measured?: boolean;
  typed?: "schema" | "only" | "json";
  note?: string;
  custom?: boolean;
};

export type SourceKind = "chat" | "store" | "ailc" | "prompt" | "code" | "derived" | "special";

export type LabModule = {
  name: string;
  tok: number;
  stable?: boolean;
  about?: string;
  text?: string;
  kind?: SourceKind | string;
  path?: string;
  custom?: boolean;
};

export type ConvoSettings = {
  word: number;
  older: number;
  threads: number;
  days: number;
  dayChars: number;
  slim: boolean;
  classify: "after" | "before";
  tools: Record<string, boolean>;
};

export type LabGraph = {
  nodes: LabNode[];
  edges: LabEdge[];
  /** A folded group's steps and the wires that touch them, kept so a save can unfold it (`engine/groups.ts`). */
  folded?: Record<string, { nodes: LabNode[]; edges: LabEdge[] }>;
  modules?: Record<string, Partial<LabModule>>;
  models?: Record<string, LabModel>;
  convo?: Partial<ConvoSettings>;
};

export type RunResult = { at: number; areas: Record<string, unknown>; raw: string; [k: string]: unknown };

export type LabVersion = {
  id: string;
  name: string;
  graph: LabGraph;
  picks: Record<string, string[]> | null;
  areas?: string[] | null;
  results: RunResult[];
  authorId: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** Where its Promote stands (`texLabPromote.ts`): asked, its pull request opened, or why it was refused. */
  promote?: { state: string; pr: string | null; why: string | null } | null;
};

/** One bench case as the Lab shows it (the artifact's CASES rows; fields vary by area). */
export type LabCase = { area: string; id: string; ask: string; expect: string; isNew?: boolean; [k: string]: unknown };

export type Selection = { t: "node"; id: string } | { t: "edge"; i: number } | null;

export type View = "canvas" | "modules" | "convo" | "tools" | "sim" | "tests" | "run" | "compare";
export type Tool = "sel" | "con" | "pan";
