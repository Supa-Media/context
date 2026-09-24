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

function scalar(raw) {
  const value = raw.trim().replace(/\s+#.*$/, "");
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}
