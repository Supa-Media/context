/*
 * The package's public surface, and nothing else. The engine is split by
 * responsibility into the modules beside this file — storage layout, Yjs
 * documents, durable records, structural recovery, loading, commits and
 * lifecycle transitions — and this file re-exports exactly the names
 * `index.d.ts` declares.
 */

export { eligible } from "./eligibility.js";
export { CollaborationError, supported } from "./storage.js";
export { readDocument, commitUpdate } from "./commit.js";
export { replaceText } from "./replace.js";
export { sealDocument, moveDocument, tombstoneDocument, restoreDocument } from "./lifecycle.js";
