/** What the List and Board views of a folder page share about one item. */

import type { PropertyValue } from "../listBlock/model";
import type { FolderItem } from "./model";

/** A save older than this is drawn a step quieter (spec: staleness is only a date). */
const STALE_AFTER = 14 * 24 * 60 * 60 * 1000;

export interface ItemActions {
  /** Open a folder's page, or a note. */
  onOpen(item: FolderItem): void;
  /** The values a menu offers for `key`. */
  choices(key: string): readonly string[];
  /** Null for somebody who may not write. */
  onChoose: ((item: FolderItem, key: string, value: string | null) => void) | null;
}

/** A single-valued property as trimmed text; `""` when unset. */
export function textOf(properties: Readonly<Record<string, PropertyValue>>, key: string): string {
  const raw = properties[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value.trim() : "";
}

export function isStale(at: number | null, now: number): boolean {
  return at !== null && now - at > STALE_AFTER;
}
