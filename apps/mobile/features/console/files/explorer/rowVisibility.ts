import type { FileBrowser } from "../browser";
import type { Visibility } from "../types";

/** The visibility a row would have with no setting of its own: its folder's. */
export function inheritedOf(files: FileBrowser, path: string): Visibility {
  for (const listing of Object.values(files.listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.path === path) return entry.inherited;
    }
  }
  return "private";
}
