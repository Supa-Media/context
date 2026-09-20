/**
 * Atomic, per-account Calendar cache contributions in customer storage.
 *
 * A shared calendar day may only be rendered after every active account's
 * cache is present. The provider events stay in the customer's bucket under
 * hidden `.context/` plumbing; Convex needs only source ids and cursors.
 */

import { fnv1a64 } from "../../../../packages/communications/src/anchors.js";

const ROOT = ".context/communications/calendar/contributions";
const VERSION = 1;
const MAX_SOURCES = 50;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_CACHE_BYTES = 8_000_000;

export class CalendarContributionIncompleteError extends Error {
  constructor() {
    super("An active Calendar account has not stored a complete contribution yet");
    this.name = "CalendarContributionIncompleteError";
    this.code = "CALENDAR_CONTRIBUTION_INCOMPLETE";
  }
}

export class CalendarContributionConflictError extends Error {
  constructor() {
    super("A Calendar contribution changed during this pass");
    this.name = "CalendarContributionConflictError";
    this.code = "CALENDAR_CONTRIBUTION_CONFLICT";
  }
}

function sourceIdOf(value) {
  const sourceId = String(value ?? "");
  if (!sourceId || sourceId.length > 256) {
    throw new TypeError("Calendar contribution requires a bounded source id");
  }
  return sourceId;
}

function pathFor(sourceId) {
  return `${ROOT}/${fnv1a64(sourceIdOf(sourceId))}.json`;
}

function dateKey(value) {
  const date = String(value ?? "");
  const instant = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(instant) ||
    new Date(instant).toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError("Calendar contribution cache requires calendar dates");
  }
  return date;
}

function serializedEntries(eventCache) {
  if (!(eventCache instanceof Map) || eventCache.size > MAX_CACHE_ENTRIES) {
    throw new TypeError("Calendar contribution requires a bounded event cache");
  }
  const entries = [];
  for (const [rawKey, rawEntry] of eventCache) {
    const key = String(rawKey ?? "");
    if (
      !key ||
      key.length > 512 ||
      !rawEntry ||
      typeof rawEntry !== "object" ||
      !rawEntry.event ||
      typeof rawEntry.event !== "object"
    ) {
      throw new TypeError("Calendar contribution contains an invalid cache entry");
    }
    const dates = (rawEntry.dates ?? []).map(dateKey);
    if (!Array.isArray(rawEntry.dates) || new Set(dates).size !== dates.length) {
      throw new TypeError("Calendar contribution contains invalid cache dates");
    }
    entries.push([key, { event: rawEntry.event, dates }]);
  }
  return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function envelopeFor(sourceId, contribution) {
  const account = String(contribution?.account ?? "").trim();
  const timezone = String(contribution?.timezone ?? "").trim();
  if (!account || !timezone) {
    throw new TypeError("Calendar contribution requires an account and timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError("Calendar contribution requires an IANA timezone");
  }
  return {
    version: VERSION,
    sourceId: sourceIdOf(sourceId),
    account,
    timezone,
    destinationFolder: contribution?.destinationFolder,
    entries: serializedEntries(contribution?.eventCache),
  };
}

async function readEnvelope(store, path) {
  const object = await store.get(path);
  if (object === null) return null;
  try {
    return { etag: object.etag, value: JSON.parse(await object.text()) };
  } catch {
    throw new CalendarContributionIncompleteError();
  }
}

/** Atomically replace one completed provider pass's materialized cache. */
export async function persistCalendarContribution({ store, sourceId, contribution }) {
  if (store?.capabilities?.conditionalWrite === false) {
    throw new TypeError("Shared Calendar sync requires storage with conditional writes");
  }
  const source = sourceIdOf(sourceId);
  const path = pathFor(source);
  const existing = await readEnvelope(store, path);
  if (existing !== null) {
    const priorAccount = existing.value?.account;
    if (
      existing.value?.sourceId !== source ||
      typeof priorAccount !== "string" ||
      priorAccount.trim().toLowerCase() !== String(contribution?.account ?? "").trim().toLowerCase()
    ) {
      throw new CalendarContributionConflictError();
    }
  }
  const envelope = envelopeFor(source, contribution);
  const encoded = JSON.stringify(envelope);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CACHE_BYTES) {
    throw new TypeError("Calendar contribution cache is too large to persist safely");
  }
  const result = await store.put(path, encoded, {
    onlyIf: existing === null ? { absent: true } : { etagMatches: existing.etag },
  });
  if (result === null) throw new CalendarContributionConflictError();
  return envelope;
}

function contributionFromEnvelope(value, sourceId) {
  if (
    value?.version !== VERSION ||
    value?.sourceId !== sourceId ||
    typeof value.account !== "string" ||
    !value.account.trim() ||
    typeof value.timezone !== "string" ||
    !value.timezone.trim() ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_CACHE_ENTRIES
  ) {
    throw new CalendarContributionIncompleteError();
  }
  const eventCache = new Map();
  for (const item of value.entries) {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new CalendarContributionIncompleteError();
    }
    const [key, entry] = item;
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 512 ||
      eventCache.has(key) ||
      !entry ||
      typeof entry !== "object" ||
      !entry.event ||
      typeof entry.event !== "object" ||
      !Array.isArray(entry.dates)
    ) {
      throw new CalendarContributionIncompleteError();
    }
    let dates;
    try {
      dates = entry.dates.map(dateKey);
    } catch {
      throw new CalendarContributionIncompleteError();
    }
    if (new Set(dates).size !== dates.length) {
      throw new CalendarContributionIncompleteError();
    }
    eventCache.set(key, { event: entry.event, dates });
  }
  return {
    sourceId,
    account: value.account,
    timezone: value.timezone,
    destinationFolder: value.destinationFolder,
    eventCache,
  };
}

/** Load one source for its next provider pass. Missing means first sync. */
export async function loadCalendarContribution({ store, sourceId }) {
  const source = sourceIdOf(sourceId);
  const stored = await readEnvelope(store, pathFor(source));
  return stored === null ? null : contributionFromEnvelope(stored.value, source);
}

/** Load every active account cache, or fail before any shared day is rendered. */
export async function loadActiveCalendarContributions({ store, sourceIds }) {
  const ids = [...(sourceIds ?? [])].map(sourceIdOf);
  if (ids.length === 0 || ids.length > MAX_SOURCES || new Set(ids).size !== ids.length) {
    throw new TypeError("Active Calendar contribution sources must be unique and bounded");
  }
  const contributions = [];
  for (const sourceId of ids) {
    const contribution = await loadCalendarContribution({ store, sourceId });
    if (contribution === null) throw new CalendarContributionIncompleteError();
    contributions.push(contribution);
  }
  return contributions;
}
