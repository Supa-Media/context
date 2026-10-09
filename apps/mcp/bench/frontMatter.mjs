// The one-level YAML subset the bench reads, shared by test files and fluff files.

// Normalize line endings so CRLF files parse the same as LF files.
export const normalize = (raw) => String(raw ?? "").replace(/\r\n?/g, "\n");

// Strip one pair of matching quotes around a value.
export function unquote(s) {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
}

// Parse "key: value" lines and one level of "  sub: value". `firstLine` is the
// file line of lines[0], so an error can name the line that is wrong.
export function parseFront(lines, firstLine = 1) {
  const front = {};
  let key = null;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const sub = line.match(/^ {2}([\w-]+):(?:\s+(.*))?$/);
    if (sub && key) {
      if (front[key] === "") front[key] = {};
      if (typeof front[key] !== "object") throw new Error(`front matter line ${firstLine + i}: "${key}" has a value and sub-keys`);
      front[key][sub[1]] = unquote(sub[2] ?? "");
      return;
    }
    const top = line.match(/^([\w-]+):(?:\s+(.*))?$/);
    if (!top) throw new Error(`front matter line ${firstLine + i}: cannot read "${line}"`);
    key = top[1];
    front[key] = unquote(top[2] ?? "");
  });
  return front;
}
