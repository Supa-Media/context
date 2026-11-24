/**
 * The Tex Architecture Lab's shapes (tex.lc/lab). The Lab is a port of
 * the "Tex Architecture Lab" artifact (Dev2, 2026-11-13: "EXACTLY like the
 * artifact"), so these name what that page's script kept in plain objects.
 */

/** How a wire runs: the next step, a helper inside a step, after the reply, a background job, a send-back, or a step run ahead. */
export type WireMode = "wait" | "uses" | "background" | "job" | "loop" | "provisional" | "generator";

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
  /** Which tools the step's model is shown (`packages/tex/gateway/agent/sixToolsFixed.js`): what its turn holds, or the fixed list of its kind of chat. */
  toolList?: "turn" | "fixed";
  /** When the step's rarely-changing modules are read (`packages/tex/gateway/agent/frozenModules.js`): each turn, or once a day until the next summary. */
  freeze?: "turn" | "summary";
  kind?: "input" | "tool";
  outSchema?: OutField[];
  sendBack?: number;
  x: number;
  y: number;
  /** The config group this step belongs to (`texConfig.json`'s node `group`); a folded group's box has none. */
  group?: string;
  /** The Lab page the step lives on (`texConfig.json`'s node `graph`, `engine/pages.ts`); none is "texting". */
  graph?: "texting" | "nightly" | "search";
  /**
   * A step's own settings: a search step's numbers (`apps/mcp/src/search/config/searchConfig.json`, bounded by
   * `SEARCH_SETTINGS_BOUNDS`), or a Tex code step's numbers, switches and choices, each declared by its code
   * (`packages/tex/src/texNodeSettings.cjs`).
   */
  settings?: Record<string, number | boolean | string>;
};

/** `allow`, on a provisional wire only: what its step may do before the go ("revertible" when absent; Dev2, 2026-11-17). */
/** `unless`, on a provisional wire only: bursts that do not start it early. `firstLook` and `sms` are required (the config check refuses a wire that drops either); `unpaired` may be absent. */
export type LabEdge = { from: string; to: string; mode: WireMode; when: string[]; allow?: "read" | "revertible"; unless?: string[] };

export type LabModel = {
  name: string;
  full: string;
  id?: string;
  c: string;
  /** "claude": on the Claude subscription (saved before 2026-11-15 as "subscription", read the same). */
  runs: "claude" | "subscription" | "api" | "code";
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
  /** True when it doesn't change between texts (its `changes` tier is not "text"); derived, kept for the views that ask. */
  stable?: boolean;
  /** How often it changes (`packages/tex/src/texModuleChange.cjs`): sets where it runs among a step's reads. */
  changes?: "fixed" | "summary" | "grows" | "text";
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
  /** The draft's own group boxes (label, goal, icon, place, the group it sits in) over main's config `groups` (`data/graph.ts` `groupsOf`). */
  groups?: Record<string, { label: string; goal?: string; icon?: string; x?: number; y?: number; parent?: string }>;
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
  /** The main it was made from (`texConfigStamp.cjs`); Promote merges only what changed since. */
  base?: string;
  /** For an older draft with no `base`: when the main it starts from was main (a copy keeps the original's). */
  madeAt?: number;
  /** Its revision on the server, and the AI client last in it over the MCP (`engine/live.ts`). */
  rev?: number;
  live?: { client: string; at: number } | null;
  /**
   * Where its Promote stands (`texLabPromote.ts`): asked, its pull request opened, or why it was refused; a refusal
   * over things main changed too names each clash, and the next ask carries the person's picks.
   */
  promote?: { state: string; pr: string | null; why: string | null; clashes?: { what: string; main: string; draft: string; pick: boolean }[]; picks?: { what: string; take: "main" | "draft" }[] } | null;
};

/**
 * One bench case as the Lab shows it (the artifact's CASES rows; fields vary by area). A node case (area `node:<id>`)
 * carries `given` (its input fields) and `want` (per output field, an exact value or a judge's words). `removed` is a
 * case traded out of a full step, and `replaces` names the case a new one took the place of (`engine/cases.ts`).
 */
export type LabCase = {
  area: string;
  id: string;
  ask: string;
  expect: string;
  isNew?: boolean;
  given?: Record<string, string>;
  want?: Record<string, { is?: string; judge?: string }>;
  removed?: boolean;
  replaces?: string;
  [k: string]: unknown;
};

export type Selection = { t: "node"; id: string } | { t: "edge"; i: number } | null;

export type View = "canvas" | "modules" | "convo" | "tools" | "sim" | "tests" | "run" | "compare" | "evals";
export type Tool = "sel" | "con" | "pan";
