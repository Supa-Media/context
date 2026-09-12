/**
 * Persisted per-account Google Chat contributions.
 *
 * Shared daily notes may only be rendered after every active account's slice
 * is present. These objects live in the customer's bucket under `.context/`;
 * message content never enters Convex. A manifest is committed after its day
 * objects, so an interrupted pass leaves at worst an unreferenced day object,
 * never a manifest pointing at bytes that were not stored.
 */

import { fnv1a64 } from "../../../../../packages/communications/src/anchors.js";

const ROOT = ".context/communications/google-chat/contributions";
const VERSION = 1;
const MAX_SOURCES = 50;
const MAX_DAYS_PER_SOURCE = 366;
const MAX_DAY_BYTES = 8_000_000;

export class ChatContributionIncompleteError extends Error {
  constructor() {
    super("An active Google Chat account has not stored a complete contribution yet");
    this.name = "ChatContributionIncompleteError";
    this.code = "CHAT_CONTRIBUTION_INCOMPLETE";
  }
}

export class ChatContributionConflictError extends Error {
  constructor() {
    super("A Google Chat contribution changed during this pass");
    this.name = "ChatContributionConflictError";
    this.code = "CHAT_CONTRIBUTION_CONFLICT";
  }
}

function sourceKey(sourceId) {
  const id = String(sourceId ?? "");
  if (!id || id.length > 256) throw new TypeError("Chat contribution requires a bounded source id");
  return fnv1a64(id);
}

function dateKey(value) {
  const date = String(value ?? "");
  const instant = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(instant) ||
    new Date(instant).toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError("Chat contribution day requires a calendar date");
  }
  return date;
}

function paths(sourceId) {
  const base = `${ROOT}/${sourceKey(sourceId)}`;
  return { manifest: `${base}/manifest.json`, day: (date) => `${base}/${dateKey(date)}.json` };
}

async function readJson(store, path) {
  const object = await store.get(path);
  if (object === null) return null;
  try {
    return { etag: object.etag, value: JSON.parse(await object.text()) };
  } catch {
    throw new ChatContributionIncompleteError();
  }
}

async function conditionalPut(store, path, body, etag) {
  const result = await store.put(path, body, {
    onlyIf: etag === undefined ? { absent: true } : { etagMatches: etag },
  });
  if (result === null) throw new ChatContributionConflictError();
}

function manifestValue(sourceId, contribution, dates) {
  const account = String(contribution?.account ?? "").trim();
  if (!account) throw new TypeError("Chat contribution requires an account");
  return {
    version: VERSION,
    sourceId: String(sourceId),
    account,
    destinationFolder: contribution?.destinationFolder,
    dates: [...dates].sort(),
  };
}

/** Store the days from one completed provider pass without dropping older days. */
export async function persistChatContribution({ store, sourceId, contribution }) {
  if (store?.capabilities?.conditionalWrite === false) {
    throw new TypeError("Shared Google Chat sync requires storage with conditional writes");
  }
  const location = paths(sourceId);
  const existing = await readJson(store, location.manifest);
  if (existing !== null && existing.value?.sourceId !== String(sourceId)) {
    // Includes the vanishingly unlikely hash collision. Never read or replace
    // another connection's contribution merely because its key collided.
    throw new ChatContributionConflictError();
  }
  const account = String(contribution?.account ?? "").trim();
  if (
    existing !== null &&
    (typeof existing.value?.account !== "string" ||
      existing.value.account.trim().toLowerCase() !== account.toLowerCase())
  ) {
    throw new ChatContributionConflictError();
  }
  const dates = new Set(Array.isArray(existing?.value?.dates) ? existing.value.dates.map(dateKey) : []);
  const seen = new Set();
  for (const day of contribution?.days ?? []) {
    const date = dateKey(day?.date);
    if (seen.has(date)) throw new TypeError(`duplicate Chat contribution day: ${date}`);
    seen.add(date);
    const encoded = JSON.stringify({ version: VERSION, sourceId: String(sourceId), date, day });
    if (new TextEncoder().encode(encoded).byteLength > MAX_DAY_BYTES) {
      throw new TypeError("Chat contribution day is too large to persist safely");
    }
    const prior = await readJson(store, location.day(date));
    if (prior !== null && prior.value?.sourceId !== String(sourceId)) {
      throw new ChatContributionConflictError();
    }
    await conditionalPut(store, location.day(date), encoded, prior?.etag);
    dates.add(date);
  }
  const orderedDates = [...dates].sort();
  const droppedDates = orderedDates.slice(0, Math.max(0, orderedDates.length - MAX_DAYS_PER_SOURCE));
  const keptDates = orderedDates.slice(-MAX_DAYS_PER_SOURCE);
  const manifest = manifestValue(sourceId, contribution, keptDates);
  await conditionalPut(store, location.manifest, JSON.stringify(manifest), existing?.etag);
  for (const date of droppedDates) await store.delete(location.day(date));
  return manifest;
}

/**
 * Read every active account slice, or fail closed before a shared note is
 * rendered. Omitting one active account here would let the last writer erase
 * that account's messages from the customer-visible daily note.
 */
export async function loadActiveChatContributions({ store, sourceIds }) {
  const ids = [...(sourceIds ?? [])].map((sourceId) => {
    sourceKey(sourceId);
    return String(sourceId);
  });
  if (ids.length === 0 || ids.length > MAX_SOURCES || new Set(ids).size !== ids.length) {
    throw new TypeError("Active Chat contribution sources must be unique and bounded");
  }
  const contributions = [];
  for (const sourceId of ids) {
    const location = paths(sourceId);
    const storedManifest = await readJson(store, location.manifest);
    const manifest = storedManifest?.value;
    if (
      manifest?.version !== VERSION ||
      manifest?.sourceId !== sourceId ||
      typeof manifest.account !== "string" ||
      !manifest.account.trim() ||
      !Array.isArray(manifest.dates) ||
      manifest.dates.length > MAX_DAYS_PER_SOURCE ||
      new Set(manifest.dates).size !== manifest.dates.length
    ) {
      throw new ChatContributionIncompleteError();
    }
    const days = [];
    for (const rawDate of manifest.dates) {
      const date = dateKey(rawDate);
      const storedDay = await readJson(store, location.day(date));
      if (
        storedDay?.value?.version !== VERSION ||
        storedDay.value.sourceId !== sourceId ||
        storedDay.value.date !== date ||
        storedDay.value.day?.date !== date
      ) {
        throw new ChatContributionIncompleteError();
      }
      days.push(storedDay.value.day);
    }
    contributions.push({
      account: manifest.account,
      destinationFolder: manifest.destinationFolder,
      days,
    });
  }
  return contributions;
}
