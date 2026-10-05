// Pure forward-record builder (arch 7.1, 9.2). No store access: body in, node
// record and reverse membership set out. Memberships are `postingRef` strings
// `"<family>:<hash>"`, deduplicated by the Set; occurrences keep every span.
import { isEncryptedNote } from "../encryption.js";
import { extractReferences, resolveLink } from "../links.js";
import { sha256Hex } from "../ingestion/inbox.js";
import { GRAPH_FORMAT_VERSION, GRAPH_RECORD_BYTE_CAP, serializeNode } from "./records.js";
import { exceedsUtf8Bytes } from "../search/maintain.js";
import { nameHash, pathHash, urlHash } from "./keys.js";
import { URL_KEY_VERSION, urlKey } from "./urlKey.js";

export const PARSER_VERSION = 1;
export const RESOLVER_VERSION = 1;

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/**
 * Ask `resolveLink` for both answers at once: the path it computes for a
 * relative or rooted target, and the name it would look up for a bare one.
 * Reusing it keeps the basename and decoding rules identical to Phase 1.
 */
function classify(occurrence, fromPath) {
  let name = null;
  const spy = { get(n) { name = n; return undefined; } };
  const path = resolveLink(occurrence, fromPath, spy);
  return { path, name };
}

async function membershipsFor(path, occurrences) {
  const out = new Set([`names:${await nameHash(baseName(path))}`]);
  const externalReferences = [];
  for (const o of occurrences) {
    if (o.kind === "definition") continue; // unsupported (arch 7.1)
    if (o.style === null) {
      const k = urlKey(o.target);
      if (k) {
        out.add(`urls:${await urlHash(k.key)}`);
        externalReferences.push({ key: k.key, version: k.version, start: o.start, end: o.end });
      }
      continue;
    }
    const { path: target, name } = classify(o, path);
    if (o.style === "bare") {
      if (name) out.add(`bare:${await nameHash(name)}`);
    } else if (target !== null && target.endsWith(".md")) {
      out.add(`incoming:${await pathHash(target)}`); // OPEN-5: .md targets only
    }
  }
  return { memberships: out, externalReferences };
}

async function referenceSetVersion(memberships) {
  const head = `${PARSER_VERSION}\n${RESOLVER_VERSION}\n${URL_KEY_VERSION}\n`;
  return sha256Hex(head + [...memberships].sort().join("\n"));
}

/** Largest document-order prefix of occurrences whose record fits the cap (OPEN-7). */
function fitToCap(record) {
  const fits = (k) => {
    const cut = k < record.occurrences.length ? record.occurrences[k].start : Infinity;
    return !exceedsUtf8Bytes(serializeNode({
      ...record,
      occurrences: record.occurrences.slice(0, k),
      externalReferences: record.externalReferences.filter((e) => e.start < cut),
    }), GRAPH_RECORD_BYTE_CAP);
  };
  if (fits(record.occurrences.length)) return record;
  let lo = 0;
  let hi = record.occurrences.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const cut = record.occurrences[lo].start;
  return {
    ...record,
    coverage: "partial",
    occurrences: record.occurrences.slice(0, lo),
    externalReferences: record.externalReferences.filter((e) => e.start < cut),
  };
}

/**
 * `{ record, memberships }` for one note. An encrypted body (OPEN-18) yields
 * `excluded`, nothing else, and no memberships, not even `names/`.
 */
export async function buildNodeRecord(path, body, version, { now }) {
  const encrypted = isEncryptedNote(body);
  const occurrences = encrypted ? [] : extractReferences(body);
  const { memberships, externalReferences } = encrypted
    ? { memberships: new Set(), externalReferences: [] }
    : await membershipsFor(path, occurrences);
  const record = fitToCap({
    formatVersion: GRAPH_FORMAT_VERSION,
    path,
    observedSourceVersion: version,
    observedAt: now,
    parserVersion: PARSER_VERSION,
    resolverVersion: RESOLVER_VERSION,
    urlKeyVersion: URL_KEY_VERSION,
    referenceSetVersion: await referenceSetVersion(memberships),
    occurrences,
    externalReferences,
    coverage: encrypted ? "excluded" : "complete",
    reverseRepair: [],
  });
  return { record, memberships };
}
