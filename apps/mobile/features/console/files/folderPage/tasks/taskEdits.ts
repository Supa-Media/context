/**
 * The rest of a task list's writes, planned the way `taskWrites.ts` plans
 * adding and nesting: a property changed from a menu or a selection, a task
 * moved to another project, and several plans run as one change with one
 * undo. Pure planning, then `runTaskPlan`'s one road for sending.
 *
 * A property change is one `set` step against the note that speaks for the
 * task (a note, or a folder's front note), carrying what the keys held before
 * so its undo writes them back — never a guess at a default. A change that
 * would write what is already there is refused before anything is sent, so a
 * selection of five where two already say Urgent writes three notes and says
 * so, rather than rewriting two to themselves.
 */

import type { PropertyValue } from "../../listBlock/model";
import { groupLabel } from "../../listBlock/words";
import type { PropertyWriteValue } from "../../listBlock/writeProperty";
import { baseName, parentPath } from "../../paths";
import type { FolderItem } from "../model";
import { namesUnder, uniqueEntryName } from "./taskNames";
import { runTaskPlan, type Planned, type TaskPlan, type TaskRef, type TaskRun, type TaskSnapshot, type TaskWriteIO } from "./taskWrites";

const quote = (label: string) => `“${label}”`;
const refuse = (problem: string): Planned => ({ ok: false, problem });

/** What a plan needs to know of a row. */
export function taskRefOf(item: Pick<FolderItem, "path" | "kind" | "target" | "creates" | "label" | "status">): TaskRef {
  return { path: item.path, kind: item.kind, target: item.target, creates: item.creates, label: item.label, status: item.status };
}

/** A property value as a write takes it: one word as a line, several as a list, none as nothing. */
export function wordsValue(words: readonly string[]): PropertyWriteValue {
  if (words.length === 0) return null;
  return words.length === 1 ? words[0]! : [...words];
}

function asWrite(value: PropertyValue | undefined): PropertyWriteValue {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.filter((each): each is string => typeof each === "string");
  return typeof value === "string" ? value : String(value);
}

function same(a: PropertyWriteValue, b: PropertyWriteValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") {
    const one = typeof a === "string" ? [a] : a;
    const other = typeof b === "string" ? [b] : b;
    return one.length === other.length && one.every((word, at) => word.trim() === other[at]!.trim());
  }
  return a.length === b.length && a.every((word, at) => word.trim() === b[at]!.trim());
}

/**
 * `changes` written to `item`, undone to what it held. Refused when every
 * change is what the task already says (`unchanged`, in the owner's words).
 */
export function planSet(
  item: Pick<FolderItem, "path" | "target" | "creates" | "properties">,
  changes: readonly (readonly [string, PropertyWriteValue])[],
  message: string,
  unchanged: string,
): Planned {
  const previous = changes.map(([key]) => [key, asWrite(item.properties[key])] as const);
  const effective = changes.filter(([key, value]) => !same(asWrite(item.properties[key]), value));
  if (effective.length === 0) return refuse(unchanged);
  return {
    ok: true,
    plan: {
      steps: [
        {
          kind: "set",
          path: item.target,
          changes: effective,
          creates: item.creates,
          previous: previous.filter(([key]) => effective.some(([changed]) => changed === key)),
        },
      ],
      path: item.path,
      message,
      touched: [parentPath(item.target)],
    },
  };
}

/** `item` moved to `status`, said in the owner's words. */
export function statusPlan(item: Pick<FolderItem, "path" | "target" | "creates" | "properties" | "label">, status: string): Planned {
  const word = groupLabel("status", status);
  return planSet(item, [["status", status]], `Moved ${quote(item.label)} to ${word}.`, `${quote(item.label)} is already in ${word}.`);
}

/** A project beside this one, by its folder and its name. */
export interface ProjectRef {
  readonly path: string;
  readonly label: string;
}

