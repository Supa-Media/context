/** Types for `texSets.cjs`; see that file. */
export type SetId = "training" | "dev" | "test";
export type Label = { star?: true; run?: "must" | "must not"; must?: string[]; never?: string[]; [field: string]: unknown };
export type Message = {
  id: string; who: string; text: string; tex?: true;
  kind?: "react" | "reply" | "edit" | "delete"; to?: string;
  labels?: Record<string, Label>; rec?: Record<string, Record<string, unknown>>;
  pics?: Pic[];
  /** A trigger row's input (a check-in, a routine, Send through Tex, a background job's report); its `who` is that input's name. */
  via?: "checkin" | "routine" | "notify" | "job";
  /** A job row's state as the job reported it; absent is done. */
  state?: "done" | "running" | "failed" | "waiting" | "stuck";
  /** An optional time line ("Tue 9:20", or "Tue Oct 13 10:14" to anchor the days). */
  at?: string;
};
/** A picture sent with a message: an https address, its type and file name. */
export type Pic = { url: string; type?: string; name?: string };
export type Conversation = { id: string; title: string; set: SetId; kind: "one" | "group"; members: string[]; msgs: Message[]; setting?: string };
export type Fields = { picks: Record<string, string[]>; texts: string[]; lines: boolean };
export type UnitTest = { chat: string; msg: string; at: number; node: string };
export type Ratio = { counts: Record<SetId, number>; total: number; pct: Record<SetId, number>; holds: boolean; off: SetId[] };
type ConfigNode = { id: string; outSchema?: { name: string; type: string; options?: string; optional?: boolean }[] };
type Config = { nodes?: ConfigNode[] };
export const SETS: readonly SetId[];
export const TARGET: Readonly<Record<SetId, number>>;
export const DRIFT: number;
export const KINDS: readonly string[];
export const JOB_STATES: readonly string[];
export const RUN: readonly string[];
export const TEX: "Tex";
export const LABEL_KEYS: readonly string[];
/** The people a Dev conversation may have: the bench's, one world each. */
export const BENCH_PEOPLE: readonly string[];
export function labelFields(node: ConfigNode | undefined, opts?: { why?: string[] }): Fields;
export function check(c: unknown, config: Config, opts?: { why?: string[] }): string[];
export function unitTests(c: Conversation): UnitTest[];
export function before(c: Conversation, at: number): Message[];
export function ratio(input: Conversation[] | Partial<Record<SetId, number>>): Ratio;
