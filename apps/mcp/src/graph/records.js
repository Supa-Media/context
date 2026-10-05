// Graph record codecs (arch 9.1, 9.2, 9.6). Parsers return null, never throw:
// bad JSON, a non-v1 formatVersion (a newer format is never parsed
// optimistically), a path or key that is not the one the caller asked for, or a
// body over the byte cap. Manifests and nodes carry formatVersion; pages sit
// under the `v1/` key prefix and carry the shape `{ key, entries, next? }`.
import { exceedsUtf8Bytes } from "../search/maintain.js";

export const GRAPH_FORMAT_VERSION = 1;
export const POSTING_PAGE_SIZE = 256;
// Starting value (OPEN-7), to be measured on a managed bucket (arch 9.1).
export const GRAPH_RECORD_BYTE_CAP = 256 * 1024;

function parseObject(text) {
  if (typeof text !== "string" || exceedsUtf8Bytes(text, GRAPH_RECORD_BYTE_CAP)) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseManifest(text) {
  const value = parseObject(text);
  return value && value.formatVersion === GRAPH_FORMAT_VERSION ? value : null;
}

export function parseNode(text, expectedPath) {
  const value = parseObject(text);
  if (!value || value.formatVersion !== GRAPH_FORMAT_VERSION) return null;
  return value.path === expectedPath ? value : null;
}

export function parsePage(text, expectedKey) {
  const value = parseObject(text);
  if (!value || value.key !== expectedKey || !Array.isArray(value.entries)) return null;
  return value;
}

export const serializeManifest = (manifest) => JSON.stringify(manifest);
export const serializeNode = (node) => JSON.stringify(node);
export const serializePage = (page) => JSON.stringify(page);
