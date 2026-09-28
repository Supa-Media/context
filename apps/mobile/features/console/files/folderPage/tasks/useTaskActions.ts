/**
 * Everything a project's List does to its tasks, in one place: the composer
 * (adding a task or a subtask), the selection, the drag, and the one road
 * every write takes — plan it (`taskWrites.ts`, `taskEdits.ts`), run it
 * through the console's own writes, draw it at once (`usePendingNotes`),
 * read the folders again, put what was written into this device's copy, and
 * say what happened with an **Undo** beside it.
 *
 * Null for somebody who may not write (a member, whose notes source has no
 * `setProperty`), and where the console handed the page no way to create or
 * move (`FolderPageHost.tasks`): the List then draws exactly what it drew
 * before, with nothing to press.
 *
 * A refusal is said before anything is sent, and a failure part way is taken
 * back (`runTaskPlan`); either is the page's problem line, or — for the
 * composer — the composer's own line, beside what was typed.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { FolderNotes } from "../useFolderPage";
import type { FolderItem } from "../model";
import { taskChildren } from "../model";
import { parentPath } from "../../paths";
import { folderStatuses, type StatusList } from "../statuses";
import { makeItTaskStatus } from "../listLayout";
import type { OwnerChoice } from "../items";
import type { QuickAddTask } from "./QuickAddComposer";
import type { TaskHost } from "./taskHost";
import type { PendingRecord } from "./usePendingNotes";
import { noteFromText } from "./pendingNotes";
import { backlogWord, planAddSubtask, planNewTask, planPark, runTaskPlan, type Planned, type TaskSnapshot, type TaskWriteIO } from "./taskWrites";
import { runManyPlanned, statusPlan, taskRefOf } from "./taskEdits";
import { groupLabel } from "../../listBlock/words";
import { rowDrop, statusDrop, type DropVerdict, type DropZone } from "./taskDrop";
import { tagsInUse } from "./taskWords";
import { isParked, planParkInFolder, planUnpark } from "./backlogFolder";
import type { ListNote } from "../../listBlock/model";

/** Where the composer is open. */
export type ComposerAt =
  | { readonly kind: "task"; readonly section: string; readonly status: string; readonly at: "top" | "end" }
  | { readonly kind: "subtask"; readonly parent: string };

/** A row the List draws, and what it is to the rest of the page. */
export interface IndexedItem {
  readonly item: FolderItem;
  /** The task it is under; null for one of the page's own. */
  readonly parent: FolderItem | null;
}

export interface TaskControls {
  /* adding */
  readonly composer: ComposerAt | null;
  openComposer(at: ComposerAt): void;
  closeComposer(): void;
  addTask(status: string, task: QuickAddTask): Promise<string | null>;
  addSubtask(parent: string, task: QuickAddTask): Promise<string | null>;
  /** "+ Add task", or "+ Add project" on the projects folder itself. */
  readonly addLabel: string;
  /** What the primary button writes: the folder's first To do. */
  readonly firstToDo: string;
  readonly owners: OwnerChoice | undefined;
  readonly tagSuggestions: readonly string[];
  /* writing */
  /** Run one plan with an undo; resolves to why not, or null. Says a refusal on the page unless `quiet`. */
  perform(planned: Planned, options?: { quiet?: boolean; after?: (path: string) => void }): Promise<string | null>;
  /** Several as one change with one undo, said as `message(count)`. */
  performMany(planned: readonly Planned[], message: (count: number) => string): Promise<string | null>;
  readonly snapshot: () => TaskSnapshot;
  readonly lookup: (path: string) => IndexedItem | undefined;
  readonly list: StatusList;
  readonly backlog: string | null;
  /** The page's Backlog folder (`backlog/` in it), where parking moves a row; null for none. */
  readonly backlogFolder: string | null;
  /** What "Move to Backlog" does to `item`: into the Backlog folder, else the Backlog word. */
  parkPlan(item: FolderItem): Planned;
  readonly problem: string | null;
  /* the selection */
  readonly selected: ReadonlySet<string>;
  togglePick(path: string): void;
  clearPicks(): void;
  /* right-click */
  readonly menu: { readonly path: string; readonly anchor: { x: number; y: number } } | null;
  openMenu(item: FolderItem, anchor: { x: number; y: number }): boolean;
  closeMenu(): void;
  /* dragging */
  readonly dragging: string | null;
  startDrag(path: string): void;
  endDrag(): void;
  rowVerdict(target: FolderItem, zone: DropZone): DropVerdict;
  statusVerdict(status: string): DropVerdict;
  /** A drop on the Backlog band or rail: parks the dragged row. */
  parkVerdict(): DropVerdict;
  /** Carry out a verdict on the dragged task. */
  drop(verdict: DropVerdict): void;
}

