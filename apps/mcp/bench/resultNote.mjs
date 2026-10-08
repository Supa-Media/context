// Reads the Markdown the benchmark writes back into data: a result note's
// answers, and the "## Judged by" sections judging adds to it. report.mjs and
// judge.mjs write these; judge and score both read them through here, so the
// two never disagree about the format.

const normalize = (raw) => String(raw ?? "").replace(/\r\n?/g, "\n");

/** The front matter's "key: value" lines, as strings. Empty when there is none. */
export function frontMatter(raw) {
  const lines = normalize(raw).split("\n");
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const front = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) front[m[1]] = m[2].trim();
  }
  return front;
}

/** The note with its status line replaced. Nothing else in the note changes. */
export function setFrontStatus(raw, status) {
  const lines = normalize(raw).split("\n");
  if (lines[0] !== "---") throw new Error("result note has no front matter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("result note front matter is not closed");
  const at = lines.slice(1, end).findIndex((line) => /^status:/.test(line));
  if (at >= 0) lines[at + 1] = `status: ${status}`;
  else lines.splice(end, 0, `status: ${status}`);
  return lines.join("\n");
}

const SPEAKER = /^\*\*(Person|Assistant):\*\*(?: (.*))?$/;
// "Time 4.2 s, $0.0002, 1 text", or "Time n/a, unknown, 2 texts" when time or price is missing.
const TIME = /^Time (?:(\d+(?:\.\d+)?) s|n\/a), (unknown|\$\d+(?:\.\d+)?), (\d+) texts?$/;

// Undo report.mjs's escaping of a line that would start a heading.
const unescapeHeadings = (text) => text.replace(/^(\s{0,3})\\#/gm, "$1#");

function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

// Each "**Person:**" or "**Assistant:**" line starts a turn; the lines under it are its text.
function readConversation(lines) {
  const turns = [];
  for (const line of lines) {
    const m = line.match(SPEAKER);
    if (m) turns.push({ from: m[1] === "Person" ? "person" : "assistant", lines: [m[2] ?? ""] });
    else if (turns.length) turns.at(-1).lines.push(line);
  }
  return turns.map((turn) => ({ from: turn.from, text: unescapeHeadings(trimBlank(turn.lines).join("\n")) }));
}

// One answer block. The Tools line comes after the conversation, so the last
// one is the real one even if a text happens to contain the same words.
function readBlock(id, lines) {
  const toolsAt = lines.findLastIndex((line) => line.startsWith("Tools: "));
  const body = toolsAt < 0 ? lines : lines.slice(0, toolsAt);
  const tail = toolsAt < 0 ? [] : lines.slice(toolsAt + 1);
  const toolsLine = toolsAt < 0 ? null : lines[toolsAt];
  const toolList = toolsLine === null ? "none" : toolsLine.slice("Tools: ".length).trim();
  const timeLine = tail.find((line) => TIME.test(line));
  const errorLine = tail.find((line) => line.startsWith("Error: "));
  let time = null;
  if (timeLine) {
    const m = timeLine.match(TIME);
    time = { seconds: m[1] === undefined ? null : Number(m[1]), price: m[2] === "unknown" ? null : Number(m[2].slice(1)), texts: Number(m[3]) };
  }
  return {
    id,
    conversation: readConversation(body),
    toolsLine,
    tools: toolList === "none" ? [] : toolList.split(", "),
    changes: tail.filter((line) => line.startsWith("- ")),
    time,
    error: errorLine ? errorLine.slice("Error: ".length) : null,
  };
}

/**
 * A result note's answers, one per block, each with its question number,
 * the question's text and who asked it, and what the block recorded.
 */
export function parseResult(raw) {
  const lines = normalize(raw).split("\n");
  const start = lines.indexOf("## Answers");
  const front = frontMatter(raw);
  if (start < 0) return { front, answers: [] };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const found = [];
  let question = null;
  let block = null;
  for (const line of lines.slice(start + 1, end)) {
    let m;
    if ((m = line.match(/^### (\d+)\. (.*)$/))) {
      question = { number: Number(m[1]), text: m[2], as: null, kind: null, gate: false };
      block = null;
    } else if (!question) {
      continue;
    } else if ((m = line.match(/^#### (\S+)$/))) {
      block = { id: m[1], lines: [] };
      found.push({ question, block });
    } else if (block) {
      block.lines.push(line);
    } else if (question.as === null && (m = line.match(/^as (.*)$/))) {
      // "as Maya, lookup" or "as Sam, privacy, gate".
      const parts = m[1].split(", ");
      question.as = parts[0];
      question.kind = parts[1] ?? null;
      question.gate = parts.includes("gate");
    }
  }
  const answers = found.map(({ question: q, block: b }) => ({
    question: q.number,
    questionText: q.text,
    as: q.as,
    kind: q.kind,
    gate: q.gate,
    ...readBlock(b.id, b.lines),
  }));
  return { front, answers };
}

// A table cell: one line, with pipes escaped so the row still splits.
const cell = (text) => String(text ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

// The cells of one "| a | b |" row. An escaped pipe stays inside its cell.
function splitRow(row) {
  const cells = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  // The row starts and ends with a pipe, so the first and last cells are empty.
  return cells.slice(1, -1);
}

/**
 * One "## Judged by" section, as judge.mjs appends it. Each block is an answer
 * id with its verdicts ({kind, line, pass, reason}) and, for a gate, "passed"
 * or "failed".
 */
export function judgedSection({ model, date, blocks }) {
  const out = [`## Judged by ${model}, ${date}`, ""];
  for (const block of blocks) {
    out.push(`### ${block.id}`, "");
    if (block.verdicts.length) {
      out.push("| kind | line | verdict | reason |", "| --- | --- | --- | --- |");
      for (const v of block.verdicts) {
        out.push(`| ${[v.kind, v.line, v.pass ? "pass" : "fail", v.reason].map(cell).join(" | ")} |`);
      }
      out.push("");
    }
    if (block.gate) out.push(`gate: ${block.gate}`, "");
  }
  return out.join("\n");
}

/** The key file's rows: which setup, question and run wrote each answer id. */
export function parseKey(raw) {
  const rows = [];
  for (const line of normalize(raw).split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = splitRow(line);
    if (cells.length !== 4 || cells[0] === "id" || /^-+$/.test(cells[0])) continue;
    const question = Number(cells[2]);
    const run = Number(cells[3]);
    if (!Number.isInteger(question) || !Number.isInteger(run)) throw new Error(`key row ${cells[0]} has no question and run numbers`);
    rows.push({ id: cells[0], setup: cells[1], question, run });
  }
  return rows;
}

/** Every "## Judged by" section in a note, in the order they were appended. */
export function parseJudgedSections(raw) {
  const sections = [];
  let section = null;
  let block = null;
  for (const line of normalize(raw).split("\n")) {
    let m;
    if ((m = line.match(/^## Judged by (.+), (\d{4}-\d{2}-\d{2})$/))) {
      section = { model: m[1], date: m[2], blocks: new Map() };
      sections.push(section);
      block = null;
    } else if (/^## /.test(line)) {
      section = null;
      block = null;
    } else if (!section) {
      continue;
    } else if ((m = line.match(/^### (\S+)$/))) {
      block = { verdicts: [], gate: null };
      section.blocks.set(m[1], block);
    } else if (!block) {
      continue;
    } else if ((m = line.match(/^gate: (passed|failed)$/))) {
      block.gate = m[1];
    } else if (line.startsWith("|")) {
      const cells = splitRow(line);
      if (cells.length === 4 && (cells[2] === "pass" || cells[2] === "fail")) {
        block.verdicts.push({ kind: cells[0], line: cells[1], pass: cells[2] === "pass", reason: cells[3] });
      }
    }
  }
  return sections;
}
