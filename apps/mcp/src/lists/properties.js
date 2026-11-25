/**
 * A note's frontmatter as the properties a list filters, sorts and shows.
 *
 * Deliberately a small reader, not YAML: top-level `key: value` lines, a
 * value in matching quotes, an inline list `[a, b]`, and a block list of
 * `- item` lines under an empty key. A nested map is skipped rather than
 * flattened, because a condition on `owner` must not match `team: { owner }`.
 * The result has no prototype, so a key named `__proto__` is just a key.
 */
export function noteProperties(text) {
  const properties = Object.create(null);
  if (typeof text !== "string") return properties;
  const source = text.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(source)) return properties;
  const lines = source.split(/\r?\n/);
  let pending = null; // a key whose value is a block list on the lines below

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^---\s*$/.test(line)) return properties;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line);
    if (item && pending !== null) {
      const value = scalar(item[1]);
      if (value !== "") properties[pending].push(value);
      continue;
    }
    if (/^\s/.test(line)) continue; // inside a nested map
    pending = null;
    const keyed = /^([^:#\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!keyed) continue;
    const key = keyed[1];
    const raw = (keyed[2] ?? "").trim();
    if (raw === "") {
      properties[key] = [];
      pending = key;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      properties[key] = raw
        .slice(1, -1)
        .split(",")
        .map((part) => scalar(part))
        .filter((part) => part !== "");
    } else {
      properties[key] = scalar(raw);
    }
  }
  // No closing fence: not frontmatter at all.
  return Object.create(null);
}

/** YAML's double-quoted escapes this reader understands; any other `\x` keeps its letter. */
const ESCAPES = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/" };

/**
 * One value. A quoted one reads up to its closing quote, as YAML does: `\"`
 * and `\\` inside double quotes, `''` inside single quotes, and a `#` inside
 * either is text. A plain value drops a trailing ` # comment`.
 */
function scalar(raw) {
  const text = raw.trim();
  const quoted = text[0] === '"' ? doubleQuoted(text) : text[0] === "'" ? singleQuoted(text) : null;
  if (quoted !== null) return quoted;
  const value = text.replace(/\s+#.*$/, "");
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

/** Whatever follows a closing quote is nothing or a comment; anything else means the value was not one quoted string. */
const restIsEmpty = (rest) => /^\s*(#.*)?$/.test(rest);

function doubleQuoted(text) {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return restIsEmpty(text.slice(i + 1)) ? out : null;
    if (c === "\\" && i + 1 < text.length) {
      const next = text[++i];
      out += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : next;
    } else out += c;
  }
  return null;
}

function singleQuoted(text) {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") out += text[i];
    else if (text[i + 1] === "'") out += "'", i++;
    else return restIsEmpty(text.slice(i + 1)) ? out : null;
  }
  return null;
}

/**
 * A note's first `# ` heading, after any frontmatter, or null. Only the first
 * 200 lines are read: a heading further down is not the note's name.
 * Used as a project's name when its frontmatter has no `title`.
 */
export function noteHeading(text) {
  if (typeof text !== "string") return null;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/, 200);
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    i = lines.findIndex((line, at) => at > 0 && /^---\s*$/.test(line));
    if (i === -1) return null;
    i += 1;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading && heading[1].trim()) return heading[1].trim();
  }
  return null;
}
