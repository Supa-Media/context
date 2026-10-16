/**
 * Reads and edits an AI test list: a Markdown file under `apps/mcp/bench/ai/tests/`.
 *
 * The shape the bench reads (`apps/mcp/bench/load.mjs`, `parseTest`):
 *  - optional YAML front matter between two `---` fences;
 *  - one case per `## <n>. <question>` heading, running to the next `#` or `##`
 *    heading (`###` does not end a case, as in the bench);
 *  - under each heading, free description lines and `- <key>: <value>` bullets.
 *
 * Every edit returns a new list, re-parsed from the edited lines. Lines that an
 * edit does not touch are kept byte for byte, so `serializeTestList` of an
 * untouched list reproduces its file exactly.
 */

export type RuleTone = "checked" | "must" | "mustNot" | "may" | "judge";

/** A `- key: value` bullet. `index` is the line's position in `TestList.lines`. */
export interface CaseLine {
  index: number;
  key: string;
  value: string;
}

export interface TestCase {
  /** The n in `## n.`. */
  number: number;
  /** The question text after `n. `. */
  title: string;
  /** Line index of the heading. */
  headingIndex: number;
  /** Exclusive end line index of this case's section. */
  endIndex: number;
  /** Non-bullet, non-blank lines under the heading, trimmed and joined with "\n". */
  description: string;
  /** The `- as:` line: the person asking. */
  person: CaseLine | null;
  /** The `- kind:` line. */
  kind: CaseLine | null;
  /** `person starts` and `if asked ...` lines; the key keeps its full text. */
  replies: CaseLine[];
  /** `must`, `must not`, `may`, `judge` and every other `must <verb>` / `must not <verb>` line. */
  rules: CaseLine[];
  /** Any other bullet: expect, in, forbid, mirror, gate and so on. */
  other: CaseLine[];
}

export interface TestList {
  lines: string[];
  /** Line index after the closing front-matter fence; 0 when there is none. */
  frontEnd: number;
  cases: TestCase[];
}

const CASE_HEADING = /^## (\d+)\. (.+?)\s*$/;
/** Any other top-level heading ends a case, as the bench reads it. */
const SECTION_HEADING = /^#{1,2}\s/;
const BULLET = /^\s*- /;

interface Bullet {
  key: string;
  value: string;
}

/**
 * Split a bullet at the first ": " (or a trailing ":"), so `- gate:` is key
 * "gate" with an empty value and a value may itself contain colons.
 */
function readBullet(line: string): Bullet | null {
  const match = line.match(/^\s*- (.*)$/);
  if (!match) return null;
  const rest = match[1];
  const colon = rest.search(/:(?:\s|$)/);
  if (colon < 0) return { key: rest.trim(), value: "" };
  return { key: rest.slice(0, colon).trim(), value: rest.slice(colon + 1).trim() };
}

function formatBullet(indent: string, key: string, value: string): string {
  return `${indent}- ${key}:${value ? ` ${value}` : ""}`;
}

function assertSingleLine(text: string, what: string): void {
  if (/[\r\n]/.test(text)) throw new Error(`${what} must be a single line`);
}

const RULE_KEYS = new Set(["must", "must not", "may", "judge"]);

function isRuleKey(key: string): boolean {
  return RULE_KEYS.has(key) || key.startsWith("must ");
}

export function ruleTone(key: string): RuleTone {
  const k = key.trim();
  if (k === "must") return "must";
  if (k === "must not") return "mustNot";
  if (k === "may") return "may";
  if (k === "judge") return "judge";
  // "must call", "must not write", ...: checked from the run's record.
  if (k.startsWith("must ")) return "checked";
  // Not a rule key at all. Callers pass rule keys; the softest tone is the fallback.
  return "judge";
}

export function ruleLabel(key: string): string {
  return key.trim();
}

