/**
 * A task row's right-click menu, as data (the file menu's rule, `menu.ts`:
 * one list, drawn by the shared `Menu` as a popover or a sheet, and nothing
 * here performs anything). Pure.
 *
 * The approved order (RightClick artboard, 2026-09-28): Status ›, Priority ›,
 * Estimate › (the filter bar artboard, 2026-09-29), Owners ›, Assign to me, Tags ›, Due date ›; then Add a subtask, Make it a
 * subtask of…, Move to Backlog, Move to another project…; then Open, Copy
 * link, Archive. A plain note's menu is Make it a task, Open, Copy link,
 * Archive.
 *
 * **Absent, never disabled**, the file menu's rule for a permission and here
 * also for what cannot apply: a subtask has no Add a subtask (two levels), a
 * task holding subtasks cannot be made a subtask, a project whose status
 * list has no backlog word has no Move to Backlog, and a page nobody can
 * write to gets no menu at all (the caller never opens one). The words are
 * the owner's: Urgent to Low, never `p0`; a due date as "Today".
 *
 * An id is its action and its argument, `status:to do`, parsed back by
 * `taskMenuAction` — a path or a word may hold a colon, so only the first
 * one splits.
 */

import type { MenuItem } from "../../menuItem";
import type { StatusMenuSection } from "../statuses";
import { groupLabel } from "../../listBlock/words";
import { DUE_PRESET_LABELS, PRIORITIES, PRIORITY_LABELS, type DuePreset, type Priority } from "./taskWords";
import { ESTIMATE_HINTS, ESTIMATES, NO_ESTIMATE, type Estimate } from "../taskProps";

export interface TaskMenuContext {
  /** A task (has a status), or a plain note. */
  readonly kind: "task" | "note";
  readonly status: string;
  readonly priority: Priority | null;
  readonly estimate: Estimate | null;
  readonly owners: readonly string[];
  readonly tags: readonly string[];
  readonly hasDue: boolean;
  /** A subtask: one level down, so it takes no subtasks of its own. */
  readonly isSubtask: boolean;
  /** Holds subtasks, so it cannot go under another task. */
  readonly hasSubtasks: boolean;
  readonly statusSections: readonly StatusMenuSection[];
  /** The folder's word for Backlog; null when its list has none. */
  readonly backlog: string | null;
  /** The tasks it could be made a subtask of. */
  readonly nestTargets: readonly { readonly path: string; readonly label: string }[];
  /** The projects beside this one it could move to; empty on the projects folder itself. */
  readonly projects: readonly { readonly path: string; readonly label: string }[];
  /** The tags this project uses, most used first. */
  readonly tagsInUse: readonly string[];
  /** The viewer's own owner word, when the page knows who is looking. */
  readonly me: string | null;
  /** How an owner word is shown. */
  readonly ownerLabel: (value: string) => string;
  readonly canCopyLink: boolean;
  readonly canArchive: boolean;
  /** "Make it a task", or "Make it a project" where the rows are projects. */
  readonly makeTaskLabel: string;
}

export type TaskMenuAction =
  | { readonly kind: "status"; readonly value: string }
  | { readonly kind: "priority"; readonly value: Priority | null }
  | { readonly kind: "estimate"; readonly value: Estimate | null }
  | { readonly kind: "owner-remove"; readonly value: string }
  | { readonly kind: "owner-add" }
  | { readonly kind: "me" }
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "tag-new" }
  | { readonly kind: "due"; readonly value: DuePreset | "pick" | "clear" }
  | { readonly kind: "subtask" }
  | { readonly kind: "nest"; readonly path: string }
  | { readonly kind: "unnest" }
  | { readonly kind: "park" }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "open" }
  | { readonly kind: "copy-link" }
  | { readonly kind: "archive" }
  | { readonly kind: "make-task" };

const DUE_PRESETS = Object.keys(DUE_PRESET_LABELS) as DuePreset[];
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function statusItems(context: TaskMenuContext): MenuItem<string>[] {
  const items: MenuItem<string>[] = [];
  for (const section of context.statusSections) {
    // "No status" is not offered: a task without one is a note, which is a different thing to ask for.
    const words = section.words.filter((word) => word !== "");
    words.forEach((word, at) =>
      items.push({
        id: `status:${word}`,
        label: groupLabel("status", word),
        checked: same(word, context.status),
        ...(at === 0 && items.length > 0 ? { separatorBefore: true } : {}),
      }),
    );
  }
  return items;
}

