/**
 * Every write a project's task list makes, planned before anything is sent.
 *
 * A task is a note or a folder with a `status` (a folder's is its front
 * note's). The page's folder holds the tasks; a task folder holds its
 * subtasks; and nothing goes deeper — the two-level rule of `rows: projects`
 * (see "A project is anything with a status" in
 * `docs/decisions/folder-lists.md`). The writes are the ones the console
 * already makes and nothing else: a new note (`writeNote` with no version, so
 * the server refuses to replace one that appeared), a move (`moveEntry`,
 * which rewrites links to what moved), and frontmatter lines (`setProperties`,
 * the `writeNoteProperty` road). No database, no new kind of file.
 *
 * ## Plan, then run
 *
 * `plan*` functions are pure: they take what the device knows (`TaskSnapshot`)
 * and return the steps, or the sentence saying why not — before anything
 * moves, so a refusal never leaves half a change behind. `runTaskPlan` sends
 * the steps in order through whatever `TaskWriteIO` it is handed; if one
 * fails, the ones already sent are taken back, and the result is the reason.
 * What it hands back on success is an `undo`, the inverse steps in reverse
 * order, the way `useCreateAndMove.move` offers one.
 *
 * ## A task that is one note gets its first subtask
 *
 * `x/task.md` becomes a folder: it moves to `x/task/overview.md` (the first
 * front-note name, `NEW_FRONT_NOTE`) and the subtask is written beside it.
 * The move is `moveEntry`, so every link to the task follows it. Nothing is
 * converted back when the last subtask leaves; a folder with only its front
 * note is still one task.
 */

import { setNoteProperty } from "../../../../../../mcp/src/lists.js";
import { FRONT_NOTES } from "../../../../../../mcp/src/lists/grammar.js";
import { toFileError } from "../../browser/errors";
import type { ListNote } from "../../listBlock/model";
import type { PropertyWriteValue } from "../../listBlock/writeProperty";
import { baseName, parentPath } from "../../paths";
import type { StatusList } from "../statuses";
import { cleanTitle, foldName, namesUnder, taskStem, uniqueEntryName, uniqueStem } from "./taskNames";
import { PRIORITIES, parseIsoDay, type Priority } from "./taskWords";

/** A task as a folder page's item knows it (`FolderItem` fits). */
export interface TaskRef {
  /** The note's path, or the folder's. */
  readonly path: string;
  readonly kind: "note" | "folder";
  /** Where its properties are written: the note, or the folder's front note. */
  readonly target: string;
  /** `target` does not exist yet. */
  readonly creates: boolean;
  readonly label: string;
  /** As written and trimmed; `""` for none. */
  readonly status: string;
}

/** What the device knows around the page. */
export interface TaskSnapshot {
  /** The page's folder: what is directly in it are tasks, and what is in those, subtasks. */
  readonly folder: string;
  /** The notes at and under `folder`, with their properties (`FolderNotes.notes`). */
  readonly notes: readonly Pick<ListNote, "path" | "properties">[];
  /** Any other paths the listings show — attachments, empty folders — so a new name misses them too. */
  readonly paths?: readonly string[];
}

export interface NewTask {
  readonly title: string;
  readonly status: string;
  readonly priority?: Priority | null;
  /** One owner is written as a line, several as a list. */
  readonly owners?: readonly string[];
  readonly tags?: readonly string[];
  /** `YYYY-MM-DD`. */
  readonly due?: string | null;
}

type Changes = readonly (readonly [string, PropertyWriteValue])[];

export type TaskStep =
  | { readonly kind: "create"; readonly path: string; readonly text: string }
  | { readonly kind: "move"; readonly from: string; readonly to: string }
  | {
      readonly kind: "set";
      readonly path: string;
      readonly changes: Changes;
      readonly creates: boolean;
      /** The same keys as they were, for undo. */
      readonly previous: Changes;
    };

