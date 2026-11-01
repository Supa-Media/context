/**
 * THE OLD VISIBLE MEMORY NOTE OF A GROUP CHAT, READ ONCE (2026-11-01).
 *
 * Each chat used to keep a note, `tex/groups/chat-<id>.md` (the owner,
 * 2026-10-23: "Visible tex/ folder, team-wide"), in its home or its bound
 * workspace, holding what was asked, what Tex answered, and on a hidden line
 * under each answer the tools it used and the notes and pages it read or wrote
 * (`sources.js`). Tex read it before it answered and rewrote it after.
 *
 * The owner, 2026-11-01: one copy, in the chat's Durable Object, and no group
 * chat data in a workspace folder. The record is the history now
 * (`groupMemoryCarry.js`). In a chat's home the same note is still written,
 * as a printout of the record after each reply so the chat's people can read
 * and download it, and never read back (`writeMemoryPrintout`). What else is
 * left here is its format: where it was (`groupNotePath`), and how to read it,
 * so an old note's words are carried into the record once (`parseGroupNote`).
 */

import { sourcesOf } from "./sources.js";
import { readWithEtag } from "./jobLog.js";

export const GROUP_NOTES_FOLDER = "tex/groups";

const HEADING = "# Tex's memory of this group chat";
const INTRO =
  "Tex reads this note before it answers in the chat and adds to it after. Change or delete anything here and Tex goes by what's left. Everyone in this workspace can read it.";
const GUEST_INTRO = INTRO.replace("Everyone in this workspace", "Everyone in this chat");
/** The printout's: it is written from the record and never read (`groupMemoryCarry.js`). */
const PRINTOUT_INTRO =
  "A copy of what Tex remembers of this chat, rewritten after each reply. Tex never reads this page, so a change here doesn't change what it remembers; tell Tex in the chat instead. Only the people in this chat can open it.";
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

/** The kept turns as the note's text: the old note's (`guests` for its home form), or with `printout` the page written from the record. */
export function renderGroupNote(turns, { guests = false, printout = false } = {}) {
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
  return `${HEADING}\n\n${printout ? PRINTOUT_INTRO : guests ? GUEST_INTRO : INTRO}\n\n${RULE}\n\n${blocks.join("\n\n")}\n`;
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

/**
 * The record's turns written over the home's page (`printout`), never read back for its words. An existing page is
 * written at the version just read, as every write over a note must be, and a write that lost to another is tried once
 * more. Whether it was written; a refusal is one structured line with the tool's leading words, never the page's.
 */
export async function writeMemoryPrintout(dispatch, path, turns, { log = console.log } = {}) {
  const content = renderGroupNote(turns, { printout: true });
  let reason = "unreadable";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const seen = await readWithEtag(dispatch, path);
    if (seen === null) break;
    try {
      const result = await dispatch("write_note", { path, content, ...(seen.missing === true ? {} : { expected_etag: seen.etag }) });
      if (result?.isError !== true) return true;
      reason = String(result?.content?.[0]?.text ?? "").split(/[:\n(]/, 1)[0].trim().slice(0, 60) || "refused";
      if (reason !== "conflict") break;
    } catch (error) {
      reason = error?.name ?? "error";
      break;
    }
  }
  log(JSON.stringify({ event: "group_memory_printout_not_written", reason }));
  return false;
}
