/**
 * A group chat's memory page as text: how it is written (`renderGroupNote`)
 * and read (`parseGroupNote`), with nothing that reads or writes a store, so
 * the control plane can read a page too (`texGroupPagesRetire.ts`). Where the
 * page is and how it is kept: `groupMemoryNote.js`.
 */

import { sourcesOf } from "./sources.js";

export const GROUP_NOTES_FOLDER = "tex/groups";

const HEADING = "# Tex's memory of this group chat";
const INTRO =
  "Tex reads this page before it answers in the chat and adds to it after. Change or delete anything here and Tex goes by what's left. Only the people in this chat can open it.";
const RULE = "---";
const TEX = "**Tex:**";
const META = /^<!--\s*tex used:(.*)-->$/;
const TIMING = /^<!--\s*tex timing:(.*)-->$/;
const MAX_TIMING = 1_200;

/** The chat's note, from the hash of its key; a guest chat's is in its own folder (`groupGuests.js`). */
export function groupNotePath(hash, folder = GROUP_NOTES_FOLDER) {
  return `${folder}/chat-${hash.slice(0, 12)}.md`;
}


/** A line that would read as the note's own structure, kept as words. */
function escaped(text) {
  return String(text)
    .split("\n")
    .map((line) => (line.trim() === RULE ? "- - -" : line.startsWith(TEX) ? `\\${line}` : line))
    .join("\n")
    .trim();
}

function unescaped(text) {
  return text
    .split("\n")
    .map((line) => (line.startsWith(`\\${TEX}`) ? line.slice(1) : line))
    .join("\n")
    .trim();
}

/** The hidden line under an answer: its tools and sources, never a word of what they returned. */
function metaLine(turn) {
  const tools = (turn.tools ?? []).filter((name) => /^[a-z][a-z0-9_]{0,39}$/.test(name));
  const sources = sourcesOf(turn.sources).filter((source) => !source.includes("--") && !source.includes("|"));
  if (tools.length === 0 && sources.length === 0 && turn.tainted !== true) return null;
  return `<!-- tex used: ${tools.join(", ")}|${sources.join(" ")}${turn.tainted === true ? " tainted" : ""} -->`;
}

/**
 * An answer's timing (`turnLog.js` `groupTimingLine`), kept on the turn so the
 * note keeps it each time it is written again: one line of times and
 * durations, shown hidden under the answer, never read by the model.
 */
export function timedTurn(role, timing) {
  if (role !== "assistant" || typeof timing !== "string") return {};
  const line = timing.trim();
  return line && line.length <= MAX_TIMING && !line.includes("--") && !/[\u0000-\u001f]/.test(line) ? { timing: line } : {};
}

/** The kept turns as the page's text. */
export function renderGroupNote(turns) {
  const blocks = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "user") {
      blocks.push(escaped(turn.text));
      continue;
    }
    const meta = metaLine(turn);
    const timing = timedTurn(turn.role, turn.timing).timing;
    blocks.push(`${TEX} ${escaped(turn.text)}${meta ? `\n${meta}` : ""}${timing ? `\n<!-- tex timing: ${timing} -->` : ""}`);
    if (i < turns.length - 1) blocks.push(RULE);
  }
  return `${HEADING}\n\n${INTRO}\n\n${RULE}\n\n${blocks.join("\n\n")}\n`;
}

/** What a hidden line says: "a, b|source source tainted". */
function readMeta(raw) {
  const [named = "", listed = ""] = raw.split("|");
  const words = listed.trim().split(/\s+/).filter(Boolean);
  const tainted = words.at(-1) === "tainted";
  const tools = named.split(",").map((name) => name.trim()).filter((name) => /^[a-z][a-z0-9_]{0,39}$/.test(name));
  const sources = sourcesOf(tainted ? words.slice(0, -1) : words);
  return { ...(tools.length > 0 ? { tools } : {}), ...(sources.length > 0 ? { sources } : {}), ...(tainted ? { tainted: true } : {}) };
}

/**
 * The turns a note holds, or null when it isn't one Tex can read: a question
 * is everything since the last answer, an answer starts at **Tex:** and runs
 * to the next `---`.
 */
export function parseGroupNote(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === RULE);
  if (start < 0 || !lines.slice(0, start).some((line) => line.trim() === HEADING)) return null;
  const turns = [];
  let asked = [];
  let answer = null;
  const close = () => {
    if (answer === null) return;
    const question = unescaped(asked.join("\n"));
    const said = unescaped(answer.lines.join("\n"));
    if (question && said) {
      turns.push({ role: "user", text: question });
      turns.push({ role: "assistant", text: said, ...answer.meta });
    }
    asked = [];
    answer = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === RULE) {
      close();
      continue;
    }
    if (answer === null && line.startsWith(TEX)) {
      answer = { lines: [line.slice(TEX.length).trim()], meta: {} };
      continue;
    }
    const meta = answer !== null ? META.exec(line.trim()) : null;
    if (meta) {
      answer.meta = { ...answer.meta, ...readMeta(meta[1]) };
      continue;
    }
    const timing = answer !== null ? TIMING.exec(line.trim()) : null;
    if (timing) {
      answer.meta = { ...answer.meta, ...timedTurn("assistant", timing[1]) };
      continue;
    }
    (answer === null ? asked : answer.lines).push(line);
  }
  close();
  return turns;
}