export interface TaskPlan {
  readonly steps: readonly TaskStep[];
  /** Where the task acted on ends up (a new task's note). */
  readonly path: string;
  /** What the toast says once it is done. */
  readonly message: string;
  /** The folders whose listings change, for the caller to refresh. */
  readonly touched: readonly string[];
}

export type Planned = { readonly ok: true; readonly plan: TaskPlan } | { readonly ok: false; readonly problem: string };

/** A task note's front note once it becomes a folder: the first front-note name (`model.NEW_FRONT_NOTE`). */
export const NEW_FRONT_NOTE = FRONT_NOTES[0]!;

const refuse = (problem: string): Planned => ({ ok: false, problem });
const quote = (label: string) => `“${label}”`;

/* ------------------------------ what is where ----------------------------- */

function allPaths(snapshot: TaskSnapshot): string[] {
  return [...snapshot.notes.map((note) => note.path), ...(snapshot.paths ?? [])];
}

function statusOf(note: Pick<ListNote, "properties"> | undefined): string {
  const raw = note?.properties.status;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

/** Whether a task folder holds anything with a status: a note beside its front note, or a folder whose front note has one. */
export function hasSubtasks(folder: string, notes: TaskSnapshot["notes"]): boolean {
  const prefix = `${folder}/`;
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const subfolders = new Set<string>();
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    const rest = note.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (!FRONT_NOTES.includes(rest) && statusOf(note) !== "") return true;
    } else subfolders.add(`${prefix}${rest.slice(0, slash)}`);
  }
  for (const sub of subfolders) {
    const front = FRONT_NOTES.map((name) => byPath.get(`${sub}/${name}`)).find((note) => note !== undefined);
    if (statusOf(front) !== "") return true;
  }
  return false;
}

/** The folder a task's subtasks live in: itself, or what a note becomes. */
function subtaskFolder(task: TaskRef): string {
  return task.kind === "folder" ? task.path : task.path.replace(/\.md$/i, "");
}

/** The move that turns a one-note task into a folder, or why it cannot. */
function conversion(task: TaskRef, paths: readonly string[]): { step: TaskStep | null } | { problem: string } {
  if (task.kind === "folder") return { step: null };
  const folder = subtaskFolder(task);
  if (folder === task.path) return { problem: `${quote(task.label)} can’t hold subtasks.` };
  const folded = foldName(folder);
  if (paths.map(foldName).some((path) => path === folded || path.startsWith(`${folded}/`))) {
    return { problem: `There is already a folder called ${quote(baseName(folder))} beside ${quote(task.label)}.` };
  }
  return { step: { kind: "move", from: task.path, to: `${folder}/${NEW_FRONT_NOTE}` } };
}

const TWO_LEVELS = (label: string) => `${quote(label)} is already a subtask, and a subtask can’t have subtasks of its own.`;

/* ------------------------------- new tasks ------------------------------- */

/** The note a new task is written as: its frontmatter, then `# Title`. */
export function newTaskText(task: NewTask): { text: string } | { problem: string } {
  const title = cleanTitle(task.title);
  if (title === "") return { problem: "Give the task a name." };
  const status = task.status.trim();
  if (status === "") return { problem: "A task needs a status." };
  if (task.priority != null && !PRIORITIES.includes(task.priority)) return { problem: "That priority isn’t one of Urgent, High, Medium or Low." };
  if (task.due != null && parseIsoDay(task.due) === null) return { problem: "That due date isn’t a day." };
  const owners = dedupe(task.owners ?? []);
  const tags = dedupe(task.tags ?? []);
  const changes: [string, PropertyWriteValue][] = [["status", status]];
  if (task.priority != null) changes.push(["priority", task.priority]);
  if (owners.length === 1) changes.push(["owner", owners[0]!]);
  if (owners.length > 1) changes.push(["owner", owners]);
  if (tags.length > 0) changes.push(["tags", tags]);
  if (task.due != null) changes.push(["due", task.due.trim()]);
  let text = `# ${title}\n`;
  for (const [key, value] of changes) {
    const changed = setNoteProperty(text, key, value) as { text: string } | { error: string };
    if ("error" in changed) return { problem: `That can’t be saved: ${changed.error}.` };
    text = changed.text;
  }
  return { text };
}