export function taskMenuItems(context: TaskMenuContext): MenuItem<string>[] {
  const common: MenuItem<string>[] = [
    { id: "open", label: "Open", separatorBefore: true },
    ...(context.canCopyLink ? [{ id: "copy-link", label: "Copy link" }] : []),
    ...(context.canArchive ? [{ id: "archive", label: "Archive", danger: true }] : []),
  ];
  if (context.kind === "note") {
    return [{ id: "make-task", label: context.makeTaskLabel }, ...common];
  }
  const items: MenuItem<string>[] = [
    { id: "status", label: "Status", items: statusItems(context) },
    {
      id: "priority",
      label: "Priority",
      items: [
        ...PRIORITIES.map((priority) => ({ id: `priority:${priority}`, label: PRIORITY_LABELS[priority], checked: context.priority === priority })),
        { id: "priority:none", label: "No priority", checked: context.priority === null },
      ],
    },
    {
      id: "estimate",
      label: "Estimate",
      items: [
        ...ESTIMATES.map((size) => ({ id: `estimate:${size}`, label: size, detail: ESTIMATE_HINTS[size], checked: context.estimate === size })),
        { id: "estimate:none", label: NO_ESTIMATE, checked: context.estimate === null, separatorBefore: true },
      ],
    },
    {
      id: "owners",
      label: "Owners",
      items: [
        ...context.owners.map((owner) => ({ id: `owner-remove:${owner}`, label: context.ownerLabel(owner), checked: true })),
        { id: "owner-add", label: "Choose someone…", ...(context.owners.length > 0 ? { separatorBefore: true } : {}) },
      ],
    },
  ];
  if (context.me !== null && !context.owners.some((owner) => same(owner, context.me!))) items.push({ id: "me", label: "Assign to me" });
  const tagged = (tag: string) => context.tags.some((each) => same(each, tag));
  const offered = [...context.tags, ...context.tagsInUse.filter((tag) => !tagged(tag))];
  items.push({
    id: "tags",
    label: "Tags",
    items: [
      ...offered.map((tag) => ({ id: `tag:${tag}`, label: tag, checked: tagged(tag) })),
      { id: "tag-new", label: "New tag…", ...(offered.length > 0 ? { separatorBefore: true } : {}) },
    ],
  });
  items.push({
    id: "due",
    label: "Due date",
    items: [
      ...DUE_PRESETS.map((preset) => ({ id: `due:${preset}`, label: DUE_PRESET_LABELS[preset] })),
      { id: "due:pick", label: "Pick a date…" },
      ...(context.hasDue ? [{ id: "due:clear", label: "No due date", separatorBefore: true }] : []),
    ],
  });

  const moves: MenuItem<string>[] = [];
  if (!context.isSubtask) moves.push({ id: "subtask", label: "Add a subtask" });
  if (context.isSubtask) moves.push({ id: "unnest", label: "Make it a task of its own" });
  const targets = context.hasSubtasks ? [] : context.nestTargets;
  if (targets.length > 0) {
    moves.push({ id: "nest", label: "Make it a subtask of…", items: targets.map((target) => ({ id: `nest:${target.path}`, label: target.label })) });
  }
  if (context.backlog !== null && !same(context.status, context.backlog)) moves.push({ id: "park", label: "Move to Backlog" });
  if (context.projects.length > 0) {
    moves.push({
      id: "project",
      label: "Move to another project…",
      items: context.projects.map((project) => ({ id: `project:${project.path}`, label: project.label })),
    });
  }
  if (moves.length > 0) moves[0] = { ...moves[0]!, separatorBefore: true };
  return [...items, ...moves, ...common];
}

/** What a picked id asks for; null for a submenu's own row or an id this menu never made. */
export function taskMenuAction(id: string): TaskMenuAction | null {
  const colon = id.indexOf(":");
  const head = colon === -1 ? id : id.slice(0, colon);
  const rest = colon === -1 ? null : id.slice(colon + 1);
  switch (head) {
    case "status":
      return rest === null ? null : { kind: "status", value: rest };
    case "priority":
      if (rest === "none") return { kind: "priority", value: null };
      return rest !== null && (PRIORITIES as readonly string[]).includes(rest) ? { kind: "priority", value: rest as Priority } : null;
    case "estimate":
      if (rest === "none") return { kind: "estimate", value: null };
      return rest !== null && (ESTIMATES as readonly string[]).includes(rest) ? { kind: "estimate", value: rest as Estimate } : null;
    case "owner-remove":
      return rest === null ? null : { kind: "owner-remove", value: rest };
    case "tag":
      return rest === null ? null : { kind: "tag", value: rest };
    case "due":
      return rest === "pick" || rest === "clear" || (DUE_PRESETS as string[]).includes(rest ?? "")
        ? { kind: "due", value: rest as DuePreset | "pick" | "clear" }
        : null;
    case "nest":
      return rest === null ? null : { kind: "nest", path: rest };
    case "project":
      return rest === null ? null : { kind: "project", path: rest };
    case "owner-add":
    case "me":
    case "tag-new":
    case "subtask":
    case "unnest":
    case "park":
    case "open":
    case "copy-link":
    case "archive":
    case "make-task":
      return rest === null ? ({ kind: head } as TaskMenuAction) : null;
    default:
      return null;
  }
}
