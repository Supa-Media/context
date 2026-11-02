/**
 * A GROUP CHAT'S MEMORY PAGE, THE ONE COPY OF ITS HISTORY (the owner, 2026-11-01).
 *
 * The owner chose: the chat's people still see what Tex remembers, as a page
 * in the chat's home in @context-lc, and that page is the only copy. Its text
 * lives in the chat's Durable Object like every Tex note
 * (`docs/decisions/texting-assistant/tex-durable-objects.md`), so the chat's
 * people read it, Download as folders carries it, and Tex reads it before it
 * answers and adds to it after. A change somebody makes there is what Tex
 * goes by (`groupMemoryCarry.js`).
 *
 * It holds what was asked, what Tex answered, and on a hidden line under each
 * answer the tools it used and the notes and pages it read or wrote
 * (`sources.js`). Here: where it is (`groupNotePath`), how to read it
 * (`parseGroupNote`, also how an old note in a workspace folder is carried in
 * once), and how to add to it without losing a write (`updateGroupPage`).
 */

import { sourcesOf } from "./sources.js";
import { readWithEtag, refusalWords } from "./jobLog.js";

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

/**
 * The page's turns and version: `{turns, etag, missing}`, `turns` null when the page is there but is not one Tex can
 * read (its heading is gone). Null when it could not be read, which is never the same as a page with nothing on it.
 */
export async function readGroupPage(dispatch, path) {
  const seen = await readWithEtag(dispatch, path);
  if (seen === null) return null;
  if (seen.missing === true) return { turns: [], etag: null, missing: true };
  return { turns: parseGroupNote(seen.body), etag: seen.etag, missing: false };
}

/** Writes the page takes before one is given up on: two more after a write another turn or person won. */
export const PAGE_TRIES = 3;

/**
 * The page with `change(turns)` written over it, at the version just read: a write another turn or a person landed
 * first is read again and `change` applied to that, so neither is lost. A page Tex cannot read is never written over
 * (somebody's own words may be on it). Whether it was written; a refusal is one structured line with the tool's
 * leading words, never the page's.
 */
export async function updateGroupPage(dispatch, path, change, { log = console.log, onRefused = null } = {}) {
  let reason = "unreadable";
  for (let attempt = 0; attempt < PAGE_TRIES; attempt += 1) {
    const page = await readGroupPage(dispatch, path);
    if (page === null) break;
    if (page.turns === null) {
      reason = "not_a_memory_page";
      break;
    }
    try {
      const content = renderGroupNote(change(page.turns));
      const result = await dispatch("write_note", { path, content, ...(page.missing ? {} : { expected_etag: page.etag }) });
      if (result?.isError !== true) return true;
      reason = refusalWords(result);
      if (reason !== "conflict") break;
    } catch (error) {
      reason = error?.name ?? "error";
      break;
    }
  }
  const code = reasonCode(reason);
  log(JSON.stringify({ event: "group_memory_page_not_written", reason: code }));
  if (typeof onRefused === "function") onRefused(code);
  return false;
}

/**
 * A refusal's leading words as a code a public log keeps (`.github/workflows/agent-logs.yml` prints anything else as
 * `other`): "permission denied" is `permission_denied`. Only the words before the first `:`, newline or `(`, as
 * `refusalWords` already cuts them, and never more than 40 characters.
 */
export function reasonCode(words) {
  return String(words ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "") || "refused";
}
