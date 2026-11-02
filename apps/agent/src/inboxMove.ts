/**
 * Moving a texting inbox to an object placed in eastern North America
 * (decided by the owner, 2026-11-01: "let's pin all to us east").
 *
 * An object is placed once, near whatever first asked for it, and never
 * moves; 21 of the 60 inboxes used from 2026-10-25 to 11-02 were placed in
 * Europe (Cloudflare analytics), while the gateway every turn calls runs in
 * Virginia. So every inbox now lives under `enam:<name>` (`inboxByName`), made
 * with the hint, and the inbox under the old name hands over to it once.
 *
 * An inbox's work is long (a turn waits on the gateway for seconds), so it is
 * moved only while the old one is idle, and nothing ever waits on a move:
 *
 * 1. A call to the new inbox that has not arrived asks the old one to move out
 *    (`/__move_out`). The old one refuses while any of its calls, its alarm or
 *    work it handed to `waitUntil` is still running. Refused, or failed, and
 *    the new inbox passes the call to the old one, which answers it as it
 *    always has; it asks again a few minutes later.
 * 2. Idle, the old inbox marks itself moved and answers everything it keeps,
 *    and its alarm, in one answer. While storage calls run, the runtime lets
 *    no other call in, so nothing changes between the mark and the copy.
 *    From then on it passes every call on to the new inbox.
 * 3. The new inbox writes it all, then reads it back and compares a digest
 *    of every key and value with the one the old inbox computed. Any difference, or a value this copy
 *    cannot carry, and the copy is thrown away and the old inbox is told to
 *    take its calls again (`/__move_back`), alarm restored.
 * 4. The old copy is kept for three days, then cleared by its own alarm.
 *
 * Links and workflows that name the old inbox by its id reach the old object,
 * which passes them on.
 */

/** The prefix of every placed inbox's name. */
export const PLACED_PREFIX = "enam:";
/** The header naming the inbox (its old name) on every call to a placed one. */
export const INBOX_NAME_HEADER = "x-inbox-name";
/** How long the old copy is kept after a move. */
export const KEEP_OLD_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a refused or failed move waits before it is tried again. */
export const RETRY_MOVE_MS = 2 * 60 * 1000;
/** Where this inbox stands (`Place`); never copied. */
export const PLACE_KEY = "__inbox_place";

const MOVE_OUT = "/__move_out";
const MOVE_BACK = "/__move_back";

export interface Place {
  movedTo?: string;
  name?: string;
  movedAt?: number;
  purgeAt?: number;
  alarmWas?: number | null;
  purgedAt?: number;
  arrivedAt?: number;
  keys?: number;
  failedAt?: number;
}

/** The storage calls a move uses: the Durable Object's own. */
export interface MoveStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The stub for the inbox object under exactly `name` (`objectPlace.ts` `objectByName`). */
export type InboxStubs = (name: string) => { fetch(request: Request): Promise<Response> };

const OLD_NAME = /^[^\0]{1,512}$/;

/** The name an inbox now lives under. */
export function placedName(name: string): string {
  return `${PLACED_PREFIX}${name}`;
}

/** A value as the copy carries it: JSON, with bytes tagged. Throws on anything else, so a value is never carried changed. */
export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("a number JSON cannot carry");
    return value;
  }
  if (value instanceof Uint8Array) return { __bytes: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map((item) => encodeValue(item));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__bytes") throw new TypeError("a key the copy reserves");
      if (item === undefined) continue;
      out[key] = encodeValue(item);
    }
    return out;
  }
  throw new TypeError("a value the copy cannot carry");
}

/** The value back from its carried form. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decodeValue(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.__bytes === "string" && Object.keys(record).length === 1) return base64ToBytes(record.__bytes);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = decodeValue(item);
    return out;
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Everything an inbox keeps but its place, in its carried form, by key. */
async function dumpOf(storage: MoveStorage): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of await storage.list()) {
    if (key === PLACE_KEY) continue;
    out[key] = encodeValue(value);
  }
  return out;
}

