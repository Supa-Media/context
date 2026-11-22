/**
 * What one of this Worker's SenderInbox objects still holds, counted without reading a value (part C of the runtime
 * simplification, Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX; Dev2 chose "sweep, then delete"
 * 2026-11-22). Before the SenderInbox class is deleted, every object it has is asked this by its id
 * (`TexRoutines.census`, from the Lab's staff `intake` op), so the deletion goes ahead only once none holds a chat,
 * a job, a directory entry or the group-moves table that the gateway does not.
 *
 * An object answers its state: `moved` (it passes calls on; its copy is kept until `purgeAt`), `purged` (moved and
 * its copy cleared), `empty`, or `here` (it holds data and was never moved), with `kind` for a `here` one read from
 * its keys' names alone, and how many keys it holds (up to 1,000; a moved one's are not read). Never a key, a value or a name.
 */

import { PLACE_KEY, type Place } from "./inboxMove";

export const CENSUS_PATH = "/__census";
/** Keys counted at most for an object still here: enough to tell its kind, never its whole history loaded. */
const CENSUS_KEYS = 1000;

export type CensusState = "moved" | "purged" | "empty" | "here";
export type CensusKind = "chat" | "job" | "directory" | "group-moves";
export type ObjectCensus = { state: CensusState; keys: number; kind?: CensusKind };

type ListStorage = { get<T = unknown>(key: string): Promise<T | undefined>; list(options?: { limit?: number }): Promise<Map<string, unknown>> };

/** The keys a kind of object keeps, by name only: a job's run, a group's directory entry, the group-moves table. */
function kindOf(keys: string[]): CensusKind {
  if (keys.includes("jobrun")) return "job";
  if (keys.includes("chatwhere") && keys.length <= 2) return "directory";
  if (keys.some((key) => key.startsWith("gm:") || key.startsWith("gmove:"))) return "group-moves";
  return "chat";
}

export async function censusOf(storage: ListStorage): Promise<ObjectCensus> {
  const place = await storage.get<Place>(PLACE_KEY);
  // A moved object's keys are not read: its copy is kept only until `purgeAt`, and listing a chat loads its values.
  if (place?.movedTo !== undefined) return { state: place.purgedAt === undefined ? "moved" : "purged", keys: 0 };
  const keys = [...(await storage.list({ limit: CENSUS_KEYS })).keys()].filter((key) => key !== PLACE_KEY);
  if (keys.length === 0) return { state: "empty", keys: 0 };
  return { state: "here", keys: keys.length, kind: kindOf(keys) };
}

/** Every `here` object's id comes back, so it can be looked at; ids name no person. */
export type CensusCounts = { looked: number; moved: number; purged: number; empty: number; here: Record<CensusKind, number>; hereIds: string[]; failed: number };

const OBJECT_ID = /^[0-9a-f]{64}$/;
export const CENSUS_BATCH = 50;

/** Asks each object by its id (`objectById`), at most `CENSUS_BATCH`; a malformed id or one that fails is counted failed. */
export async function census(ask: (id: string) => Promise<ObjectCensus | null>, ids: unknown): Promise<CensusCounts> {
  if (!Array.isArray(ids) || ids.length > CENSUS_BATCH) throw new TypeError(`a census names at most ${CENSUS_BATCH} object ids`);
  const counts: CensusCounts = { looked: 0, moved: 0, purged: 0, empty: 0, here: { chat: 0, job: 0, directory: 0, "group-moves": 0 }, hereIds: [], failed: 0 };
  for (const id of ids) {
    const answer = typeof id === "string" && OBJECT_ID.test(id) ? await ask(id).catch(() => null) : null;
    if (answer === null) {
      counts.failed += 1;
      continue;
    }
    counts.looked += 1;
    if (answer.state === "here") {
      counts.here[answer.kind ?? "chat"] += 1;
      counts.hereIds.push(id as string);
    } else counts[answer.state] += 1;
  }
  console.log(JSON.stringify({ event: "worker_census", looked: counts.looked, moved: counts.moved, purged: counts.purged, empty: counts.empty, ...counts.here, failed: counts.failed }));
  return counts;
}
