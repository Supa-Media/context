/**
 * What a metric formula reads: its columns (for chips) and its datasets (for
 * the inputs line and "used by"). Pure; walks the tree `parse.js` builds.
 */

import { columnKey } from "./parse.js";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  switch (node.type) {
    case "binary":
      walk(node.left, visit);
      walk(node.right, visit);
      return;
    case "agg":
      walk(node.expr, visit);
      for (const cond of node.where ?? []) visit({ source: node.source, dataset: node.dataset, column: cond.column });
      return;
    case "ref":
      visit({ source: node.source, dataset: node.dataset, column: node.column });
      return;
    default:
  }
}

/** Every `{ source, dataset, column }` the formula reads, condition columns included, each once, first-seen order. */
export function formulaRefs(ast) {
  const seen = new Map();
  walk(ast, (ref) => {
    const key = `${ref.source}\u0000${ref.dataset}\u0000${columnKey(ref.column)}`;
    if (!seen.has(key)) seen.set(key, ref);
  });
  return [...seen.values()];
}

/** Every `{ source, dataset }` the formula reads, each once, first-seen order. */
export function formulaInputs(ast) {
  const seen = new Map();
  walk(ast, ({ source, dataset }) => {
    const key = `${source}\u0000${dataset}`;
    if (!seen.has(key)) seen.set(key, { source, dataset });
  });
  return [...seen.values()];
}
