// Loads the AI benchmark folder: people, workspaces, held-back rules and test questions.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertIsoDate } from "./clock.mjs";

import { expandFluff, parseFluff, resolveRel } from "./fluff.mjs";
import { normalize, parseFront, unquote } from "./frontMatter.mjs";

const ROLES = new Set(["owner", "editor", "member"]);
// Privacy rule files at a workspace's root. They are parsed, not returned as files.
const PRIVACY_FILES = new Set(["privacy.md", "privacy-rules.md"]);
// Template folders live here. It is not a workspace.
const BANK = "_bank";
// A folder's fluff file says how many filler notes to write there.
const FLUFF_FILE = "fluff.md";

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

// runs is the only non-string value in a test's front matter; it defaults to 3.
function withRuns(front) {
  const runs = front.runs === undefined ? 3 : Number.parseInt(front.runs, 10);
  if (!Number.isInteger(runs)) throw new Error(`front matter: runs must be a whole number, got "${front.runs}"`);
  // today pins the benchmark's day; absent, the run uses the real one.
  if (front.today !== undefined) assertIsoDate(front.today);
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
    // The question number of the same fact asked by someone allowed to see it.
    mirror: null,
    // Allowed but never required: told to the judge, never graded.
    may: [],
    // A search question (`tests/search.md`): the notes that should come back,
    // as @workspace/path, and the one workspace the search is addressed to.
    expect: [],
    in: null,
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
    else if ((m = line.match(/^- may:\s*(.*)$/))) q.may.push(m[1].trim());
    else if ((m = line.match(/^- expect:\s*(.*)$/))) q.expect.push(...m[1].split(",").map((part) => part.trim()).filter(Boolean));
    else if ((m = line.match(/^- in:\s*(.*)$/))) q.in = m[1].trim() || null;
    else if ((m = line.match(/^- mirror:\s*(.*)$/))) {
      if (!/^\d+$/.test(m[1].trim())) throw new Error(`question ${sec.n}: mirror must be a question number, got "${m[1].trim()}"`);
      q.mirror = Number(m[1].trim());
    }
  }
  return q;
}

// A gate question is one a failure of fails the whole setup: every privacy
// question, and a back-and-forth question marked `gate:`.
export const isGateQuestion = (q) => q.kind === "privacy" || (q.kind === "back-and-forth" && q.gate === true);

// Parse a test file: front matter plus one question per "## n. text" heading.
export function parseTest(raw) {
  const lines = normalize(raw).split("\n");
  let front = { runs: 3 };
  let bodyStart = 0;
  // Front matter is only read when the file opens with a "---" fence.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      front = withRuns(parseFront(lines.slice(1, end), 2));
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
  // Lines the judge grades on every answer, from the front matter's
  // `every_answer:` map (the keys are labels; the order is the file's). They
  // are judge lines, so they shape the voice bar and never a pass or a gate.
  const everyAnswer = typeof front.every_answer === "object" && front.every_answer !== null ? Object.values(front.every_answer).filter(Boolean) : [];
  return { front, everyAnswer, questions: sections.map(readQuestion) };
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

// The folder a file sits in, relative to its workspace: "" at the root.
const folderOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// Read the template folders under workspaces/_bank/: folder name -> { path -> text }.
async function readBank(wsRoot) {
  const bank = {};
  let entries;
  try {
    entries = await readdir(join(wsRoot, BANK), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return bank;
    throw error;
  }
  for (const entry of entries.filter((d) => d.isDirectory())) {
    const base = join(wsRoot, BANK, entry.name);
    const files = {};
    for (const rel of await listMarkdown(base)) files[rel] = await readFile(join(base, rel), "utf8");
    bank[entry.name] = files;
  }
  return bank;
}

// Read the whole benchmark folder into one object.
export async function readBenchFolder(dir) {
  const readme = await readFile(join(dir, "README.md"), "utf8");
  const people = parsePeople(await readFile(join(dir, "workspaces", "people.md"), "utf8"));

  const wsRoot = join(dir, "workspaces");
  const bank = await readBank(wsRoot);
  const workspaces = {};
  const dirents = await readdir(wsRoot, { withFileTypes: true });
  const folders = dirents.filter((d) => d.isDirectory() && d.name !== BANK).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of folders) {
    const base = join(wsRoot, entry.name);
    const files = {};
    const held = [];
    const fluff = [];
    for (const rel of await listMarkdown(base)) {
      const text = await readFile(join(base, rel), "utf8");
      if (rel === FLUFF_FILE || rel.endsWith(`/${FLUFF_FILE}`)) {
        // A fluff file describes notes; it is never one.
        const label = `workspaces/${entry.name}/${rel}`;
        const parsed = parseFluff(text, label);
        if (!Object.hasOwn(bank, parsed.from)) {
          throw new Error(`${label}: from names template folder "${parsed.from}", but workspaces/${BANK}/${parsed.from}/ does not exist`);
        }
        fluff.push({ dir: folderOf(rel), fluff: parsed });
      } else if (PRIVACY_FILES.has(rel)) {
        // Only a root-level privacy file is a rule file; others are ordinary notes.
        held.push(...heldBack(text));
      } else {
        files[rel] = text;
      }
    }
    workspaces[entry.name] = { files, heldBack: held, fluff };
  }

  for (const p of people) {
    if (p.workspace === BANK) {
      throw new Error(`people.md: ${p.person} is listed in workspace "${BANK}", which holds fluff templates, not a workspace`);
    }
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

  return { dir, readme, people, workspaces, tests, bank };
}

/**
 * The bench with every fluff file written out: each workspace's files gain its generated
 * notes, listed in `generated`. The bench passed in is not changed.
 */
export function expandWorkspaces(bench) {
  const workspaces = {};
  for (const [name, ws] of Object.entries(bench.workspaces)) {
    const files = { ...ws.files };
    const held = [...ws.heldBack];
    const generated = [];
    for (const { dir, fluff } of ws.fluff) {
      const made = expandFluff({ dir, fluff, templates: bench.bank[fluff.from], files });
      for (const [path, text] of Object.entries(made)) {
        files[path] = text;
        generated.push(path);
      }
      // A copy of a held-back note is the same secret under a new name, so it stays held back.
      for (const d of fluff.distractors) {
        if (ws.heldBack.includes(resolveRel(dir, d.from))) held.push(resolveRel(dir, d.as));
      }
    }
    workspaces[name] = { files, heldBack: held, fluff: ws.fluff, generated };
  }
  return { ...bench, workspaces };
}
