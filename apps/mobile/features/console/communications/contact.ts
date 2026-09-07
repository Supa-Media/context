/**
 * The Contact page's data shaping — a thin, stable boundary over
 * `parseContactView`, so a future change to that package's return shape has
 * one place in the console to update rather than every screen that reads a
 * contact.
 */

import { parseContactView } from "@context/communications";
import type { ContactView } from "./types";

/** Read one contact note's raw text into the console's view of it. */
export function shapeContactView(text: string): ContactView {
  const parsed = parseContactView(text);
  return {
    name: parsed.name,
    organization: parsed.organization,
    identifiers: parsed.identifiers,
    conflicts: parsed.conflicts,
    activity: parsed.activity,
    notes: parsed.notes,
  };
}

/** Activity entries grouped by `YYYY-MM`, newest month first — the page's own grouping, read back. */
export function groupContactActivity(
  view: ContactView,
): { month: string; entries: ContactView["activity"] }[] {
  const groups = new Map<string, ContactView["activity"]>();
  for (const entry of view.activity) {
    const month = entry.date.slice(0, 7);
    const bucket = groups.get(month);
    if (bucket === undefined) groups.set(month, [entry]);
    else bucket.push(entry);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, entries]) => ({ month, entries }));
}
