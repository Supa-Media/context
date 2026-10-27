/**
 * THE FACTS THEIR OTHER AI APPS SAVED, FOR TEX'S DREAM.
 *
 * Found 2026-10-23 auditing what Tex knows about a person (Dev2: "I also fear
 * it's not remembering other things about me"): Claude, ChatGPT and every
 * other client they connect save what they learn with `remember`, and a fact
 * with no note lands in its own inbox note (`tools/notes/remember.js`,
 * `inbox/memories/2026-10-23-<slug>.md`). Tex only ever read
 * `tex/about-me.md`, and its dream only read Tex's own transcripts, so a
 * fact told to Claude never reached Tex. The dream now reads the ones saved
 * since it last ran and keeps the lasting ones in `tex/about-me.md`.
 */

import { MEMORY_FOLDER } from "../tools/notes/remember.js";
import { inboxPath } from "../communications/inboxFolders.js";
import { dayOf } from "./jobLog.js";

/** The most memory notes one dream is pointed at, newest kept. */
export const MAX_DREAM_MEMORIES = 30;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The memory notes a dream reads, from a `list_notes` answer under `folder`:
 * those dated from `since` to today, or every one on a first dream (`since`
 * null), oldest first, at most `MAX_DREAM_MEMORIES`, newest kept.
 */
export function memoriesToRead(listing, folder, { since, now, timeZone }) {
  const from = typeof since === "number" ? dayOf(since, timeZone) : "0000-00-00";
  const to = dayOf(now, timeZone);
  const pattern = new RegExp(`^(${escape(folder)}/(\\d{4}-\\d{2}-\\d{2})-[^/\\s]+\\.md) \\(`);
  const found = [];
  for (const line of String(listing ?? "").split("\n")) {
    const match = pattern.exec(line.trim());
    if (!match || match[2] < from || match[2] > to) continue;
    found.push({ path: match[1], day: match[2] });
  }
  found.sort((a, b) => (a.day === b.day ? (a.path < b.path ? -1 : 1) : a.day < b.day ? -1 : 1));
  return found.slice(-MAX_DREAM_MEMORIES).map((entry) => entry.path);
}

/** The memory notes for tonight, through the dream's own dispatcher. Never throws: none is fewer facts, not a failed dream. */
export async function findMemories(store, dispatch, { since, now, timeZone }) {
  try {
    const folder = await inboxPath(store, MEMORY_FOLDER);
    const listed = await dispatch("list_notes", { prefix: folder });
    if (listed?.isError === true) return [];
    const listing = (listed?.content ?? []).map((part) => part?.text ?? "").join("\n");
    return memoriesToRead(listing, folder, { since, now, timeZone });
  } catch {
    return [];
  }
}

/** What the dream is told about them, or "". */
export function memoriesLine(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return "";
  return (
    "Read these notes too: facts they saved about themselves through their other AI apps (Claude, ChatGPT and the like). " +
    "Keep the lasting ones, and where one contradicts the note, the newer fact wins:\n" +
    memories.map((path) => `- ${path}`).join("\n")
  );
}