function dedupe(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed === "" || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
  }
  return out;
}

/**
 * A new task in `folder`, named after its title and unique there (see
 * `taskNames.ts`). `existing` is every path the device knows in or under it.
 */
export function planNewTask(task: NewTask & { readonly folder: string }, existing: readonly string[]): Planned {
  const body = newTaskText(task);
  if ("problem" in body) return refuse(body.problem);
  const name = `${uniqueStem(taskStem(task.title), namesUnder(task.folder, existing))}.md`;
  const path = task.folder === "" ? name : `${task.folder}/${name}`;
  return {
    ok: true,
    plan: { steps: [{ kind: "create", path, text: body.text }], path, message: `Added ${quote(cleanTitle(task.title))}.`, touched: [task.folder] },
  };
}

/**
 * A subtask of `parent`: written inside it, after turning it into a folder
 * when it is one note. Refused under a task that is itself a subtask.
 */
export function planAddSubtask(parent: TaskRef, task: NewTask, snapshot: TaskSnapshot): Planned {
  if (parentPath(parent.path) !== snapshot.folder) return refuse(TWO_LEVELS(parent.label));
  const paths = allPaths(snapshot);
  const converted = conversion(parent, paths);
  if ("problem" in converted) return refuse(converted.problem);
  const folder = subtaskFolder(parent);
  const known = converted.step === null ? paths : [...paths, `${folder}/${NEW_FRONT_NOTE}`];
  const planned = planNewTask({ ...task, folder }, known);
  if (!planned.ok) return planned;
  const steps = converted.step === null ? planned.plan.steps : [converted.step, ...planned.plan.steps];
  return {
    ok: true,
    plan: {
      ...planned.plan,
      steps,
      message: `Added ${quote(cleanTitle(task.title))} to ${quote(parent.label)}.`,
      touched: [snapshot.folder, folder],
    },
  };
}

/**
 * A plain note — a heading and no status, so it is not a subtask — inside
 * `task`, after turning it into a folder when it is one note (the same move
 * a first subtask makes). A task or a subtask may hold notes; nothing deeper.
 */
export function planAddNote(task: TaskRef, title: string, snapshot: TaskSnapshot): Planned {
  const { folder } = snapshot;
  const parent = parentPath(task.path);
  if (!isUnder(task.path, folder) || (parent !== folder && parentPath(parent) !== folder)) {
    return refuse(`${quote(task.label)} isn’t a task of this project.`);
  }
  const name = cleanTitle(title);
  if (name === "") return refuse("Give the note a name.");
  const paths = allPaths(snapshot);
  const converted = conversion(task, paths);
  if ("problem" in converted) return refuse(converted.problem);
  const into = subtaskFolder(task);
  const taken = namesUnder(into, paths);
  if (converted.step !== null) taken.add(NEW_FRONT_NOTE);
  const path = `${into}/${uniqueStem(taskStem(name), taken)}.md`;
  const create: TaskStep = { kind: "create", path, text: `# ${name}\n` };
  return {
    ok: true,
    plan: {
      steps: converted.step === null ? [create] : [converted.step, create],
      path,
      message: `Added the note ${quote(name)} to ${quote(task.label)}.`,
      touched: [folder, into],
    },
  };
}

/* ------------------------------ moving tasks ----------------------------- */

function isUnder(path: string, folder: string): boolean {
  return folder === "" || path.startsWith(`${folder}/`);
}