export function useTaskActions({
  host,
  loaded,
  folder,
  notes,
  rows,
  items,
  list,
  record,
  owners,
  projectsHere,
  backlogFolder = null,
  onRemember,
}: {
  host: TaskHost | undefined;
  loaded: FolderNotes;
  folder: string;
  notes: readonly ListNote[];
  rows: readonly { readonly path: string }[];
  items: readonly FolderItem[];
  list: StatusList;
  record: PendingRecord;
  owners: OwnerChoice | undefined;
  /** The page's rows are projects (`rowsAreProjects`). */
  projectsHere: boolean;
  /** The page's Backlog folder, when it has one (`backlogFolder.ts`). */
  backlogFolder?: string | null;
  /** Puts what a write touched into this device's copy (`FolderListSource.remember`). */
  onRemember: ((written: readonly string[], gone: readonly string[]) => Promise<void>) | undefined;
}): TaskControls | null {
  const [composer, setComposer] = useState<ComposerAt | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<TaskControls["menu"]>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scope, setScope] = useState(folder);
  // The page is reconciled across folders without a key; all of this is about one folder.
  if (scope !== folder) {
    setScope(folder);
    setComposer(null);
    setSelected(new Set());
    setMenu(null);
    setDragging(null);
    setProblem(null);
  }

  const index = useMemo(() => {
    const out = new Map<string, IndexedItem>();
    for (const item of items) {
      out.set(item.path, { item, parent: null });
      if (item.kind !== "folder") continue;
      const children = taskChildren(item.path, notes);
      for (const child of [...children.subtasks, ...children.notes]) out.set(child.path, { item: child, parent: item });
    }
    return out;
  }, [items, notes]);
  const latest = useRef({ index, notes, rows });
  latest.current = { index, notes, rows };

  const snapshot = useCallback(
    (): TaskSnapshot => ({ folder, notes: latest.current.notes, paths: latest.current.rows.map((row) => row.path) }),
    [folder],
  );
  const chooseMany = loaded.chooseMany;
  const say = host?.say;
  const refresh = host?.refresh;
  const hostIO = host?.io;

  /** The console's writes, each drawn at once and noted for the device's copy. */
  const ioFor = useCallback(
    (log: { written: string[]; gone: string[] }): TaskWriteIO | null => {
      if (hostIO === undefined) return null;
      const under = (path: string) => record.known().filter((note) => note.path.startsWith(`${path}/`)).map((note) => note.path);
      return {
        create: async (path, text) => {
          const done = await hostIO.create(path, text);
          record.created(noteFromText(path, text, Date.now()));
          log.written.push(path);
          return done;
        },
        move: async (from, to) => {
          const inside = under(from);
          const done = await hostIO.move(from, to);
          record.moved(from, to);
          if (inside.length === 0) {
            log.written.push(to);
            log.gone.push(from);
          } else {
            log.written.push(...inside.map((path) => `${to}/${path.slice(from.length + 1)}`));
            log.gone.push(...inside);
          }
          return done;
        },
        setProperties: (path, changes, options) => chooseMany(path, changes, options?.create === true),
        ...(hostIO.remove === undefined
          ? {}
          : {
              remove: async (path: string) => {
                const inside = under(path);
                const done = await hostIO.remove!(path);
                record.removed(path);
                log.gone.push(path, ...inside);
                return done;
              },
            }),
      };
    },
    [hostIO, chooseMany, record],
  );

  const settle = useCallback(
    (touched: readonly string[], log: { written: string[]; gone: string[] }) => {
      refresh?.(touched);
      const written = log.written.splice(0);
      const gone = log.gone.splice(0);
      if (written.length + gone.length > 0) void onRemember?.(written, gone);
    },
    [refresh, onRemember],
  );

  const offerUndo = useCallback(
    (message: string, touched: readonly string[], undo: (() => Promise<string | null>) | null, log: { written: string[]; gone: string[] }) => {
      if (say === undefined) return;
      if (undo === null) return say(message);
      let used = false;
      say(message, () => {
        // Once: a second press would try to take back what is already back.
        if (used) return;
        used = true;
        void undo().then((failed) => {
          settle(touched, log);
          if (failed !== null) setProblem(failed);
          else say("Undone.");
        });
      });
    },
    [say, settle],
  );

  const perform = useCallback(
    async (planned: Planned, options: { quiet?: boolean; after?: (path: string) => void } = {}): Promise<string | null> => {
      if (!planned.ok) {
        if (options.quiet !== true) setProblem(planned.problem);
        return planned.problem;
      }
      const log = { written: [] as string[], gone: [] as string[] };
      const io = ioFor(log);
      if (io === null) return "This can’t be changed from here.";
      setProblem(null);
      const run = await runTaskPlan(io, planned.plan);
      settle(planned.plan.touched, log);
      if (!run.ok) {
        if (options.quiet !== true) setProblem(run.problem);
        return run.problem;
      }
      options.after?.(run.path);
      offerUndo(run.message, run.touched, run.undo, log);
      return null;
    },
    [ioFor, settle, offerUndo],
  );

  const performMany = useCallback(
    async (planned: readonly Planned[], message: (count: number) => string): Promise<string | null> => {
      const log = { written: [] as string[], gone: [] as string[] };
      const io = ioFor(log);
      if (io === null) return "This can’t be changed from here.";
      setProblem(null);
      const run = await runManyPlanned(io, planned);
      if (!run.ok) {
        // A first write that failed was taken back; the folder is read again all the same.
        settle([folder], log);
        setProblem(run.problem);
        return run.problem;
      }
      settle(run.touched, log);
      setSelected(new Set());
      if (run.problem !== null) setProblem(run.problem);
      offerUndo(message(run.done), run.touched, run.undo, log);
      return run.problem;
    },
    [ioFor, settle, offerUndo, folder],
  );

  const firstToDo = makeItTaskStatus(list);
  const existing = useCallback(() => [...latest.current.notes.map((note) => note.path), ...latest.current.rows.map((row) => row.path)], []);
  const addTask = useCallback(
    (status: string, task: QuickAddTask) => perform(planNewTask({ ...task, status, folder }, existing()), { quiet: true }),
    [perform, folder, existing],
  );
  const addSubtask = useCallback(
    (under: string, task: QuickAddTask) => {
      const parent = latest.current.index.get(under)?.item;
      if (parent === undefined) return Promise.resolve("That task isn’t here any more.");
      const home = parent.kind === "folder" ? parent.path : parent.path.replace(/\.md$/i, "");
      const status = makeItTaskStatus(folderStatuses(home, latest.current.notes).list);
      return perform(planAddSubtask(taskRefOf(parent), { ...task, status }, snapshot()), {
        quiet: true,
        // A one-note task is a folder now: the composer follows it there.
        after: (path) => setComposer({ kind: "subtask", parent: parentPath(path) }),
      });
    },
    [perform, snapshot],
  );

  const backlog = backlogWord(list);
  // Into the Backlog folder when the page has one and the row is the page's own; else the Backlog word.
  const parkPlan = useCallback(
    (item: FolderItem): Planned => {
      if (backlogFolder !== null && (parentPath(item.path) === folder || isParked(item.path, backlogFolder))) {
        return planParkInFolder(taskRefOf(item), backlogFolder, snapshot());
      }
      return planPark(taskRefOf(item), list);
    },
    [backlogFolder, folder, list, snapshot],
  );
  const draggedItem = useCallback(() => (dragging === null ? undefined : latest.current.index.get(dragging)?.item), [dragging]);
  const parkVerdict = useCallback((): DropVerdict => {
    const dragged = draggedItem();
    if (dragged === undefined) return { kind: "none" };
    const planned = parkPlan(dragged);
    return planned.ok ? { kind: "plan", hint: "Drop here to move to Backlog", planned } : { kind: "none" };
  }, [draggedItem, parkPlan]);
  /** A parked row let go on a status: out of the Backlog folder, with that status. */
  const unparkVerdict = useCallback(
    (dragged: FolderItem, status: string): DropVerdict => {
      const planned = planUnpark(taskRefOf(dragged), backlogFolder!, status, snapshot());
      return planned.ok ? { kind: "plan", hint: `Move out of Backlog to ${groupLabel("status", status)}`, planned } : { kind: "refused", hint: planned.problem };
    },
    [backlogFolder, snapshot],
  );
  const rowVerdict = useCallback(
    (target: FolderItem, zone: DropZone): DropVerdict => {
      const dragged = draggedItem();
      if (dragged === undefined) return { kind: "none" };
      // A row of the Backlog band is Backlog: letting go on it parks, wherever on it.
      if (isParked(target.path, backlogFolder)) return isParked(dragged.path, backlogFolder) ? { kind: "none" } : parkVerdict();
      if (isParked(dragged.path, backlogFolder) && zone !== "middle" && parentPath(target.path) === folder) {
        return unparkVerdict(dragged, target.status);
      }
      return rowDrop(dragged, target, zone, snapshot());
    },
    [draggedItem, backlogFolder, folder, parkVerdict, unparkVerdict, snapshot],
  );
  const statusVerdict = useCallback(
    (status: string): DropVerdict => {
      const dragged = draggedItem();
      if (dragged === undefined) return { kind: "none" };
      if (backlog !== null && status.toLowerCase() === backlog.toLowerCase()) return parkVerdict();
      if (isParked(dragged.path, backlogFolder)) return status === "" ? { kind: "none" } : unparkVerdict(dragged, status);
      return statusDrop(dragged, status);
    },
    [draggedItem, backlog, backlogFolder, parkVerdict, unparkVerdict],
  );
  const drop = useCallback(
    (verdict: DropVerdict) => {
      const dragged = dragging === null ? undefined : latest.current.index.get(dragging)?.item;
      setDragging(null);
      if (dragged === undefined || verdict.kind === "none") return;
      if (verdict.kind === "refused") return setProblem(verdict.hint);
      if (verdict.kind === "plan") return void perform(verdict.planned);
      void perform(statusPlan(dragged, verdict.status));
    },
    [dragging, perform],
  );

  const tagSuggestions = useMemo(() => tagsInUse(notes, folder), [notes, folder]);
  const canWrite = loaded.canEdit && host !== undefined;

  return useMemo<TaskControls | null>(() => {
    if (!canWrite) return null;
    return {
      composer,
      openComposer: (at) => setComposer(at),
      closeComposer: () => setComposer(null),
      addTask,
      addSubtask,
      addLabel: projectsHere ? "+ Add project" : "+ Add task",
      firstToDo,
      owners,
      tagSuggestions,
      perform,
      performMany,
      snapshot,
      lookup: (path) => latest.current.index.get(path),
      list,
      backlog,
      backlogFolder,
      parkPlan,
      problem,
      selected,
      togglePick: (path) =>
        setSelected((current) => {
          const next = new Set(current);
          if (!next.delete(path)) next.add(path);
          return next;
        }),
      clearPicks: () => setSelected(new Set()),
      menu,
      openMenu: (item, anchor) => {
        setMenu({ path: item.path, anchor });
        return true;
      },
      closeMenu: () => setMenu(null),
      dragging,
      startDrag: (path) => setDragging(path),
      endDrag: () => setDragging(null),
      rowVerdict,
      statusVerdict,
      parkVerdict,
      drop,
    };
  }, [
    canWrite, composer, addTask, addSubtask, projectsHere, firstToDo, owners, tagSuggestions, perform, performMany, snapshot, list,
    backlog, backlogFolder, parkPlan, problem, selected, menu, dragging, rowVerdict, statusVerdict, parkVerdict, drop,
  ]);
}
