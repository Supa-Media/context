/**
 * What each row of a task's right-click menu does (`taskMenu.ts` says what
 * is offered). Every write is a plan run through `TaskControls.perform`, so
 * it is drawn at once, said in a toast and offered back with Undo; the words
 * it is said in are the owner's ("“Sign the lease” is Urgent now").
 */

import type { FolderItem } from "../model";
import { priorityOf, tagsOf, ownersOf } from "../taskProps";
import { ownerLabel, type OwnerChoice } from "../items";
import { planMoveToProject, planSet, statusPlan, taskRefOf, wordsValue, type ProjectRef } from "./taskEdits";
import type { TaskMenuAction } from "./taskMenu";
import { planNest, planPark, planUnnest, type Planned } from "./taskWrites";
import { dueLabel, duePreset, priorityLabel, toggleWord, type Priority } from "./taskWords";
import type { IndexedItem, TaskControls } from "./useTaskActions";

const quote = (label: string) => `“${label}”`;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The priority a row's `priority:` line holds, on the written scale. */
export function writtenPriority(item: FolderItem): Priority | null {
  const found = priorityOf(item.properties);
  return found === null ? null : (`p${found}` as Priority);
}

export function priorityPlan(item: FolderItem, value: Priority | null): Planned {
  const word = priorityLabel(value);
  return planSet(
    item,
    [["priority", value]],
    value === null ? `${quote(item.label)} has no priority now.` : `${quote(item.label)} is ${word} now.`,
    value === null ? `${quote(item.label)} has no priority.` : `${quote(item.label)} is already ${word}.`,
  );
}

export function ownersPlan(item: FolderItem, owners: readonly string[], owner: OwnerChoice | undefined): Planned {
  const message =
    owners.length === 0
      ? `${quote(item.label)} has no owner now.`
      : `${quote(item.label)} is ${ownerLabel(owner, owners[0]!)}’s${owners.length > 1 ? ` and ${owners.length - 1} more` : ""} now.`;
  return planSet(item, [["owner", wordsValue(owners)]], message, `Nothing changed on ${quote(item.label)}.`);
}

export function tagsPlan(item: FolderItem, tags: readonly string[]): Planned {
  return planSet(item, [["tags", wordsValue(tags)]], `Changed the tags on ${quote(item.label)}.`, `Nothing changed on ${quote(item.label)}.`);
}

export function duePlan(item: FolderItem, day: string | null, now: Date): Planned {
  return planSet(
    item,
    [["due", day]],
    day === null ? `${quote(item.label)} has no due date now.` : `${quote(item.label)} is due ${dueLabel(day, now)}.`,
    day === null ? `${quote(item.label)} has no due date.` : `${quote(item.label)} is already due then.`,
  );
}

/** What a sub-step asks for: an owner picked, a tag typed, or a day typed. */
export type MenuAsk = "owner" | "tag" | "due";

export interface MenuRunContext {
  readonly controls: TaskControls;
  readonly entry: IndexedItem;
  /** The viewer's own owner word; null when the page does not know it. */
  readonly me: string | null;
  readonly owners: OwnerChoice | undefined;
  readonly projects: readonly ProjectRef[];
  readonly now: Date;
  open(item: FolderItem): void;
  makeTask(item: FolderItem): void;
  ask(kind: MenuAsk): void;
  copyLink?: (path: string) => void;
  archive?: (paths: readonly string[]) => void;
}

export function runMenuAction(action: TaskMenuAction, context: MenuRunContext): void {
  const { controls, entry } = context;
  const { item } = entry;
  const perform = (planned: Planned) => void controls.perform(planned);
  const owners = ownersOf(item.properties);
  switch (action.kind) {
    case "status":
      return perform(statusPlan(item, action.value));
    case "priority":
      return perform(priorityPlan(item, action.value));
    case "owner-remove":
      return perform(ownersPlan(item, owners.filter((owner) => !same(owner, action.value)), context.owners));
    case "me":
      return context.me === null ? undefined : perform(ownersPlan(item, [...owners, context.me], context.owners));
    case "tag":
      return perform(tagsPlan(item, toggleWord(tagsOf(item.properties), action.value)));
    case "due":
      if (action.value === "pick") return context.ask("due");
      return perform(duePlan(item, action.value === "clear" ? null : duePreset(action.value, context.now), context.now));
    case "owner-add":
      return context.ask("owner");
    case "tag-new":
      return context.ask("tag");
    case "subtask":
      return controls.openComposer({ kind: "subtask", parent: item.path });
    case "nest": {
      const onto = controls.lookup(action.path)?.item;
      if (onto === undefined) return;
      return perform(planNest(taskRefOf(item), taskRefOf(onto), controls.snapshot()));
    }
    case "unnest":
      return perform(planUnnest(taskRefOf(item), controls.snapshot()));
    case "park":
      return perform(planPark(taskRefOf(item), controls.list));
    case "project": {
      const project = context.projects.find((each) => each.path === action.path);
      if (project === undefined) return;
      return perform(planMoveToProject(taskRefOf(item), project, controls.snapshot()));
    }
    case "open":
      return context.open(item);
    case "copy-link":
      return context.copyLink?.(item.path);
    case "archive":
      return context.archive?.([item.path]);
    case "make-task":
      return context.makeTask(item);
  }
}