/** `task` moved to be a subtask of `onto` — the drop on a task's middle. */
export function planNest(task: TaskRef, onto: TaskRef, snapshot: TaskSnapshot): Planned {
  const { folder } = snapshot;
  if (task.path === onto.path || onto.path.startsWith(`${task.path}/`)) return refuse(`${quote(task.label)} can’t be a subtask of itself.`);
  if (!isUnder(task.path, folder) || !isUnder(onto.path, folder)) return refuse("That task isn’t in this project.");
  if (parentPath(onto.path) !== folder) return refuse(TWO_LEVELS(onto.label));
  if (task.kind === "folder" && hasSubtasks(task.path, snapshot.notes)) {
    return refuse(`${quote(task.label)} has subtasks of its own, so it can’t go under another task.`);
  }
  const into = subtaskFolder(onto);
  if (parentPath(task.path) === into) return refuse(`${quote(task.label)} is already a subtask of ${quote(onto.label)}.`);
  const paths = allPaths(snapshot);
  const converted = conversion(onto, paths);
  if ("problem" in converted) return refuse(converted.problem);
  const taken = namesUnder(into, paths.filter((path) => !isUnder(path, task.path) && path !== task.path));
  if (converted.step !== null) taken.add(NEW_FRONT_NOTE);
  const to = `${into}/${uniqueEntryName(baseName(task.path), task.kind === "note", taken)}`;
  const steps: TaskStep[] = [...(converted.step === null ? [] : [converted.step]), { kind: "move", from: task.path, to }];
  return {
    ok: true,
    plan: { steps, path: to, message: `Made ${quote(task.label)} a subtask of ${quote(onto.label)}.`, touched: [parentPath(task.path), into, folder] },
  };
}

/** A subtask moved out to be a task of the project again. */
export function planUnnest(task: TaskRef, snapshot: TaskSnapshot): Planned {
  const { folder } = snapshot;
  const parent = parentPath(task.path);
  if (parent === folder || !isUnder(task.path, folder) || parentPath(parent) !== folder) {
    return refuse(`${quote(task.label)} isn’t a subtask.`);
  }
  const taken = namesUnder(folder, allPaths(snapshot));
  const to = `${folder === "" ? "" : `${folder}/`}${uniqueEntryName(baseName(task.path), task.kind === "note", taken)}`;
  return {
    ok: true,
    plan: {
      steps: [{ kind: "move", from: task.path, to }],
      path: to,
      message: `${quote(task.label)} is a task of its own again.`,
      touched: [parent, folder],
    },
  };
}

/** The folder's word for Backlog, as its list spells it; null when it has none. */
export function backlogWord(list: StatusList): string | null {
  for (const words of Object.values(list)) {
    const found = words.find((word) => word.trim().toLowerCase() === "backlog");
    if (found !== undefined) return found;
  }
  return null;
}

/** `task`'s status set to the folder's Backlog word. */
export function planPark(task: TaskRef, list: StatusList): Planned {
  const word = backlogWord(list);
  if (word === null) return refuse("This project has no Backlog.");
  if (task.status.toLowerCase() === word.toLowerCase()) return refuse(`${quote(task.label)} is already in Backlog.`);
  return {
    ok: true,
    plan: {
      steps: [
        { kind: "set", path: task.target, changes: [["status", word]], creates: task.creates, previous: [["status", task.status === "" ? null : task.status]] },
      ],
      path: task.path,
      message: `Moved ${quote(task.label)} to Backlog.`,
      touched: [parentPath(task.target)],
    },
  };
}

/* --------------------------------- running -------------------------------- */

/** The console's own writes, which a plan is run through. */
export interface TaskWriteIO {
  /** A new note; refused (thrown) when something is already there. */
  create(path: string, text: string): Promise<unknown>;
  /** `moveEntry`: a note or folder, with every link to it rewritten. */
  move(from: string, to: string): Promise<unknown>;
  /** `FolderListSource.setProperties`: resolves to why not, or null. */
  setProperties(path: string, changes: Changes, options?: { create?: boolean }): Promise<string | null>;
  /** To the trash — how a created task is undone. Without it a plan that creates has no undo. */
  remove?(path: string): Promise<unknown>;
}

