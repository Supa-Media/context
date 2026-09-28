/**
 * A task row's menu, once: what it offers a row (`taskMenu.ts`) and what
 * picking an id does (`menuRun.ts`), for every surface that reaches it — the
 * right-click popover, the phone's ⋯ and press-and-hold sheet, and a swipe
 * left. None of them keeps a list of its own; each asks this.
 *
 * It also holds the one small step a pick can lead to (an owner picked, a new
 * tag typed, a day typed), which `TaskMenu` draws where the menu was.
 */

import { useCallback, useMemo, useState } from "react";
import { groupLabel } from "../../listBlock/words";
import type { MenuItem } from "../../menuItem";
import { PriorityGlyph } from "../Glyphs";
import { ownerLabel, type OwnerChoice } from "../items";
import type { FolderItem } from "../model";
import type { StatusMenuSection } from "../statuses";
import { dueOf, ownersOf, tagsOf } from "../taskProps";
import { runMenuAction, writtenPriority, type MenuAsk } from "./menuRun";
import type { SheetValues } from "./phoneSheet";
import type { ProjectRef } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import { taskMenuAction, taskMenuItems } from "./taskMenu";
import { dueLabel } from "./taskWords";
import type { TaskControls } from "./useTaskActions";

export type Anchor = { readonly x: number; readonly y: number };

export interface TaskMenuModel {
  /** The menu for the row at `path`, or null for one no longer on the page. */
  itemsFor(path: string): MenuItem<string>[] | null;
  /** What the row at `path` is set to, as its phone sheet shows it. */
  valuesFor(path: string): SheetValues;
  /** Do what `id` asks of the row at `path`; a step that needs a field opens it at `anchor`. */
  select(path: string, id: string, anchor: Anchor): void;
  /** The step a pick is waiting on, if any. */
  readonly asking: { readonly kind: MenuAsk; readonly path: string; readonly anchor: Anchor } | null;
  endAsk(): void;
}

export interface TaskMenuOptions {
  controls: TaskControls | null;
  host: TaskHost | undefined;
  items: readonly FolderItem[];
  statusSections: readonly StatusMenuSection[];
  projects: readonly ProjectRef[];
  me: string | null;
  owners: OwnerChoice | undefined;
  makeTaskLabel: string;
  onOpen: (item: FolderItem) => void;
  onMakeTask: (item: FolderItem) => void;
}

const two = (words: readonly string[]) => (words.length <= 2 ? words.join(", ") : `${words.slice(0, 2).join(", ")} +${words.length - 2}`);

export function useTaskMenu(options: TaskMenuOptions): TaskMenuModel {
  const { controls, host, items, statusSections, projects, me, owners, makeTaskLabel, onOpen, onMakeTask } = options;
  const [asking, setAsking] = useState<TaskMenuModel["asking"]>(null);

  const itemsFor = useCallback(
    (path: string): MenuItem<string>[] | null => {
      const entry = controls?.lookup(path);
      if (controls === null || entry === undefined) return null;
      const { item, parent } = entry;
      const list = taskMenuItems({
        kind: item.status === "" ? "note" : "task",
        status: item.status,
        priority: writtenPriority(item),
        owners: ownersOf(item.properties),
        tags: tagsOf(item.properties),
        hasDue: dueOf(item.properties) !== null,
        isSubtask: parent !== null,
        hasSubtasks: item.progress !== null,
        statusSections,
        backlog: controls.backlog,
        nestTargets: items
          .filter((each) => each.status !== "" && each.path !== item.path && each.path !== parent?.path)
          .map((each) => ({ path: each.path, label: each.label })),
        projects,
        tagsInUse: controls.tagSuggestions,
        me,
        ownerLabel: (value) => ownerLabel(owners, value),
        canCopyLink: host?.copyLink !== undefined,
        canArchive: host?.archive !== undefined,
        makeTaskLabel,
      });
      // Each priority leads with the glyph its rows are drawn with.
      return list.map((each) =>
        each.id !== "priority" || each.items === undefined
          ? each
          : {
              ...each,
              items: each.items.map((choice) => {
                const scale = choice.id === "priority:none" ? null : (Number(choice.id.slice("priority:p".length)) as 0 | 1 | 2 | 3);
                return { ...choice, leading: <PriorityGlyph priority={scale} /> };
              }),
            },
      );
    },
    [controls, host, items, statusSections, projects, me, owners, makeTaskLabel],
  );

  const valuesFor = useCallback(
    (path: string): SheetValues => {
      const item = controls?.lookup(path)?.item;
      if (item === undefined || item.status === "") return {};
      const due = typeof item.properties.due === "string" && dueOf(item.properties) !== null ? item.properties.due.trim() : null;
      return {
        status: groupLabel("status", item.status),
        owners: two(ownersOf(item.properties).map((owner) => ownerLabel(owners, owner))),
        tags: two(tagsOf(item.properties)),
        ...(due === null ? {} : { due: dueLabel(due, new Date()) }),
      };
    },
    [controls, owners],
  );

  const select = useCallback(
    (path: string, id: string, anchor: Anchor) => {
      const entry = controls?.lookup(path);
      const action = taskMenuAction(id);
      if (controls === null || entry === undefined || action === null) return;
      runMenuAction(action, {
        controls,
        entry,
        me,
        owners,
        projects,
        now: new Date(),
        open: onOpen,
        makeTask: onMakeTask,
        ask: (kind) => setAsking({ kind, path, anchor }),
        ...(host?.copyLink === undefined ? {} : { copyLink: host.copyLink }),
        ...(host?.archive === undefined ? {} : { archive: host.archive }),
      });
    },
    [controls, host, me, owners, projects, onOpen, onMakeTask],
  );

  return useMemo(() => ({ itemsFor, valuesFor, select, asking, endAsk: () => setAsking(null) }), [itemsFor, valuesFor, select, asking]);
}
