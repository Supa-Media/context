/**
 * The meaning index's snapshot (`meaningIndex.js`): every passage's bits, path, passage number and tier packed into one
 * buffer, kept in a few large parts. A workspace object woken from idle used to read its index back one row a passage,
 * each with its path: 390 ms at the median and 4 s at p90 in production (`inside:meaning_warm_loaded`, 2026-11-21),
 * all of it in front of the search that woke it. The snapshot is a few reads.
 *
 * A cache of the passages table, like the in-memory index it is read into: written behind a build, marked stale by any
 * write to the passages, and never read while stale or when its count differs from the table's. Dropping it loses
 * nothing.
 */
import { TIERS, WORDS } from "./meaningShape.js";

/** The size of one snapshot part: well under a Durable Object's 2 MB a value. */
export const SNAPSHOT_PART = 1024 * 1024;

/** Bytes a passage takes after the header: its id (8), passage number (4), path number (4), tier (4) and bits. */
const PER_PASSAGE = 20 + WORDS * 4;

/**
 * Every held passage (`[[id, {path, chunk, tier, bits}]]`, in order) as one buffer: a header (the passage count and
 * each distinct path once), then each passage's id, passage number, path number and tier, then their bits.
 *
 * @param {Array<[number, {path: string, chunk: number, tier: string, bits: Uint32Array}]>} entries
 */
export function encodeSnapshot(entries) {
  const n = entries.length;
  const paths = [];
  const pathAt = new Map();
  const pathIndex = new Uint32Array(n);
  entries.forEach(([, entry], i) => {
    let at = pathAt.get(entry.path);
    if (at === undefined) pathAt.set(entry.path, (at = paths.push(entry.path) - 1));
    pathIndex[i] = at;
  });
  const header = new TextEncoder().encode(JSON.stringify({ n, words: WORDS, paths }));
  const start = 8 * Math.ceil((4 + header.length) / 8);
  const buffer = new ArrayBuffer(start + n * PER_PASSAGE);
  const bytes = new Uint8Array(buffer);
  new DataView(buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  const ids = new Float64Array(buffer, start, n);
  const chunks = new Uint32Array(buffer, start + 8 * n, n);
  new Uint32Array(buffer, start + 12 * n, n).set(pathIndex);
  const tiers = new Uint32Array(buffer, start + 16 * n, n);
  const bits = new Uint32Array(buffer, start + 20 * n, n * WORDS);
  entries.forEach(([id, entry], i) => {
    ids[i] = id;
    chunks[i] = entry.chunk;
    tiers[i] = TIERS.indexOf(entry.tier);
    bits.set(entry.bits, i * WORDS);
  });
  return bytes;
}

/**
 * `encodeSnapshot`'s buffer back as the held passages (`Map` id → entry, in order) and their packed arrays (`ids`,
 * `bits`, `tiers`, `entries`, as `meaningIndex.js` `pack` makes them), or `null` for anything that is not one whole.
 *
 * @param {Uint8Array} bytes
 */
export function decodeSnapshot(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  // Its own buffer, at offset 0, so the typed views below line up.
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const length = new DataView(buffer).getUint32(0, true);
  if (4 + length > buffer.byteLength) return null;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  } catch {
    return null;
  }
  const n = header?.n;
  if (!Number.isInteger(n) || n < 0 || header.words !== WORDS || !Array.isArray(header.paths)) return null;
  const start = 8 * Math.ceil((4 + length) / 8);
  if (buffer.byteLength !== start + n * PER_PASSAGE) return null;
  const ids = new Float64Array(buffer, start, n);
  const chunks = new Uint32Array(buffer, start + 8 * n, n);
  const pathIndex = new Uint32Array(buffer, start + 12 * n, n);
  const tierIndex = new Uint32Array(buffer, start + 16 * n, n);
  const bits = new Uint32Array(buffer, start + 20 * n, n * WORDS);
  const held = new Map();
  const entries = new Array(n);
  const tiers = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const path = header.paths[pathIndex[i]];
    const tier = TIERS[tierIndex[i]];
    if (typeof path !== "string" || tier === undefined) return null;
    const entry = { path, chunk: chunks[i], tier, bits: bits.subarray(i * WORDS, (i + 1) * WORDS) };
    held.set(ids[i], entry);
    entries[i] = entry;
    tiers[i] = tierIndex[i];
  }
  // Views on the one buffer: neither the held entries nor the packed arrays are written in place (`meaningIndex.js`).
  return { held, packed: { ids, bits, tiers, entries } };
}
