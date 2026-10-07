// Graph record codecs (arch 9.1, 9.2, 9.6). Parsers return null, never throw:
// bad JSON, a non-v1 formatVersion (a newer format is never parsed
// optimistically), a path or key that is not the one the caller asked for, or a
// body over the byte cap. Manifests, nodes
// and pages carry formatVersion too. The bucket is a trust boundary, so
// shapes are checked, not just identity.
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

/**
 * A stored record's text, or null when it is over the byte cap: a reported
 * `size` is checked before the body is read, and the text itself before any
 * parse, so an oversized object is never parsed.
 */
export async function recordText(got) {
  if (typeof got.size === "number" && got.size > GRAPH_RECORD_BYTE_CAP) return null;
  const text = await got.text();
  return typeof text === "string" && !exceedsUtf8Bytes(text, GRAPH_RECORD_BYTE_CAP) ? text : null;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isGen = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
const MODES = ["conditional", "best-effort"];
const HEALTH_STATES = ["ready", "behind", "unavailable", "partial"];
const COVERAGE = ["complete", "partial", "unsupported", "excluded"];

export function parseManifest(text) {
  const value = parseObject(text);
  if (!value || value.formatVersion !== GRAPH_FORMAT_VERSION) return null;
  const { generation, building, mode, health } = value;
  if (!isGen(generation) || !MODES.includes(mode)) return null;
  if (!isObject(health) || !HEALTH_STATES.includes(health.state)) return null;
  if (building !== null && !(isObject(building) && isGen(building.generation) && typeof building.startedAt === "string")) return null;
  return value;
}

export function parseNode(text, expectedPath) {
  const value = parseObject(text);
  if (!value || value.formatVersion !== GRAPH_FORMAT_VERSION) return null;
  if (value.path !== expectedPath) return null;
  if (!Array.isArray(value.occurrences) || !Array.isArray(value.externalReferences)) return null;
  return COVERAGE.includes(value.coverage) ? value : null;
}

export function parsePage(text, expectedKey) {
  const value = parseObject(text);
  if (!value || value.formatVersion !== GRAPH_FORMAT_VERSION || value.key !== expectedKey) return null;
  if (!Array.isArray(value.entries)) return null;
  const entryOk = (e) => isObject(e) && typeof e.source === "string" && typeof e.referenceSetVersion === "string";
  if (!value.entries.every(entryOk)) return null;
  // `next` names the next page's number as a decimal string (OPEN-3).
  if (value.next !== undefined && !isGen(value.next)) return null;
  return value;
}

export const serializeManifest = (manifest) => JSON.stringify(manifest);
export const serializeNode = (node) => JSON.stringify(node);
export const serializePage = (page) => JSON.stringify({ ...page, formatVersion: GRAPH_FORMAT_VERSION });