/** `task` moved into another project, under a name free there. */
export function planMoveToProject(task: TaskRef, project: ProjectRef, snapshot: TaskSnapshot): Planned {
  const from = parentPath(task.path);
  if (from === project.path) return refuse(`${quote(task.label)} is already in ${quote(project.label)}.`);
  if (project.path === task.path || project.path.startsWith(`${task.path}/`)) return refuse(`${quote(task.label)} can’t go inside itself.`);
  const paths = [...snapshot.notes.map((note) => note.path), ...(snapshot.paths ?? [])];
  const taken = namesUnder(project.path, paths);
  const to = `${project.path}/${uniqueEntryName(baseName(task.path), task.kind === "note", taken)}`;
  return {
    ok: true,
    plan: {
      steps: [{ kind: "move", from: task.path, to }],
      path: to,
      message: `Moved ${quote(task.label)} to ${quote(project.label)}.`,
      touched: [from, project.path],
    },
  };
}

/** Several plans run as one change. */
export type ManyRun =
  | {
      readonly ok: true;
      /** How many plans were sent. */
      readonly done: number;
      readonly touched: readonly string[];
      /** Takes every plan back, newest first; null when one of them cannot be. */
      readonly undo: (() => Promise<string | null>) | null;
      /** A plan that failed part way: the ones before it stand, and this says why the rest did not go. */
      readonly problem: string | null;
    }
  | { readonly ok: false; readonly problem: string };

/** A plan that only rewrites frontmatter lines: nothing is created or moved. */
function onlySets(plan: TaskPlan): boolean {
  return plan.steps.every((step) => step.kind === "set");
}

/**
 * Plans sent as one change. Property changes on different notes go out all
 * at once — each is its own read and conditional write, so none waits on
 * another, and a selection of six is as quick as one rather than six times
 * as slow. Anything that creates or moves goes after, one at a time, because
 * a move rewrites links in other notes and two at once could race on the
 * same one; so do two changes that land on the same note.
 *
 * A plan that fails is taken back by `runTaskPlan`. The property changes
 * beside it stand; among the one-at-a-time plans it stops the rest — the rule
 * the file browser's own batches keep (`moveMany`). The ones that went share
 * one undo, and the result says how far it got. Refused plans are skipped: a
 * selection is a request about each task that it fits.
 */
export async function runManyPlanned(io: TaskWriteIO, planned: readonly Planned[]): Promise<ManyRun> {
  const plans = planned.flatMap((each) => (each.ok ? [each.plan] : []));
  if (plans.length === 0) {
    const first = planned.find((each): each is Extract<Planned, { ok: false }> => !each.ok);
    return { ok: false, problem: first?.problem ?? "Nothing to change." };
  }
  const targets = new Set<string>();
  const together: TaskPlan[] = [];
  const inTurn: TaskPlan[] = [];
  for (const plan of plans) {
    const paths = plan.steps.map((step) => (step.kind === "move" ? step.from : step.path));
    if (onlySets(plan) && paths.every((path) => !targets.has(path))) {
      paths.forEach((path) => targets.add(path));
      together.push(plan);
    } else inTurn.push(plan);
  }
  const first: Extract<TaskRun, { ok: true }>[] = [];
  const after: Extract<TaskRun, { ok: true }>[] = [];
  let problem: string | null = null;
  for (const run of await Promise.all(together.map((plan) => runTaskPlan(io, plan)))) {
    if (run.ok) first.push(run);
    else problem ??= run.problem;
  }
  for (const plan of inTurn) {
    if (problem !== null) break;
    const run = await runTaskPlan(io, plan);
    if (!run.ok) problem = run.problem;
    else after.push(run);
  }
  const runs = [...first, ...after];
  if (runs.length === 0) return { ok: false, problem: problem ?? "That didn’t work. Try again." };
  const undo = runs.every((run) => run.undo !== null)
    ? () => undoAll(first.map((run) => run.undo!), after.map((run) => run.undo!))
    : null;
  const touched = [...new Set(runs.flatMap((run) => run.touched))];
  return { ok: true, done: runs.length, touched, undo, problem: problem === null ? null : `${runs.length} of ${plans.length} changed. ${problem}` };
}

type Undo = () => Promise<string | null>;

/**
 * Everything taken back, newest first: what went one at a time, in reverse,
 * then the property changes that went together, again all at once.
 */
async function undoAll(together: readonly Undo[], inTurn: readonly Undo[]): Promise<string | null> {
  for (const undo of [...inTurn].reverse()) {
    const failed = await undo();
    if (failed !== null) return failed;
  }
  const answers = await Promise.all([...together].reverse().map((undo) => undo()));
  return answers.find((answer) => answer !== null) ?? null;
}

/** "1 task" / "3 tasks". */
export function countTasks(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}
