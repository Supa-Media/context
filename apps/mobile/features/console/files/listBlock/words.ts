/** The words a drawn list uses: its caption, and each value beside a title. */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { displayName } from "../paths";
import type { ListConfig, ListRow, PropertyValue } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * "projects · status is active", or "writing · newest first" when the list
 * has no conditions — what it lists, in the words the block used.
 */
export function captionFor(config: ListConfig, label: (folder: string) => string): string {
  const folder = label(leafOf(config.from));
  const conditions = config.where.map((c) => (c.value === undefined ? `${c.property} ${c.op}` : `${c.property} ${c.op} ${c.value}`));
  if (conditions.length > 0) return `${folder} · ${conditions.join(", ")}`;
  const { key, order } = config.sort;
  if (key === "updated") return `${folder} · ${order === "desc" ? "newest first" : "oldest first"}`;
  return `${folder} · by ${key}`;
}

/** The last segment of a path. Never drawn without `folderLabel` or `displayName`. */
function leafOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * A row's title as drawn: a file name the way the tree draws it (no `.md`, no
 * sort number), a title from frontmatter as written — both contained, since
 * neither was chosen by this app.
 */
export function rowTitle(row: ListRow): string {
  const leaf = leafOf(row.path);
  return row.title === leaf.replace(/\.md$/i, "") ? displayName(leaf) : isolateForDisplay(row.title);
}

/** One value beside a title. `updated` is a time; a list is its items. */
export function formatValue(key: string, value: PropertyValue | number | null, now: number): string {
  if (value === null) return "";
  if (key === "updated" && typeof value === "number") return shortWhen(value, now);
  if (Array.isArray(value)) return isolateForDisplay(value.join(", "));
  return isolateForDisplay(String(value));
}

/** "just now", "12m ago", "3h ago", "yesterday", "Sep 22", "Sep 22, 2025". */
export function shortWhen(at: number, now: number): string {
  const delta = now - at;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  const then = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return `${Math.floor(delta / HOUR)}h ago`;
  if (at >= startOfToday - 24 * HOUR) return "yesterday";
  const month = then.toLocaleString("en-US", { month: "short" });
  const sameYear = then.getFullYear() === today.getFullYear();
  return sameYear ? `${month} ${then.getDate()}` : `${month} ${then.getDate()}, ${then.getFullYear()}`;
}
