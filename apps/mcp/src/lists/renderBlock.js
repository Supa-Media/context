import { DEFAULT_LIMIT, directionWord } from "./grammar.js";

/**
 * A parsed config back to the body of a ```list block (without the fences),
 * so an editor that changes a filter rewrites the block rather than storing
 * the filter somewhere else. Defaults are left out, and
 * `parseListBody(renderListBlock(c)).config` equals `c`.
 */
export function renderListBlock(config) {
  const lines = [`from: ${config.from}`];
  if (config.where.length) lines.push(`where: ${config.where.map(renderCondition).join(" and ")}`);
  const { key, order } = config.sort;
  const defaultOrder = key === "updated" ? "desc" : "asc";
  if (key !== "updated" || order !== "desc") {
    lines.push(order === defaultOrder ? `sort: ${key}` : `sort: ${key}, ${directionWord(key, order)}`);
  }
  if (config.show.length) lines.push(`show: ${config.show.join(", ")}`);
  if (config.limit !== DEFAULT_LIMIT) lines.push(`limit: ${config.limit}`);
  if (config.subfolders) lines.push("subfolders: yes");
  return lines.join("\n");
}

function renderCondition({ property, op, value }) {
  if (value === undefined) return `${property} ${op}`;
  return `${property} ${op} ${renderValue(value)}`;
}

/** Quote a value whenever reading it back bare would change it. */
function renderValue(value) {
  const bare = /^[^"\s](.*\S)?$/.test(value) && !/\s+and\s+/i.test(value) && !/^(set|not set)$/i.test(value);
  return bare ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}
