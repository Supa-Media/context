/*
 * The package's public surface, and nothing else. The engine is split by
 * responsibility into the modules beside this file — storage layout, Yjs
 * documents, durable records, structural recovery, loading, commits and
 * lifecycle transitions — and this file re-exports exactly the names
 * `index.d.ts` declares.
 *
 * Every entry that takes a store runs on its own operation scope (`scoped`,
 * `address.js`), so the note ids the engine looks up are asked once per
 * operation and never kept past it.
 */

import { readDocument as read, readDocumentIfStarted as readIfStarted, documentStarted as started, commitUpdate as commit } from "./commit.js";
import { replaceText as replace } from "./replace.js";
import { sealDocument as seal, moveDocument as move, tombstoneDocument as tombstone, restoreDocument as restore } from "./lifecycle.js";
import { renameDocument as rename } from "./rename.js";
import { eraseDocument as erase } from "./erase.js";
import { noteOfDocument as documentNote, pathHeadLive, scoped } from "./address.js";
import { fileHeadsByNote as fileHeads } from "./backfill.js";

/** `entry` with its store argument scoped to one operation. */
const scopedEntry = (entry) => (store, ...rest) => entry(scoped(store), ...rest);

export { eligible } from "./eligibility.js";
export { CollaborationError, supported } from "./storage.js";
export const readDocument = scopedEntry(read);
export const readDocumentIfStarted = scopedEntry(readIfStarted);
export const documentStarted = scopedEntry(started);
export const commitUpdate = scopedEntry(commit);
export const replaceText = scopedEntry(replace);
export const sealDocument = scopedEntry(seal);
export const moveDocument = scopedEntry(move);
export const tombstoneDocument = scopedEntry(tombstone);
export const restoreDocument = scopedEntry(restore);
export const renameDocument = scopedEntry(rename);
export const eraseDocument = scopedEntry(erase);
/** The note id a document was made for, or `null`. */
export const noteOfDocument = scopedEntry(documentNote);
export const fileHeadsByNote = scopedEntry(fileHeads);
export { pathHeadLive };
export { isCurrentEtag } from "./records.js";
