/**
 * The one-line description `orient` draws beside each folder in its map: the
 * first prose line of that folder's front note.
 *
 * A folder explains what it is for in a note inside it — `about.md`, or one of
 * the older names in `FRONT_NOTES` — so an agent learns the purpose of a folder
 * from the map without opening it. Three rules keep that from becoming a leak
 * or an unbounded bill:
 *
 * **Only a note this connection can see is a candidate.** `surveyContext`
 * chooses the candidates from the same visibility filter the listing uses, so a
 * private `about.md` is neither read nor named. If the owner's `about.md` is
 * hidden and their `overview.md` is not, the overview describes the folder: a
 * hidden note must not become a visible absence that gives its existence away.
 *
 * **Candidates come from a listing, never from guessing.** Every name is checked
 * against keys the survey already holds, so a folder with no front note costs
 * no read at all, and a read is never spent on a name the bucket does not have.
 *
 * **A fixed read budget.** The reads are spent in the order the map shows its
 * folders, top level first, and stop at `FOLDER_ABOUT_READ_CAP`. A folder past
 * the budget is drawn with no description rather than with one that was
 * guessed at, and a context with a great many folders degrades to the map it
 * had before this existed.
 */

import { isEncryptedNote } from "../encryption.js";
import { FRONT_NOTES } from "../lists/grammar.js";
import { mapInBatches } from "../notes/storage.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { ORIENT_CHILDREN_LIMIT } from "./render.js";

/** Subrequests one `orient` may spend on folder descriptions, in total. */
export const FOLDER_ABOUT_READ_CAP = 24;
const FOLDER_ABOUT_CONCURRENCY = 6;
/** Long enough to say what a folder is for; short enough to keep the map a map. */
export const FOLDER_ABOUT_CHARS = 120;
/** What the old auto-written `README.md` placeholders began with. */
const PLACEHOLDER_START = "Folder placeholder.";

/**
 * The front notes that sit directly inside `prefix`, in `FRONT_NOTES` order.
 *
 * `keys` is a Set of every key the survey has seen under that folder, and a
 * note nested deeper is not a candidate: `1-projects/x/about.md` describes
 * `1-projects/x/`, not `1-projects/`.
 */
export function frontNotesAmong(prefix, keys, isVisible) {
  return FRONT_NOTES.map((name) => `${prefix}${name}`).filter((key) => keys.has(key) && isVisible(key));
}

/**
 * Fill in `description` on every folder and child the map is about to draw.
 *
 * Mutates the survey in place: each node that has a `front` candidate gets a
 * `description` when one of its candidates yields a line. Nothing here can
 * throw into `orient` — a note that cannot be read costs its folder the
 * description, and the map stands.
 */
export async function describeFolders(store, survey) {
  // The order the map draws in, so the budget goes to what is shown first. A
  // child past the render limit is never drawn, so it is never read.
  const nodes = [
    ...survey.folders,
    ...survey.folders.flatMap((folder) => folder.children.slice(0, ORIENT_CHILDREN_LIMIT)),
  ].filter((node) => node.front.length > 0);

  // Checked and spent before each read rather than counted afterwards. Batches
  // run one after another, so a read is never issued past the cap, and within
  // a batch the counter is only ever bumped synchronously.
  let reads = 0;
  await mapInBatches(nodes, FOLDER_ABOUT_CONCURRENCY, async (node) => {
    for (const key of node.front) {
      if (reads >= FOLDER_ABOUT_READ_CAP) return;
      reads += 1;
      const line = await readAboutLine(store, key);
      if (line) {
        node.description = line;
        return;
      }
    }
  });
}

async function readAboutLine(store, key) {
  try {
    const object = await getWithLegacyFallback(store, key);
    if (!object) return null;
    return aboutLine(key, await object.text());
  } catch {
    // A storage failure on one front note must not take the whole map with it.
    return null;
  }
}

/**
 * The description a front note gives, or `null` when it gives none.
 *
 * An encrypted note is skipped whole: its body is a sealed envelope, and even a
 * prefix of it would be ciphertext in the map. The `README.md` placeholders are
 * skipped by their opening sentence, because they were written by us to fill a
 * folder that had nothing in it and describe nothing the owner said.
 */
export function aboutLine(key, text) {
  if (typeof text !== "string" || isEncryptedNote(text)) return null;
  const body = bodyAfterFrontmatter(text);
  if (key.endsWith("/README.md") && body.trimStart().startsWith(PLACEHOLDER_START)) return null;
  return firstProseSentence(body);
}

function bodyAfterFrontmatter(text) {
  const source = text.replace(/^﻿/, "");
  if (!source.startsWith("---")) return source;
  const end = source.indexOf("\n---", 3);
  // An unclosed `---` is more likely a rule than a header, so it is left as is.
  if (end < 0) return source;
  const lineEnd = source.indexOf("\n", end + 1);
  return lineEnd < 0 ? "" : source.slice(lineEnd + 1);
}

/**
 * The first sentence of the first line of prose, as plain text.
 *
 * Headings are skipped because they name the folder again, and fenced code,
 * HTML comments, tables and rules are not prose. Markdown is stripped down to
 * its words: a list marker, a quote marker, a link's label and a wiki link's
 * alias are what a person reads, and the emphasis characters around them are
 * not.
 */
function firstProseSentence(body) {
  let inFence = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line || /^(#|<|\||---|\*\*\*)/.test(line)) continue;
    const plain = line
      .replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, target, alias) => alias || target)
      .replace(/\*\*|__|[*`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) continue;
    // "e.g." ends a sentence early here. A description that stops at the first
    // full stop is still the right kind of thing to show, and it is cheaper than
    // a tokenizer that would have to be right about every abbreviation.
    const sentence = plain.match(/^(.+?[.!?])(?=\s|$)/)?.[1] ?? plain;
    return capDescription(sentence);
  }
  return null;
}

function capDescription(text) {
  return text.length > FOLDER_ABOUT_CHARS ? `${text.slice(0, FOLDER_ABOUT_CHARS - 1).trimEnd()}…` : text;
}
