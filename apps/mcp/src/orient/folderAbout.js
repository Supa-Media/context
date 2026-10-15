/**
 * The one-line description `orient` draws beside each folder in its map: the
 * first sentence of the first paragraph of that folder's front note.
 *
 * A folder explains what it is for in a note inside it — `about.md`, or one of
 * the older names in `FRONT_NOTES` — so an agent learns the purpose of a folder
 * from the map without opening it. Three rules keep that from becoming a leak
 * or a bill:
 *
 * **Only a note this connection can see is a candidate.** `surveyContext`
 * chooses the candidates from the same visibility filter the listing uses, so a
 * private `about.md` is neither read nor named. If the owner's `about.md` is
 * hidden and their `overview.md` is not, the overview describes the folder: a
 * hidden note must not become a visible absence that gives its existence away.
 *
 * **Candidates come from a listing, never from guessing.** Every name is checked
 * against keys the survey already holds, so a folder with no front note costs
 * nothing, and no name is asked for that the tree does not have.
 *
 * **No note is opened.** The first paragraph comes from the Convex tree's
 * props for each candidate (`factProps`, `tree/facts.js`), one request per
 * hundred folders, so every folder the map draws can be described. A front
 * note the facts have not read yet, or a request that fails, costs its folder
 * the description, and the map stands.
 */

import { FRONT_NOTES } from "../lists/grammar.js";
import { factProps } from "../tree/facts.js";
import { ORIENT_CHILDREN_LIMIT } from "./render.js";

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
 * throw into `orient`.
 */
export async function describeFolders(store, survey) {
  // Only what the map draws: a child past the render limit is never asked about.
  const nodes = [
    ...survey.folders,
    ...survey.folders.flatMap((folder) => folder.children.slice(0, ORIENT_CHILDREN_LIMIT)),
  ].filter((node) => node.front.length > 0);
  if (nodes.length === 0) return;
  const found = await factProps(store, nodes.flatMap((node) => node.front)).catch(() => null);
  if (found === null) return;
  for (const node of nodes) {
    for (const key of node.front) {
      const line = aboutLine(key, found.get(key));
      if (line) {
        node.description = line;
        break;
      }
    }
  }
}

/**
 * The description a front note's props give, or `null` when they give none.
 *
 * A sealed note gives none: its text is ciphertext, and the facts kept nothing
 * of it. The `README.md` placeholders are skipped by their opening sentence,
 * because they were written by us to fill a folder that had nothing in it and
 * describe nothing the owner said.
 */
export function aboutLine(key, fact) {
  if (!fact || fact.sealed || typeof fact.props?.lede !== "string") return null;
  const lede = fact.props.lede.trim();
  if (lede === "") return null;
  if (key.endsWith("/README.md") && lede.startsWith(PLACEHOLDER_START)) return null;
  // "e.g." ends a sentence early here. A description that stops at the first
  // full stop is still the right kind of thing to show, and it is cheaper than
  // a tokenizer that would have to be right about every abbreviation.
  const sentence = lede.match(/^(.+?[.!?])(?=\s|$)/)?.[1] ?? lede;
  return capDescription(sentence);
}

function capDescription(text) {
  return text.length > FOLDER_ABOUT_CHARS ? `${text.slice(0, FOLDER_ABOUT_CHARS - 1).trimEnd()}…` : text;
}
