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
export type ObjectCensus = { state: CensusState; keys: number; kind?: CensusKind; shape?: string[] };

/**
 * A key's name with anything that could name a person or a chat masked: a phone, a run of 8+ hex or dashes (an id),
 * any other run of 3+ digits, any run of 16+ word characters, and anything around an `@`, each `#`; cut at 40.
 */
export function maskKey(key: string): string {
  return key
    .replace(/\S*@\S*/g, "#@#")
    .replace(/\+\d{3,}/g, "#")
    .replace(/[0-9a-f-]{8,}/gi, "#")
    .replace(/\d{3,}/g, "#")
    .replace(/[A-Za-z0-9_]{16,}/g, "#")
    .slice(0, 40);
}

/** The masked key names an object still here holds, at most this many distinct, sorted. */
const SHAPE_NAMES = 30;

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
  const shape = [...new Set(keys.map(maskKey))].sort().slice(0, SHAPE_NAMES);
  return { state: "here", keys: keys.length, kind: kindOf(keys), shape };
}

/**
 * Every `here` object comes back by id with its kind, key count and masked key names, and `named`: the index of the
 * caller's candidate name it was made from, when one was (`census`'s `nameAt`), so the caller, who holds the names,
 * can tell which chat it is without a name ever crossing back. Ids name no person.
 */
export type HereObject = { id: string; kind: CensusKind; keys: number; shape: string[]; named?: number };
export type CensusCounts = { looked: number; moved: number; purged: number; empty: number; here: Record<CensusKind, number>; hereIds: string[]; hereObjects: HereObject[]; failed: number };

const OBJECT_ID = /^[0-9a-f]{64}$/;
export const CENSUS_BATCH = 50;

/**
 * Asks each object by its id (`objectById`), at most `CENSUS_BATCH`; a malformed id or one that fails is counted failed.
 * `nameAt` answers the index of the candidate name an id was made from, if any.
 */
export async function census(ask: (id: string) => Promise<ObjectCensus | null>, ids: unknown, nameAt: (id: string) => number | undefined = () => undefined): Promise<CensusCounts> {
  if (!Array.isArray(ids) || ids.length > CENSUS_BATCH) throw new TypeError(`a census names at most ${CENSUS_BATCH} object ids`);
  const counts: CensusCounts = { looked: 0, moved: 0, purged: 0, empty: 0, here: { chat: 0, job: 0, directory: 0, "group-moves": 0 }, hereIds: [], hereObjects: [], failed: 0 };
  for (const id of ids) {
    const answer = typeof id === "string" && OBJECT_ID.test(id) ? await ask(id).catch(() => null) : null;
    if (answer === null) {
      counts.failed += 1;
      continue;
    }
    counts.looked += 1;
    if (answer.state === "here") {
      const kind = answer.kind ?? "chat";
      counts.here[kind] += 1;
      counts.hereIds.push(id as string);
      const named = nameAt(id as string);
      counts.hereObjects.push({ id: id as string, kind, keys: answer.keys, shape: answer.shape ?? [], ...(named === undefined ? {} : { named }) });
    } else counts[answer.state] += 1;
  }
  console.log(JSON.stringify({ event: "worker_census", looked: counts.looked, moved: counts.moved, purged: counts.purged, empty: counts.empty, ...counts.here, failed: counts.failed }));
  return counts;
}

/** At most this many candidate names a census call may bring, each at most `NAME_CHARS`. */
export const CENSUS_NAMES = 2000;
const NAME_CHARS = 300;

/** The candidate names' object ids, by `idOf` (the namespace's `idFromName`): an id to its name's index. */
export function namesById(names: unknown, idOf: (name: string) => string): Map<string, number> {
  const byId = new Map<string, number>();
  if (!Array.isArray(names)) return byId;
  if (names.length > CENSUS_NAMES) throw new TypeError(`a census brings at most ${CENSUS_NAMES} names`);
  names.forEach((name, index) => {
    if (typeof name === "string" && name !== "" && name.length <= NAME_CHARS) byId.set(idOf(name), index);
  });
  return byId;
}

/** A name a 1:1 object may have: a phone or an email address, as the gateway's chat names allow. */
const SELF_NAME = /^(?:\+[1-9]\d{6,14}|[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,120})$/;

/** The path an object answers its own possible names on: only `TexRoutines.census`, inside this Worker, asks it. */
export const SELF_NAMES_PATH = "/__census/self-names";

/**
 * The names a 1:1 object may have been made from, read from the chat it last answered (`inbox.ts` `CHAT_KEY`): every
 * phone in that chat's id (Sendblue's `sendblue:<line>:<phone>`, a WhatsApp jid's digits) and every part of it (an
 * iMessage sender's email address). The caller keeps only the
 * one whose object id is this object's, so a wrong guess never moves anything. A group's object keeps no name.
 */
export async function selfNames(storage: { get<T = unknown>(key: string): Promise<T | undefined> }): Promise<string[]> {
  const chat = await storage.get<{ chatId?: unknown }>("chat");
  if (typeof chat?.chatId !== "string" || chat.chatId.length > 300) return [];
  const phones = [...chat.chatId.matchAll(/\+?(\d{7,15})/g)].map((match) => `+${match[1]}`).filter((phone) => /^\+[1-9]\d{6,14}$/.test(phone));
  // An iMessage sender may be an email address rather than a phone: every part of the chat's id is tried too.
  const parts = chat.chatId.split(":").filter((part) => SELF_NAME.test(part));
  return [...new Set([...phones, ...parts])];
}

/** An object still here whose own name was worked out and checked against its id: handed to the gateway to move. */
export type Adoptable = { id: string; name: string };

/**
 * For each object still here that no candidate matched, its own possible names (`ask`), kept only when the name's
 * object id (`idOf`) is the object's own. At most `CENSUS_BATCH`.
 */
export async function adoptable(here: HereObject[], ask: (id: string) => Promise<string[]>, idOf: (name: string) => string): Promise<Adoptable[]> {
  const found: Adoptable[] = [];
  for (const object of here.slice(0, CENSUS_BATCH)) {
    if (object.named !== undefined || object.kind !== "chat") continue;
    const names = await ask(object.id).catch(() => [] as string[]);
    const name = names.find((candidate) => idOf(candidate) === object.id);
    if (name !== undefined) found.push({ id: object.id, name });
  }
  return found;
}
