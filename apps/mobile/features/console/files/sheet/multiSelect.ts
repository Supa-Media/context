/**
 * The pure rules of a multi-select cell's picker, shared by the browser's
 * panel (`MultiSelectPanel.web.tsx`) and the phone's sheet
 * (`MultiSelectSheet.tsx`): which options a typed word offers, when a new one
 * is created, and how a pick changes what the cell holds. The cell stores its
 * options joined with ", " (`csv.js` `joinOptions`), so a comma is never part
 * of an option.
 */

import { joinOptions, splitOptions } from "../../../../../mcp/src/sheets/csv.js";

export function chosenOf(draft: string): string[] {
  return splitOptions(draft) as string[];
}

export function draftOf(chosen: readonly string[]): string {
  return joinOptions([...chosen]) as string;
}

/** A typed word as an option: trimmed, commas taken out, and spelled as an existing option when it is one. */
export function optionFor(options: readonly string[], typed: string): string {
  const word = typed.replace(/,/g, " ").trim();
  return options.find((o) => o.toLowerCase() === word.toLowerCase()) ?? word;
}

/** `value` added to what is chosen, once, or taken away when it is there. */
export function toggleOption(chosen: readonly string[], value: string): string[] {
  const key = value.toLowerCase();
  return chosen.some((c) => c.toLowerCase() === key) ? chosen.filter((c) => c.toLowerCase() !== key) : [...chosen, value];
}

export function addOption(chosen: readonly string[], value: string): string[] {
  const key = value.toLowerCase();
  return value === "" || chosen.some((c) => c.toLowerCase() === key) ? [...chosen] : [...chosen, value];
}

export interface PickerList {
  /** The options a press adds, in the column's order. */
  rows: string[];
  /** A new option the typed word would make, or null when it names one already. */
  create: string | null;
  /** The row Enter takes: an index into rows, rows.length for Create, or -1 for none. */
  highlight: number;
}

/**
 * What the browser's list shows for `typed`: the options not yet chosen that
 * contain it, then Create when it names none. Enter's default is the exact
 * match, else Create, so the list always shows what Enter will do.
 */
export function pickerList(options: readonly string[], chosen: readonly string[], typed: string): PickerList {
  const q = typed.replace(/,/g, " ").trim().toLowerCase();
  const taken = new Set(chosen.map((c) => c.toLowerCase()));
  const rows = options.filter((o) => !taken.has(o.toLowerCase()) && o.toLowerCase().includes(q));
  const exact = options.find((o) => o.toLowerCase() === q);
  const create = q === "" || exact !== undefined ? null : typed.replace(/,/g, " ").trim();
  const highlight = exact !== undefined ? rows.indexOf(exact) : create !== null ? rows.length : -1;
  return { rows, create, highlight };
}

/** The phone's list: every option, chosen or not, in the column's order, narrowed by what is typed. */
export function sheetList(options: readonly string[], chosen: readonly string[], typed: string): { rows: string[]; create: string | null } {
  const q = typed.replace(/,/g, " ").trim().toLowerCase();
  const all = [...options, ...chosen.filter((c) => !options.some((o) => o.toLowerCase() === c.toLowerCase()))];
  const rows = all.filter((o) => o.toLowerCase().includes(q));
  const create = q === "" || all.some((o) => o.toLowerCase() === q) ? null : typed.replace(/,/g, " ").trim();
  return { rows, create };
}
