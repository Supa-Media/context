import {
  LIST_FENCE_LANG,
  LIST_KEYS,
  REPEATABLE_KEYS,
  OPERATORS,
  SORT_DIRECTIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_COLUMNS,
  PROPERTY_NAME,
  ROW_KINDS,
  LAYOUTS,
} from "./grammar.js";

/**
 * Every ```list block in a note, parsed: `{ config, line }` or
 * `{ error, line }` per block, in document order.
 *
 * Fences are walked line by line, as forms do, because a note may quote a
 * list block inside another fence and only walking them in order tells which
 * fence a line closes.
 */
export function parseListBlocks(text) {
  if (typeof text !== "string" || !text.includes(LIST_FENCE_LANG)) return [];
  const lines = text.split("\n");
  const blocks = [];
  let fence = null;
  let isList = false;
  let body = [];
  let openedAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === null) {
      const opener = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
      if (opener) {
        fence = opener[2];
        isList = opener[3].toLowerCase() === LIST_FENCE_LANG;
        body = [];
        openedAt = i;
      }
      continue;
    }
    const closer = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(line);
    if (closer && closer[2][0] === fence[0] && closer[2].length >= fence.length) {
      if (isList) blocks.push({ ...parseListBody(body.join("\n")), line: openedAt + 1 });
      fence = null;
      isList = false;
      continue;
    }
    if (isList) body.push(line);
  }
  if (fence !== null && isList) blocks.push({ error: "the list block is never closed", line: openedAt + 1 });
  return blocks;
}

/** One block body (the text between the fences) → `{ config }` or `{ error }`. */
export function parseListBody(text) {
  const raw = new Map();
  const where = [];
  const lines = String(text ?? "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const keyed = /^([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!keyed) return { error: `line ${i + 1} of the block is not "key: value"` };
    const [, key, value] = keyed;
    if (!LIST_KEYS.has(key)) return { error: `unknown key "${key}" (accepted: ${[...LIST_KEYS].join(", ")})` };
    if (REPEATABLE_KEYS.has(key)) {
      const parsed = parseConditions(value.trim());
      if (parsed.error) return { error: `line ${i + 1}: ${parsed.error}` };
      where.push(...parsed.conditions);
      continue;
    }
    if (raw.has(key)) return { error: `"${key}" is set twice` };
    raw.set(key, value.trim());
  }

  if (!raw.has("from")) return { error: '"from" is required: the folder to list' };
  const from = normalizeFolder(raw.get("from"));
  if (from === null) return { error: `"from" must be a folder in this workspace, like 1-projects or blog/posts` };

  const sort = parseSort(raw.get("sort"));
  if (sort.error) return { error: sort.error };
  const show = parseShow(raw.get("show"));
  if (show.error) return { error: show.error };
  const limit = parseLimit(raw.get("limit"));
  if (limit.error) return { error: limit.error };
  const subfolders = raw.get("subfolders") ?? "no";
  if (subfolders !== "yes" && subfolders !== "no") return { error: '"subfolders" takes yes or no' };
  const rows = raw.get("rows") || "notes";
  if (!ROW_KINDS.has(rows)) return { error: '"rows" takes notes or projects' };
  if (rows === "projects" && subfolders === "yes") {
    return { error: '"subfolders" does not apply to projects: a project folder is always looked inside' };
  }
  const group = raw.get("group") || null;
  if (group !== null && (!PROPERTY_NAME.test(group) || group === "title")) {
    return { error: `"group" needs a property to group by, like status or owner` };
  }
  const layout = raw.get("as") || "list";
  if (!LAYOUTS.has(layout)) return { error: '"as" takes list or board' };
  if (layout === "board" && group === null) return { error: 'a board needs "group": the property its columns are, like status' };

  return {
    config: {
      from,
      where,
      sort: sort.sort,
      show: show.show,
      limit: limit.limit,
      subfolders: subfolders === "yes",
      rows,
      group,
      as: layout,
    },
  };
}

/**
 * A workspace-relative folder, or null. No leading slash, no `.` or `..`
 * segments, no hidden (plumbing) segments, no backslashes.
 */
function normalizeFolder(value) {
  const folder = String(value ?? "").trim().replace(/\/+$/, "");
  if (!folder || folder.startsWith("/") || folder.includes("\\")) return null;
  const segments = folder.split("/");
  if (segments.some((s) => !s || s.startsWith("."))) return null;
  return folder;
}

/** `a is b and c is set` → conditions. `and` inside double quotes is a value. */
function parseConditions(value) {
  const parts = splitOnAnd(value);
  if (parts === null) return { error: "a condition has an unclosed quote" };
  const conditions = [];
  for (const part of parts) {
    const condition = parseCondition(part);
    if (!condition) {
      return { error: `"${part}" is not a condition (try: status is active, owner is set, tags contains ios)` };
    }
    conditions.push(condition);
  }
  return { conditions };
}

function splitOnAnd(value) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && /^\s+and\s+/i.test(value.slice(i))) {
      parts.push(current.trim());
      current = "";
      i += /^\s+and\s+/i.exec(value.slice(i))[0].length - 1;
      continue;
    }
    current += ch;
  }
  if (quoted) return null;
  parts.push(current.trim());
  return parts;
}

function parseCondition(text) {
  const named = /^([A-Za-z][\w-]*)\s+(.*)$/.exec(text);
  if (!named || !PROPERTY_NAME.test(named[1])) return null;
  const [, property, rest] = named;
  for (const { op, unary } of OPERATORS) {
    if (unary) {
      if (rest.toLowerCase() === op) return { property, op };
      continue;
    }
    const prefix = new RegExp(`^${op.replace(" ", "\\s+")}\\s+(.+)$`, "i");
    const match = prefix.exec(rest);
    if (!match) continue;
    const value = unquote(match[1].trim());
    if (value === null || value === "") return null;
    return { property, op, value };
  }
  return null;
}

function unquote(text) {
  if (!text.startsWith('"')) return text;
  if (text.length < 2 || !text.endsWith('"')) return null;
  return text.slice(1, -1).replace(/\\(.)/g, "$1");
}

function parseSort(value) {
  if (value === undefined || value === "") return { sort: { key: "updated", order: "desc" } };
  const [keyPart, ...rest] = value.split(",");
  const key = keyPart.trim();
  if (!PROPERTY_NAME.test(key)) return { error: `"sort" needs a property to sort by, like updated or title` };
  const direction = rest.join(",").trim().toLowerCase();
  if (!direction) return { sort: { key, order: key === "updated" ? "desc" : "asc" } };
  const order = SORT_DIRECTIONS.get(direction.replace(/\s+/g, " "));
  if (!order) return { error: `"sort" direction "${direction}" is not one of: ${[...SORT_DIRECTIONS.keys()].join(", ")}` };
  return { sort: { key, order } };
}

function parseShow(value) {
  if (value === undefined || value === "") return { show: [] };
  const show = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (show.length > MAX_COLUMNS) return { error: `"show" takes at most ${MAX_COLUMNS} properties` };
  const bad = show.find((key) => !PROPERTY_NAME.test(key) || key === "title");
  if (bad) return { error: `"show" cannot show "${bad}"` };
  if (new Set(show).size !== show.length) return { error: `"show" names a property twice` };
  return { show };
}

function parseLimit(value) {
  if (value === undefined || value === "") return { limit: DEFAULT_LIMIT };
  if (!/^\d+$/.test(value)) return { error: `"limit" must be a number from 1 to ${MAX_LIMIT}` };
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) return { error: `"limit" must be a number from 1 to ${MAX_LIMIT}` };
  return { limit };
}
