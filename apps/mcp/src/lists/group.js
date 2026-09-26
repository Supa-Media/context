import { GROUP_ORDER } from "./grammar.js";

/**
 * Grouping rows by one property: which group a row is in, and the order the
 * groups are drawn in. Pure, like the rest of `lists/`.
 */

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const lifecycle = new Map(GROUP_ORDER.map((word, index) => [word, index]));

/**
 * The value a row is grouped under: the property as written, trimmed; a list
 * is grouped under its first item. `""` is "not set" and always sorts last.
 * `null` when the list is not grouped at all.
 */
export function groupOf(properties, key) {
  if (!key) return null;
  const raw = properties?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || typeof value === "object") return "";
  return String(value).trim();
}

/** Lifecycle words first in their fixed order, then the rest a to z, then unset. */
export function compareGroups(a, b) {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const left = lifecycle.get(a.toLowerCase());
  const right = lifecycle.get(b.toLowerCase());
  if (left !== undefined && right !== undefined) return left - right || collator.compare(a, b);
  if (left !== undefined) return -1;
  if (right !== undefined) return 1;
  return collator.compare(a, b);
}

/**
 * Rows already in their sort order, re-ordered group by group and stable
 * within each group. Values that differ only by case share a group, named as
 * the first row spelled it.
 */
export function orderByGroup(items) {
  const names = new Map();
  for (const item of items) {
    const folded = item.group.toLowerCase();
    if (!names.has(folded)) names.set(folded, item.group);
    item.group = names.get(folded);
  }
  const order = [...names.values()].sort(compareGroups);
  const rank = new Map(order.map((name, index) => [name, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank.get(a.item.group) - rank.get(b.item.group) || a.index - b.index)
    .map(({ item }) => item);
}
