import type { FileBrowser } from "../browser";
import type { TreeRow } from "../tree";
import { isGroupVisibility } from "../types";
import type { Visibility } from "../types";

/** The inline control: private ↔ team, through the privacy manifest. */
export function cycleVisibility(files: FileBrowser, row: TreeRow): void {
  if (row.readOnly) return;
  const current = row.marker ?? inheritedOf(files, row.path);
  // There is no next position to cycle to from a group rule, and the one this
  // would have picked is `team` — the single press that publishes it.
  // `setVisibility` refuses this too; returning here keeps the control from
  // producing a notice for a press that could never have been meaningful.
  if (isGroupVisibility(current)) return;
  files.setVisibility(
    row.path,
    row.kind === "folder" ? "folder" : "file",
    current === "team" ? "private" : "team",
  );
}

export function inheritedOf(files: FileBrowser, path: string): Visibility {
  for (const listing of Object.values(files.listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.path === path) return entry.inherited;
    }
  }
  return "private";
}