/** Each key's carried value, as one digest: what the old inbox held, compared with what the new one reads back. */
async function fingerprint(dump: Record<string, unknown>): Promise<string> {
  const text = JSON.stringify(Object.keys(dump).sort().map((key) => [key, dump[key]]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The old inbox's side. Answers a move call, or null for an ordinary call.
 * `busy` is how many of its calls, alarms and handed-on work are running,
 * this one not counted.
 */
export async function serveMoveOut(request: Request, storage: MoveStorage, busy: number, now: number): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== MOVE_OUT && path !== MOVE_BACK) return null;
  // A placed inbox never moves out, and only another inbox, never the Worker's stub, asks.
  if (request.headers.get(INBOX_NAME_HEADER) !== null) return new Response(null, { status: 400 });
  const place = ((await storage.get<Place>(PLACE_KEY)) ?? {}) as Place;
  if (place.arrivedAt !== undefined) return new Response(null, { status: 400 });
  if (path === MOVE_BACK) {
    if (place.movedTo !== undefined && place.purgedAt === undefined) await moveBack(storage, place);
    return Response.json({ ok: true });
  }
  const { name } = (await request.json()) as { name?: unknown };
  if (typeof name !== "string" || !OLD_NAME.test(name)) return new Response(null, { status: 400 });
  if (place.movedTo === undefined) {
    if (busy > 0) return Response.json({ busy: true }, { status: 409 });
    // Every value checked before anything is marked: one the copy cannot carry leaves this inbox as it was.
    try {
      await dumpOf(storage);
    } catch {
      return Response.json({ error: "uncarried" }, { status: 422 });
    }
    const alarmWas = await storage.getAlarm();
    await storage.put(PLACE_KEY, { movedTo: placedName(name), name, movedAt: now, purgeAt: now + KEEP_OLD_MS, alarmWas } satisfies Place);
    await storage.setAlarm(now + KEEP_OLD_MS);
  }
  if (place.purgedAt !== undefined) return Response.json({ error: "purged" }, { status: 409 });
  const kept = ((await storage.get<Place>(PLACE_KEY)) ?? {}) as Place;
  const entries = await dumpOf(storage);
  return Response.json({ entries, digest: await fingerprint(entries), alarm: kept.alarmWas ?? null });
}

/** An inbox marked moved takes its calls again, its alarm as it was. */
async function moveBack(storage: MoveStorage, place: Place): Promise<void> {
  await storage.delete(PLACE_KEY);
  if (typeof place.alarmWas === "number") await storage.setAlarm(place.alarmWas);
  else await storage.deleteAlarm();
}

/** An ordinary call to an inbox that has moved, passed on with its bytes. */
export async function forward(stubs: InboxStubs, place: Place, request: Request, body: ArrayBuffer | null): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(INBOX_NAME_HEADER, place.name!);
  return await stubs(place.movedTo!).fetch(new Request(request.url, { method: request.method, headers, body }));
}

/** Marks a call the placed inbox handed back to the old one, because it holds nothing yet. */
export const VIA_NEW_HEADER = "x-inbox-via-new";

/** A call to a placed inbox that has not arrived, answered by the old one. */
export async function viaOld(stubs: InboxStubs, name: string, request: Request, body: ArrayBuffer | null): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete(INBOX_NAME_HEADER);
  headers.set(VIA_NEW_HEADER, "1");
  return await stubs(name).fetch(new Request(request.url, { method: request.method, headers, body }));
}

export type MoveOutcome =
  | { outcome: "arrived"; keys: number; ms: number }
  | { outcome: "busy" | "failed" | "waiting"; ms: number; reason?: string };

/**
 * The new inbox's side: copy the old inbox in, check it, mark this one
 * arrived. Never throws; anything but `arrived` leaves this inbox empty and
 * the old one answering. Run inside `blockConcurrencyWhile`.
 */
