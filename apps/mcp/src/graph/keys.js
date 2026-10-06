// Key builders for the link-graph derivative under `.context/graph/` (arch 9.1).
// Every key has a dot segment, so `isPlumbing` and `defaultIsIndexable` already
// hide it; no visibility rule lives here.
import { GRAPH_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { sha256Hex } from "../ingestion/inbox.js";

const GRAPH_ROOT = `${GRAPH_PREFIX}v1/`;
// Builders throw TypeError on a bad segment (programmer error, like an unknown
// family). Callers on a write or search path sit behind the graph try/catch.
const GEN = /^[0-9]+$/;
const HASH = /^[0-9a-f]{64}$/;
function seg(value, re, name) {
  if (typeof value !== "string" || !re.test(value)) throw new TypeError(`invalid graph key segment: ${name}`);
  return value;
}
const FAMILIES = new Set(["incoming", "bare", "names", "urls"]);

export const graphManifestKey = () => `${GRAPH_ROOT}manifest.json`;
/** Everything one generation holds; the reconciliation audit lists under it. */
export const generationPrefix = (gen) => `${GRAPH_ROOT}g/${seg(gen, GEN, "gen")}/`;
export const maintenanceCursorKey = (gen) => `${generationPrefix(gen)}maintenance/cursor.json`;
export const nodeKey = (gen, pathHash) =>
  `${GRAPH_ROOT}g/${seg(gen, GEN, "gen")}/nodes/${seg(pathHash, HASH, "hash")}.json`;

/** Page 0 is the head; a missing head means an empty list (OPEN-3). */
export function postingPageKey(gen, family, hash, page) {
  if (!FAMILIES.has(family)) throw new Error(`unknown posting family: ${family}`);
  if (!Number.isInteger(page) || page < 0) throw new TypeError("invalid graph key segment: page");
  return `${GRAPH_ROOT}g/${seg(gen, GEN, "gen")}/${family}/${seg(hash, HASH, "hash")}/${page}.json`;
}

// Case-sensitive on purpose (arch 7.2): `A.md` and `a.md` are different keys.
export const pathHash = (path) => sha256Hex(path);
export const nameHash = (name) => sha256Hex(name);
export const urlHash = (urlKey) => sha256Hex(urlKey);
