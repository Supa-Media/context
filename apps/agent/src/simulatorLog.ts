/**
 * The texts simulator's log, claim and phone rules, shared by a 1:1 chat's
 * object (`simulator.ts`) and a simulated group's object (`simulatorGroup.ts`).
 * Everything here is kept in the Durable Object that the chat lives in, so a
 * simulated bubble is never written anywhere a real chat's words are.
 */

import type { InboxStorage } from "./inbox";

/** +1, a real area code, then 555-01XX: the numbers set aside for fiction. */
export const SIMULATED_PHONE = /^\+1[2-9]\d{2}55501\d{2}$/;

/** The log keeps the newest entries for a day, and never more than this many. */
export const SIM_LOG_LIMIT = 100;
export const SIM_LOG_FOR_MS = 24 * 60 * 60 * 1000;

const KEY_HASH = "sim:key";
const LOG_SEQ = "sim:seq";
const logKey = (seq: number) => `sim:log:${String(seq).padStart(12, "0")}`;

/**
 * One bubble. `dir` is the side it is drawn on: "out" is what a browser's
 * sender wrote, "in" is what Tex wrote back. A group's bubble also names its
 * sender (`from`), and a Tex bubble its `handle`, which a later read of a reply
 * to it finds.
 */
export type SimEntry = { id: number; dir: "in" | "out"; text: string; at: number; from?: string; handle?: string };

/**
 * The first key presented for a chat claims it; afterwards only that key opens
 * it. Clearing the chat keeps the claim, so a cleared chat cannot be picked up
 * by another browser.
 */
export async function claim(storage: InboxStorage, keyHash: string): Promise<boolean> {
  const held = await storage.get<string>(KEY_HASH);
  if (held === undefined) {
    await storage.put(KEY_HASH, keyHash);
    return true;
  }
  return held === keyHash;
}

/** Append one bubble to the log, then trim it by age and count. Returns the bubble as written. */
export async function record(
  storage: InboxStorage,
  dir: SimEntry["dir"],
  text: string,
  now: number,
  extra: Partial<Pick<SimEntry, "from" | "handle">> = {},
): Promise<SimEntry> {
  const seq = ((await storage.get<number>(LOG_SEQ)) ?? 0) + 1;
  await storage.put(LOG_SEQ, seq);
  const entry: SimEntry = { id: seq, dir, text, at: now, ...extra };
  await storage.put<SimEntry>(logKey(seq), entry);
  const entries = [...(await storage.list<SimEntry>({ prefix: "sim:log:" }))];
  const excess = entries.length - SIM_LOG_LIMIT;
  for (const [index, [key, old]] of entries.entries()) {
    if (index < excess || now - old.at > SIM_LOG_FOR_MS) await storage.delete(key);
  }
  return entry;
}

/** What the page draws: the log, and whether an answer is still being worked on (`pendingPrefix` is that chat's queue). */
export async function thread(storage: InboxStorage, now: number, pendingPrefix = "pending:"): Promise<{ messages: SimEntry[]; typing: boolean }> {
  const entries = [...(await storage.list<SimEntry>({ prefix: "sim:log:" })).values()];
  const pending = await storage.list<unknown>({ prefix: pendingPrefix });
  return {
    messages: entries.filter((entry) => now - entry.at <= SIM_LOG_FOR_MS),
    typing: pending.size > 0,
  };
}

export async function clear(storage: InboxStorage): Promise<void> {
  for (const key of (await storage.list<SimEntry>({ prefix: "sim:log:" })).keys()) await storage.delete(key);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