export async function arrive(stubs: InboxStubs, storage: MoveStorage, name: string, now: () => number): Promise<MoveOutcome> {
  const started = now();
  const place = ((await storage.get<Place>(PLACE_KEY)) ?? {}) as Place;
  if (place.arrivedAt !== undefined) return { outcome: "arrived", keys: place.keys ?? 0, ms: 0 };
  if (place.failedAt !== undefined && started - place.failedAt < RETRY_MOVE_MS) return { outcome: "waiting", ms: 0 };
  const old = stubs(name);
  const failed = async (outcome: "busy" | "failed", reason: string, tellOld: boolean): Promise<MoveOutcome> => {
    await storage.deleteAll();
    await storage.put(PLACE_KEY, { failedAt: now() } satisfies Place);
    if (tellOld) {
      try {
        await old.fetch(new Request(`https://inbox${MOVE_BACK}`, { method: "POST" }));
      } catch {
        // The old inbox stays marked moved and passes calls here, and the next call copies again.
      }
    }
    return { outcome, ms: now() - started, reason };
  };
  let answer: Response;
  try {
    answer = await old.fetch(new Request(`https://inbox${MOVE_OUT}`, { method: "POST", body: JSON.stringify({ name }) }));
  } catch {
    return await failed("failed", "old_unreachable", true);
  }
  if (answer.status === 409) return await failed("busy", "old_busy", false);
  if (!answer.ok) return await failed("failed", `old_${answer.status}`, true);
  try {
    const { entries, digest, alarm } = (await answer.json()) as { entries: Record<string, unknown>; digest: string; alarm: number | null };
    await storage.deleteAll();
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 128) {
      const batch: Record<string, unknown> = {};
      for (const key of keys.slice(i, i + 128)) batch[key] = decodeValue(entries[key]);
      await storage.put(batch);
    }
    // Read back and compared with the old inbox's own digest: a value garbled on the way, or not kept as sent, fails the move.
    if ((await fingerprint(await dumpOf(storage))) !== digest) return await failed("failed", "parity", true);
    if (typeof alarm === "number") await storage.setAlarm(alarm);
    await storage.put(PLACE_KEY, { arrivedAt: now(), keys: keys.length } satisfies Place);
    return { outcome: "arrived", keys: keys.length, ms: now() - started };
  } catch {
    return await failed("failed", "copy", true);
  }
}

/** The old inbox's alarm once moved: clear its copy when the three days are up. True when it handled the alarm. */
export async function movedAlarm(storage: MoveStorage, now: number): Promise<boolean> {
  const place = (await storage.get<Place>(PLACE_KEY)) as Place | undefined;
  if (place?.movedTo === undefined) return false;
  if (now >= (place.purgeAt ?? 0)) {
    if (place.purgedAt === undefined) {
      await storage.deleteAll();
      await storage.put(PLACE_KEY, { ...place, purgedAt: now } satisfies Place);
    }
    await storage.deleteAlarm();
  } else await storage.setAlarm(place.purgeAt!);
  return true;
}

/** One line per move attempt: counts and times, never a key or a value. */
export function logMove(outcome: MoveOutcome): void {
  console.log(JSON.stringify({ event: "inbox_move", ...outcome }));
}

/**
 * Every call to an inbox goes through here first: a move call answered, a
 * moved inbox's call passed on, a placed inbox that has not arrived copying
 * in (or, failing that, handing the call to the old one). Otherwise the call,
 * with its bytes, for the inbox to answer.
 */
export async function placeGate(
  request: Request,
  storage: MoveStorage,
  stubs: InboxStubs,
  busy: number,
  blockConcurrencyWhile: <T>(run: () => Promise<T>) => Promise<T>,
  now: () => number = Date.now,
): Promise<{ response: Response } | { request: Request }> {
  const move = await serveMoveOut(request, storage, busy, now());
  if (move !== null) return { response: move };
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const place = ((await storage.get<Place>(PLACE_KEY)) ?? {}) as Place;
  if (place.movedTo !== undefined && place.purgedAt === undefined && request.headers.get(VIA_NEW_HEADER) !== null) {
    // The placed inbox handed this back: it holds nothing, so a move that marked this one never finished. Take the calls again.
    await moveBack(storage, place);
  } else if (place.movedTo !== undefined) return { response: await forward(stubs, place, request, body) };
  const name = request.headers.get(INBOX_NAME_HEADER);
  if (name !== null && OLD_NAME.test(name) && place.arrivedAt === undefined) {
    const moved = await blockConcurrencyWhile(() => arrive(stubs, storage, name, now));
    if (moved.outcome !== "waiting") logMove(moved);
    if (moved.outcome !== "arrived") return { response: await viaOld(stubs, name, request, body) };
  }
  return { request: new Request(request.url, { method: request.method, headers: request.headers, body }) };
}
