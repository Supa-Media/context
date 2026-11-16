/**
 * One shape for everything the Lab plays on the canvas and the timeline (Lab live sandbox, approved by Dev2 2026-11-16,
 * mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5; contract /mnt/project-files/lab-live-sandbox/contract.md):
 * a test text in the sandbox, a real text as it ran in production, or one of Tex's texts with only the steps that led
 * to it. Every step here is one the log shows ran (Dev2, 2026-11-14: replay shows only what ran); nothing is estimated.
 */
import type { LabGraph } from "../types";

export type PlayCall = { tool: string; kind: "read" | "write" | "prod"; ms: number; d: string };

export type PlayStep = {
  id: string;
  node: string;
  /** ms from the text's arrival (the line's delay included) to the step's start. */
  at: number;
  /** How long it ran; absent while it is still running. */
  ms?: number;
  ok: boolean;
  out?: unknown;
  in?: unknown;
  think?: string;
  calls?: PlayCall[];
  model?: string;
  effort?: string;
  tokIn?: number;
  tokOut?: number;
  cost?: number;
  /** Ran after the answer, in the background. */
  bg?: boolean;
  /** The step that started it. */
  parent?: string;
};

export type PlayRun = {
  /** The row id of the text it starts from, or `<rowId>#<texRowId>` for the steps behind one of Tex's texts. */
  id: string;
  steps: PlayStep[];
  /** Tex's texts it delivered: when (ms from arrival) and their row ids. */
  texts: Array<{ at: number; rowId: string }>;
  /** ms from arrival to the last thing it did; grows while it runs. */
  total: number;
  /** Still running (a sandbox text): playback may not pass `total`. */
  running: boolean;
  /** The graph Tex had when it ran (a real text), drawn instead of the version open; absent = the version open. */
  graph?: LabGraph;
  /** A real text: when it ran and the version that ran it. */
  prod?: { at: number; code?: string };
  /** For Tex's text: whose steps these are a part of. */
  of?: string;
};

/** Distinct steps (nodes) a run lit. */
export const stepCount = (r: PlayRun) => new Set(r.steps.map((s) => s.node)).size;

/** The steps behind one of Tex's texts: exactly its `cause` ids, in run order; null when the log has none. */
export function causeRun(run: PlayRun, texRowId: string, cause: string[] | undefined): PlayRun | null {
  if (!cause?.length) return null;
  const keep = new Set(cause);
  const steps = run.steps.filter((s) => keep.has(s.id));
  if (!steps.length) return null;
  const text = run.texts.find((t) => t.rowId === texRowId);
  const total = Math.max(text?.at ?? 0, ...steps.map((s) => s.at + (s.ms ?? 0)));
  return { ...run, id: run.id + "#" + texRowId, steps, texts: text ? [text] : [], total, running: false, of: run.id };
}
