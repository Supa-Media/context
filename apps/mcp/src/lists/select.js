/**
 * Which notes a list shows, in what order, with which columns.
 *
 * Input is the notes the caller can already see —
 * `[{ path, updatedAt, properties }]`, `properties` being the note's parsed
 * frontmatter — so this can only narrow. See rule 2 in `../lists.js`.
 */
export function selectListRows(config, notes, { selfPath } = {}) {
  const folder = config.from ? `${config.from}/` : "";
  const matched = (notes || []).filter((note) => {
    const path = String(note.path || "");
    if (!path.endsWith(".md") || path === selfPath) return false;
    if (!path.startsWith(folder)) return false;
    const rest = path.slice(folder.length);
    if (rest.split("/").some((segment) => segment.startsWith("."))) return false;
    if (!config.subfolders && rest.includes("/")) return false;
    return config.where.every((condition) => holds(condition, note.properties || {}));
  });

  const sorted = matched
    .map((note) => ({ note, title: titleOf(note) }))
    .sort((a, b) => compareRows(a, b, config.sort));
  const rows = sorted.slice(0, config.limit).map(({ note, title }) => ({
    path: note.path,
    title,
    values: config.show.map((key) => ({ key, value: valueOf(note, key) })),
  }));
  return { rows, total: matched.length, truncated: matched.length > rows.length };
}

function titleOf(note) {
  const title = note.properties?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const base = String(note.path).split("/").pop();
  return base.replace(/\.md$/, "");
}

function valueOf(note, key) {
  if (key === "updated") return note.updatedAt ?? null;
  const value = note.properties?.[key];
  return value === undefined ? null : value;
}

/** A property as lower-cased strings: a list is its items, a scalar is one. */
function strings(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item) => item !== null && item !== undefined && typeof item !== "object")
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item !== "");
}

function holds({ property, op, value }, properties) {
  const have = strings(properties[property]);
  const want = value === undefined ? "" : value.trim().toLowerCase();
  switch (op) {
    case "is":
      return have.includes(want);
    case "is not":
      return !have.includes(want);
    case "contains":
      return have.some((item) => item.includes(want));
    case "is set":
      return have.length > 0;
    case "is not set":
      return have.length === 0;
    default:
      return false;
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function compareRows(a, b, { key, order }) {
  const sign = order === "desc" ? -1 : 1;
  const left = key === "title" ? a.title : sortValue(a.note, key);
  const right = key === "title" ? b.title : sortValue(b.note, key);
  // Missing values go last whichever way the list runs.
  if (left === null && right !== null) return 1;
  if (right === null && left !== null) return -1;
  if (left !== null && right !== null) {
    const primary = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
    if (primary !== 0) return sign * primary;
  }
  return collator.compare(a.title, b.title) || (a.note.path < b.note.path ? -1 : 1);
}

function sortValue(note, key) {
  const value = valueOf(note, key);
  if (value === null || value === "") return null;
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  if (typeof value === "number") return value;
  return String(value);
}
