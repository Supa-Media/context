/**
 * A note found by meaning, shown as its title and the passage that matched: the same words whether the gateway read
 * the note itself (`serve.js` `meaningSnippet`) or the workspace's object read it beside its text
 * (`workspaceStore/meaningIndex.js` `snippets`).
 */

import { extractFields } from "../indexer.js";
import { noteTitle } from "../resultText.js";
import { meaningPassages } from "./project.js";

/**
 * @param {string} path
 * @param {string} text the note's Markdown
 * @param {number} chunk the passage that matched
 * @param {number} chars how much of it to show
 * @returns {{title: string, snippets: string[]}}
 */
export function snippetFromText(path, text, chunk, chars = 200) {
  // An encrypted note's passages are its title alone (`meaningPassages` reads
  // through `indexableText`), so its snippet is empty and no ciphertext shows.
  const passages = meaningPassages(path, text);
  const passage = passages[chunk] ?? passages[0] ?? "";
  // A passage is the indexed title, a blank line, then its slice of the body
  // (`meaningPassages`), so the snippet is what follows that title.
  const indexedTitle = String(extractFields(path, text).title ?? "").trim();
  const body = passage.startsWith(indexedTitle) ? passage.slice(indexedTitle.length) : passage;
  const line = body.replace(/\s+/g, " ").trim().slice(0, chars);
  return { title: noteTitle(path, text), snippets: line ? [line] : [] };
}
