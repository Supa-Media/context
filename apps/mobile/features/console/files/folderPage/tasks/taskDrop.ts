/**
 * What dropping a dragged task does, by where it lands. Pure.
 *
 * On a task row the row is three bands: its **middle** half makes the
 * dragged task a subtask of it; its top and bottom quarters are *between*
 * rows, which gives the task that row's status (a move within the list is a
 * change of status — the order inside a group is priority, then newest, so
 * there is no "position" to write). A subtask dropped between the project's
 * own tasks becomes a task of its own again. A section, and a folded band,
 * takes a drop too: its status, or Backlog.
 *
 * Every verdict names what it will do in the owner's words, so the hint shown
 * while hovering and the toast after the drop say the same thing — and a
 * drop the two-level rule forbids says why *before* it is let go, not after.
 */

import { groupLabel } from "../../listBlock/words";
import { parentPath } from "../../paths";
import type { FolderItem } from "../model";
import { taskRefOf } from "./taskEdits";
import { planNest, planUnnest, type Planned, type TaskSnapshot } from "./taskWrites";

export type DropZone = "above" | "middle" | "below";

/** Which band of a row `offset` pixels down a row `height` tall is in. */
export function dropZone(offset: number, height: number): DropZone {
  if (!(height > 0)) return "middle";
  const at = offset / height;
  if (at < 0.25) return "above";
  if (at > 0.75) return "below";
  return "middle";
}

export type DropVerdict =
  /** A plan to run on drop, and the hint that says what it is. */
  | { readonly kind: "plan"; readonly hint: string; readonly planned: Extract<Planned, { ok: true }> }
  /** A status to set on drop. */
  | { readonly kind: "status"; readonly hint: string; readonly status: string }
  /** Refused, said while hovering. */
  | { readonly kind: "refused"; readonly hint: string }
  /** Nothing would change: no hint, and the drop is not taken. */
  | { readonly kind: "none" };

const quote = (label: string) => `“${label}”`;

/** "Move to To do" — the words for changing a task's status by dropping it. */
export function statusHint(status: string): string {
  return `Move to ${groupLabel("status", status)}`;
}

function planVerdict(planned: Planned, hint: string): DropVerdict {
  return planned.ok ? { kind: "plan", hint, planned } : { kind: "refused", hint: planned.problem };
}

/**
 * `dragged` let go on `target`'s row, in `zone`. `snapshot.folder` is the
 * page's folder: a row directly in it is a task, one a level down a subtask.
 */
export function rowDrop(dragged: FolderItem, target: FolderItem, zone: DropZone, snapshot: TaskSnapshot): DropVerdict {
  if (dragged.path === target.path) return { kind: "none" };
  const targetIsTask = parentPath(target.path) === snapshot.folder;
  if (zone === "middle") {
    return planVerdict(planNest(taskRefOf(dragged), taskRefOf(target), snapshot), `Make it a subtask of ${quote(target.label)}`);
  }
  if (!targetIsTask) return { kind: "none" };
  const draggedIsTask = parentPath(dragged.path) === snapshot.folder;
  if (!draggedIsTask) return planVerdict(planUnnest(taskRefOf(dragged), snapshot), "Make it a task of its own");
  return statusDrop(dragged, target.status);
}

/** `dragged` given `status` — a drop on a section, or between rows. */
export function statusDrop(dragged: FolderItem, status: string): DropVerdict {
  if (status === "" || dragged.status.toLowerCase() === status.toLowerCase()) return { kind: "none" };
  return { kind: "status", hint: statusHint(status), status };
}