export function parseTestList(raw: string): TestList {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  let frontEnd = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) frontEnd = close + 1;
  }

  // Each case runs from its heading to the next heading of either kind.
  const cases: TestCase[] = [];
  for (let h = frontEnd; h < lines.length; h++) {
    const heading = lines[h].match(CASE_HEADING);
    if (!heading) continue;

    let endIndex = lines.length;
    for (let j = h + 1; j < lines.length; j++) {
      if (CASE_HEADING.test(lines[j]) || SECTION_HEADING.test(lines[j])) {
        endIndex = j;
        break;
      }
    }

    const testCase: TestCase = {
      number: Number(heading[1]),
      title: heading[2],
      headingIndex: h,
      endIndex,
      description: "",
      person: null,
      kind: null,
      replies: [],
      rules: [],
      other: [],
    };

    const description: string[] = [];
    for (let i = h + 1; i < endIndex; i++) {
      const line = lines[i];
      if (BULLET.test(line)) {
        const bullet = readBullet(line);
        if (!bullet) continue;
        const entry: CaseLine = { index: i, key: bullet.key, value: bullet.value };
        if (bullet.key === "as" && testCase.person === null) testCase.person = entry;
        else if (bullet.key === "kind" && testCase.kind === null) testCase.kind = entry;
        else if (bullet.key === "person starts" || bullet.key.startsWith("if asked ")) testCase.replies.push(entry);
        else if (isRuleKey(bullet.key)) testCase.rules.push(entry);
        else testCase.other.push(entry);
      } else if (line.trim()) {
        description.push(line.trim());
      }
    }
    testCase.description = description.join("\n");
    cases.push(testCase);
  }

  return { lines, frontEnd, cases };
}

export function serializeTestList(list: TestList): string {
  return list.lines.join("\n");
}

function reparse(lines: string[]): TestList {
  return parseTestList(lines.join("\n"));
}

function findCase(list: TestList, caseNumber: number): TestCase {
  const found = list.cases.find((c) => c.number === caseNumber);
  if (!found) throw new Error(`no case ${caseNumber} in this test list`);
  return found;
}

export function setLineValue(list: TestList, index: number, value: string): TestList {
  const line = list.lines[index];
  const bullet = line === undefined ? null : readBullet(line);
  if (!bullet) throw new Error(`line ${index} is not a "- key: value" line`);
  assertSingleLine(value, "value");
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const lines = [...list.lines];
  lines[index] = formatBullet(indent, bullet.key, value.trim());
  return reparse(lines);
}

export function setCaseTitle(list: TestList, caseNumber: number, title: string): TestList {
  const testCase = findCase(list, caseNumber);
  const clean = title.trim();
  if (!clean) throw new Error("a case needs a title");
  assertSingleLine(clean, "title");
  const lines = [...list.lines];
  lines[testCase.headingIndex] = `## ${testCase.number}. ${clean}`;
  return reparse(lines);
}

export function addRule(list: TestList, caseNumber: number, key: string, value: string): TestList {
  const testCase = findCase(list, caseNumber);
  const cleanKey = key.trim();
  if (!cleanKey) throw new Error("a rule needs a key");
  assertSingleLine(value, "value");

  const lines = [...list.lines];
  let lastBullet = -1;
  for (let i = testCase.headingIndex + 1; i < testCase.endIndex; i++) {
    if (BULLET.test(lines[i])) lastBullet = i;
  }

  let at: number;
  let block: string[];
  if (lastBullet >= 0) {
    const indent = lines[lastBullet].match(/^\s*/)?.[0] ?? "";
    at = lastBullet + 1;
    block = [formatBullet(indent, cleanKey, value.trim())];
  } else {
    // No bullets yet: the first bullet goes under the heading and its blank line.
    const blank = lines[testCase.headingIndex + 1] === "";
    at = testCase.headingIndex + (blank ? 2 : 1);
    block = [...(blank ? [] : [""]), formatBullet("", cleanKey, value.trim())];
    // Separate the bullet from description text that follows it.
    if (at < testCase.endIndex && lines[at] !== "") block.push("");
  }
  // Keep a blank line between this case and the heading that follows it.
  if (at === testCase.endIndex && testCase.endIndex < lines.length) block.push("");

  lines.splice(at, 0, ...block);
  return reparse(lines);
}

export function removeLine(list: TestList, index: number): TestList {
  if (!Number.isInteger(index) || index < 0 || index >= list.lines.length) {
    throw new Error(`line ${index} is outside this test list`);
  }
  return reparse(list.lines.filter((_, i) => i !== index));
}

export function addCase(list: TestList, title: string): TestList {
  const clean = title.trim();
  if (!clean) throw new Error("a case needs a title");
  assertSingleLine(clean, "title");

  const next = list.cases.reduce((max, c) => Math.max(max, c.number), 0) + 1;

  const lines = [...list.lines];
  // A file that ends in a newline has an empty last element; keep that newline last.
  const trailingNewline = lines[lines.length - 1] === "";
  const body = trailingNewline ? lines.slice(0, -1) : lines;
  if (body.length > 0 && body[body.length - 1] !== "") body.push("");
  body.push(`## ${next}. ${clean}`, "", formatBullet("", "kind", "task"));
  if (trailingNewline) body.push("");
  return reparse(body);
}
