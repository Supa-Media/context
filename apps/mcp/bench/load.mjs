// Loads the AI benchmark folder: people, workspaces, held-back rules and test questions.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROLES = new Set(["owner", "editor", "member"]);
// Privacy rule files at a workspace's root. They are parsed, not returned as files.
const PRIVACY_FILES = new Set(["privacy.md", "privacy-rules.md"]);

// Normalize line endings so CRLF files parse the same as LF files.
const normalize = (raw) => String(raw ?? "").replace(/\r\n?/g, "\n");

// Strip one pair of matching quotes around a value.
function unquote(s) {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
}

// Read the people table: "| Maya | maya (personal) | owner |" rows.
export function parsePeople(raw) {
  const people = [];
  normalize(raw).split("\n").forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith("|")) return;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.length < 3) return;
    // Skip the header row and the |---| separator row.
    if (cells[0] === "Person" || /^:?-+:?$/.test(cells[0])) return;
    const [person, slot, role] = cells;
    if (!ROLES.has(role)) {
      throw new Error(`people.md line ${i + 1}: unknown role "${role}" (use owner, editor or member)`);
    }
    const m = slot.match(/^(.*?)\s*\(personal\)$/);
    people.push({ person, workspace: m ? m[1] : slot, role, personal: Boolean(m) });
  });
  return people;
}

// Find "- <path>.md: ..." lines under a heading or line that says "Held back".
export function heldBack(raw) {
  const out = [];
  let inSection = false;
  for (const line of normalize(raw).split("\n")) {
    const t = line.trim();
    // A heading starts or ends the section depending on its own text.
    if (/^#{1,6}\s/.test(t)) {
      inSection = /held back/i.test(t);
      continue;
    }
    const bullet = t.match(/^[-*]\s+([^\s:]+\.md):(\s|$)/);
    if (bullet && inSection) {
      out.push(bullet[1]);
      continue;
    }
    if (!t) continue;
    // A line that says "Held back" opens a section; any other prose ends it.
    inSection = /held back/i.test(t);
  }
  return out;
}

// Parse the YAML front matter: "key: value" and one level of "  sub: value".
function parseFront(lines) {
  const front = {};
  let key = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const sub = line.match(/^ {2}([\w-]+):(?:\s+(.*))?$/);
    if (sub && key) {
      if (front[key] === "") front[key] = {};
      if (typeof front[key] !== "object") throw new Error(`front matter: "${key}" has a value and sub-keys`);
      front[key][sub[1]] = unquote(sub[2] ?? "");
      continue;
    }
    const top = line.match(/^([\w-]+):(?:\s+(.*))?$/);
    if (!top) throw new Error(`front matter: cannot read line "${line}"`);
    key = top[1];
    front[key] = unquote(top[2] ?? "");
  }
  // runs is the only non-string value; it defaults to 3.
  const runs = front.runs === undefined ? 3 : Number.parseInt(front.runs, 10);
  if (!Number.isInteger(runs)) throw new Error(`front matter: runs must be a whole number, got "${front.runs}"`);
  return { ...front, runs };
}

// Build one question object from the lines under its "## n. text" heading.
function readQuestion(sec) {
  const q = {
    n: sec.n,
    text: sec.text,
    as: null,
    kind: null,
    gate: false,
    personStarts: null,
    ifAsked: [],
    must: [],
    mustNot: [],
    judge: [],
    body: sec.lines.join("\n").trim(),
  };
  for (const raw of sec.lines) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^- as:\s*(.*)$/))) q.as = m[1].trim();
    else if ((m = line.match(/^- kind:\s*(.*)$/))) q.kind = m[1].trim();
    else if (/^- gate:/.test(line)) q.gate = true;
    else if ((m = line.match(/^- person starts:\s*(.*)$/))) q.personStarts = unquote(m[1]);
    else if ((m = line.match(/^- if asked (.+?):\s*(.*)$/))) q.ifAsked.push({ when: m[1], say: unquote(m[2]) });
    else if ((m = line.match(/^- must not:\s*(.*)$/))) q.mustNot.push(m[1].trim());
    else if ((m = line.match(/^- must:\s*(.*)$/))) q.must.push(m[1].trim());
    else if ((m = line.match(/^- judge:\s*(.*)$/))) q.judge.push(m[1].trim());
  }
  return q;
}

// Parse a test file: front matter plus one question per "## n. text" heading.
export function parseTest(raw) {
  const lines = normalize(raw).split("\n");
  let front = { runs: 3 };
  let bodyStart = 0;
  // Front matter is only read when the file opens with a "---" fence.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      front = parseFront(lines.slice(1, end));
      bodyStart = end + 1;
    }
  }
  // Collect the lines under each numbered heading; ignore anything before the first.
  const sections = [];
  let cur = null;
  for (const line of lines.slice(bodyStart)) {
    const h = line.match(/^## (\d+)\. (.+?)\s*$/);
    if (h) {
      cur = { n: Number(h[1]), text: h[2], lines: [] };
      sections.push(cur);
    } else if (/^#{1,2}\s/.test(line)) {
      cur = null; // any other top-level heading ends the question
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return { front, questions: sections.map(readQuestion) };
}

// Recursively list .md files under base, as forward-slash paths relative to base.
async function listMarkdown(base, rel = "") {
  const out = [];
  const entries = await readdir(join(base, rel), { withFileTypes: true });
  for (const entry of entries) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listMarkdown(base, path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

// Read the whole benchmark folder into one object.
export async function readBenchFolder(dir) {
  const readme = await readFile(join(dir, "README.md"), "utf8");
  const people = parsePeople(await readFile(join(dir, "workspaces", "people.md"), "utf8"));

  const wsRoot = join(dir, "workspaces");
  const workspaces = {};
  const dirents = await readdir(wsRoot, { withFileTypes: true });
  for (const entry of dirents.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = join(wsRoot, entry.name);
    const files = {};
    const held = [];
    for (const rel of await listMarkdown(base)) {
      const text = await readFile(join(base, rel), "utf8");
      // Only a root-level privacy file is a rule file; others are ordinary notes.
      if (PRIVACY_FILES.has(rel)) held.push(...heldBack(text));
      else files[rel] = text;
    }
    workspaces[entry.name] = { files, heldBack: held };
  }

  for (const p of people) {
    if (!workspaces[p.workspace]) {
      throw new Error(`people.md: ${p.person} is listed in workspace "${p.workspace}", but workspaces/${p.workspace}/ does not exist`);
    }
  }

  const testDir = join(dir, "tests");
  const tests = {};
  const names = (await readdir(testDir)).filter((f) => f.endsWith(".md")).sort();
  for (const name of names) {
    const raw = await readFile(join(testDir, name), "utf8");
    tests[name.slice(0, -3)] = { raw, ...parseTest(raw) };
  }

  return { dir, readme, people, workspaces, tests };
}
