/**
 * A GROUP CHAT'S MEMORY AS A NOTE PEOPLE CAN READ AND FIX (the owner,
 * 2026-10-23: "Visible tex/ folder, team-wide").
 *
 * Each chat, filed by the exact set of people in it as before
 * (`groupTurn.js`), keeps `tex/groups/chat-<id>.md` in its workspace: what
 * was asked, what Tex answered, and on a hidden line under each answer the
 * tools it used and the notes and pages it read or wrote (`sources.js`).
 * Tex reads the note before it answers and rewrites it after, so a line
 * someone changed or deleted there is what Tex goes by next time.
 *
 * It is a workspace note at the folder's visibility, so everyone in the
 * workspace can read it, people not in the chat included; the owner chose
 * that over memory nobody can see. Somebody added to the chat still starts
 * a new note and is never replayed what came before them.
 *
 * Written and read through the dispatcher under the turn's own grant, like a
 * texted turn's transcript (`transcript.js`). A tagger whose role can't write
 * there keeps the chat's memory in the plumbing file alone, and the note is
 * preferred only while nobody has changed it since Tex last wrote it, so an
 * exchange that reached only the plumbing file is not lost.
 */

import { loadPrivacyState, setRowTier } from "../privacy/state.js";
import { servedListingStore } from "../tree/served.js";
import { sourcesOf } from "./sources.js";

export const GROUP_NOTES_FOLDER = "tex/groups";

const HEADING = "# Tex's memory of this group chat";
const INTRO =
  "Tex reads this note before it answers in the chat and adds to it after. Change or delete anything here and Tex goes by what's left. Everyone in this workspace can read it.";
const GUEST_INTRO = INTRO.replace("Everyone in this workspace", "Everyone in this chat");
const RULE = "---";
const TEX = "**Tex:**";
const META = /^<!--\s*tex used:(.*)-->$/;

/** The chat's note, from the same hash its plumbing file is named by; a guest chat's is in its own folder (`groupGuests.js`). */
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

/** The kept turns as the note's text. */
export function renderGroupNote(turns, { guests = false } = {}) {
  const blocks = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "user") {
      blocks.push(escaped(turn.text));
      continue;
    }
    const meta = metaLine(turn);
    blocks.push(`${TEX} ${escaped(turn.text)}${meta ? `\n${meta}` : ""}`);
    if (i < turns.length - 1) blocks.push(RULE);
  }
  return `${HEADING}\n\n${guests ? GUEST_INTRO : INTRO}\n\n${RULE}\n\n${blocks.join("\n\n")}\n`;
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
      answer.meta = readMeta(meta[1]);
      continue;
    }
    (answer === null ? asked : answer.lines).push(line);
  }
  close();
  return turns;
}

/** The note's etag and text, or null when there is none or it can't be read. */
export async function readGroupNote(dispatch, path) {
  try {
    const result = await dispatch("read_note", { path });
    if (result?.isError === true) return null;
    const text = String(result?.content?.[0]?.text ?? "");
    const etag = /^etag: (\S+)/m.exec(text)?.[1];
    const body = text.indexOf("\n\n");
    if (!etag || body < 0) return null;
    return { etag, text: text.slice(body + 2) };
  } catch {
    return null;
  }
}

/**
 * Share `tex/groups/` with the workspace the first time a chat's note can't
 * be written there, so the owner never has to make the folder by hand. Only
 * that folder, never `tex/` (which holds transcripts, about-me and the like),
 * and only when nobody has set `tex/` or anything under `tex/groups/`, private
 * included, and nothing this grant can see is filed there yet: a choice
 * someone made is never widened, and a note held back by name keeps its own
 * setting (the nearest setting wins). The control plane decides whether this
 * grant may change access at all (owners and editors); a refusal leaves things
 * as they were. Whether it shared the folder.
 *
 * What is filed there is read from the tree, never the bucket: a note's bytes
 * live at `notes/<noteId>.md` and its folder is a row, so a listing by path
 * prefix finds nothing however much is in the folder (2026-10-24). A tree
 * that cannot answer shares nothing and the owner makes the folder by hand,
 * which is the safe way for this one to fall.
 */
export async function shareGroupNotesFolder(store) {
  if (typeof store?.rowAccess?.setTier !== "function") return false;
  try {
    const { rules, error } = await loadPrivacyState(store);
    if (error) return false;
    const set = (raw) => {
      const prefix = String(raw ?? "").replace(/\/+$/, "");
      return prefix === "tex" || prefix === GROUP_NOTES_FOLDER || prefix.startsWith(`${GROUP_NOTES_FOLDER}/`);
    };
    if (rules.some((rule) => set(rule.prefix))) return false;
    const filed = await servedListingStore(store).list({ prefix: `${GROUP_NOTES_FOLDER}/`, limit: 1 });
    if ((filed?.objects ?? filed?.keys ?? []).length > 0) return false;
    return await setRowTier(store, GROUP_NOTES_FOLDER, "team", { folder: true });
  } catch {
    return false;
  }
}

/** Write the note; its new etag, or null when this grant couldn't. */
export async function writeGroupNote(dispatch, path, turns, etag = null, { guests = false } = {}) {
  try {
    const result = await dispatch("write_note", { path, content: renderGroupNote(turns, { guests }), ...(etag ? { expected_etag: etag } : {}) });
    if (result?.isError === true) return null;
    return /\(etag ([^)\s]+)\)/.exec(String(result?.content?.[0]?.text ?? ""))?.[1] ?? null;
  } catch {
    return null;
  }
}