/**
 * `TaskWriteIO` from the console's own actions (`useFileActions`'s
 * `writeNote`, `moveEntry` and `trashEntry`, and the page source's
 * `setProperties`). Null where the page cannot write (`setProperties` absent,
 * a member's page).
 */
export function taskWriteIO<W extends string>(actions: {
  readonly workspaceId: W;
  writeNote(args: { workspaceId: W; path: string; text: string }): Promise<unknown>;
  moveEntry(args: { workspaceId: W; from: string; to: string }): Promise<unknown>;
  trashEntry?(args: { workspaceId: W; path: string }): Promise<unknown>;
  readonly setProperties: TaskWriteIO["setProperties"] | undefined;
}): TaskWriteIO | null {
  const { workspaceId, setProperties, trashEntry } = actions;
  if (setProperties === undefined) return null;
  return {
    create: (path, text) => actions.writeNote({ workspaceId, path, text }),
    move: (from, to) => actions.moveEntry({ workspaceId, from, to }),
    setProperties,
    ...(trashEntry === undefined ? {} : { remove: (path: string) => trashEntry({ workspaceId, path }) }),
  };
}

export type TaskRun =
  | {
      readonly ok: true;
      readonly path: string;
      readonly message: string;
      readonly touched: readonly string[];
      /** Takes the plan back; resolves to why not, or null. Null when it cannot be taken back. */
      readonly undo: (() => Promise<string | null>) | null;
    }
  | { readonly ok: false; readonly problem: string };

async function perform(io: TaskWriteIO, step: TaskStep): Promise<string | null> {
  try {
    if (step.kind === "create") await io.create(step.path, step.text);
    else if (step.kind === "move") await io.move(step.from, step.to);
    else return await io.setProperties(step.path, step.changes, step.creates ? { create: true } : undefined);
    return null;
  } catch (error) {
    return toFileError(error).message;
  }
}

/** The step that takes `step` back, or null when `io` cannot. */
function inverse(io: TaskWriteIO, step: TaskStep): (() => Promise<string | null>) | null {
  const remove = io.remove;
  const attempt = (write: () => Promise<unknown>) => async () => {
    try {
      await write();
      return null;
    } catch (error) {
      return toFileError(error).message;
    }
  };
  if (step.kind === "move") return attempt(() => io.move(step.to, step.from));
  if (step.kind === "create") return remove === undefined ? null : attempt(() => remove(step.path));
  if (step.creates && remove !== undefined) return attempt(() => remove(step.path));
  return () => io.setProperties(step.path, step.previous).catch((error: unknown) => toFileError(error).message);
}

async function unwind(undos: readonly (() => Promise<string | null>)[]): Promise<string | null> {
  for (const undo of [...undos].reverse()) {
    const problem = await undo();
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * Send `plan`'s steps in order. A step that fails takes back the ones before
 * it (as far as `io` can) and the result says why; nothing is left half done
 * that could have been put back.
 */
export async function runTaskPlan(io: TaskWriteIO, plan: TaskPlan): Promise<TaskRun> {
  const done: TaskStep[] = [];
  for (const step of plan.steps) {
    const problem = await perform(io, step);
    if (problem !== null) {
      const back = done.map((each) => inverse(io, each)).filter((undo) => undo !== null);
      await unwind(back);
      return { ok: false, problem };
    }
    done.push(step);
  }
  const undos = done.map((step) => inverse(io, step));
  const undo = undos.every((each) => each !== null) ? () => unwind(undos as (() => Promise<string | null>)[]) : null;
  return { ok: true, path: plan.path, message: plan.message, touched: plan.touched, undo };
}

/** A plan run when there is one; its refusal otherwise. */
export async function runPlanned(io: TaskWriteIO, planned: Planned): Promise<TaskRun> {
  return planned.ok ? runTaskPlan(io, planned.plan) : planned;
}
