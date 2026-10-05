// Key builders for the link-graph derivative under `.context/graph/` (arch 9.1).
// Every key has a dot segment, so `isPlumbing` and `defaultIsIndexable` already
// hide it; no visibility rule lives here.
import { GRAPH_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { sha256Hex } from "../ingestion/inbox.js";

const GRAPH_ROOT = `${GRAPH_PREFIX}v1/`;
const FAMILIES = new Set(["incoming", "bare", "names", "urls"]);

export const graphManifestKey = () => `${GRAPH_ROOT}manifest.json`;
export const nodeKey = (gen, pathHash) => `${GRAPH_ROOT}g/${gen}/nodes/${pathHash}.json`;

/** Page 0 is the head; a missing head means an empty list (OPEN-3). */
export function postingPageKey(gen, family, hash, page) {
  if (!FAMILIES.has(family)) throw new Error(`unknown posting family: ${family}`);
  return `${GRAPH_ROOT}g/${gen}/${family}/${hash}/${page}.json`;
}

// Case-sensitive on purpose (arch 7.2): `A.md` and `a.md` are different keys.
export const pathHash = (path) => sha256Hex(path);
export const nameHash = (name) => sha256Hex(name);
export const urlHash = (urlKey) => sha256Hex(urlKey);
