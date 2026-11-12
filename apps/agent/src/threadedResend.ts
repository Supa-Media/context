/**
 * A threaded text Sendblue takes and then fails to deliver goes again plain,
 * once (Dev2, 2026-11-12). Three texts answering a 👍 in the Nov Babies group
 * were threaded under the tapback itself: Sendblue answered each send with a
 * 2xx and then reported ERROR (class 5000) on its status callback, and none
 * reached the chat. A threaded send refused at once already goes again plain
 * (`sendblueGroups.ts` `sendGroupText`); this is the same for a refusal that
 * only arrives on the status callback (`sendblueStatus.ts`).
 *
 * What is kept: each threaded text's handle, its words and where it went, for
 * `KEEP_MS` and at most `MAX_KEPT` of them. Words are customer text held in
 * the chat's own object, as its event outbox already holds them for a day
 * (`events.ts`), and for far less time here. A resend is itself plain, so it
 * is never kept: a plain send that fails is marked as not delivered.
 */

import type { InboxStorage } from "./inbox";

export const THREADED_KEY = "sbthreaded";
/** Sendblue's status for a send has come within a minute in every receipt seen; this is ample. */
export const KEEP_MS = 30 * 60_000;
export const MAX_KEPT = 30;

export type ThreadedPlace = { kind: "group"; line: string; groupId: string } | { kind: "person"; chatId: string };
export type Threaded = { h: string; text: string; place: ThreadedPlace; at: number };

/** Keep a threaded text that went, by its handle. A send with no handle cannot be matched to a status: nothing is kept. Never throws. */
export async function keepThreaded(storage: InboxStorage, handle: string | undefined, sent: Omit<Threaded, "h">): Promise<void> {
  if (typeof handle !== "string" || handle === "") return;
  try {
    const kept = (await storage.get<Threaded[]>(THREADED_KEY)) ?? [];
    const fresh = kept.filter((entry) => entry.h !== handle && sent.at - entry.at < KEEP_MS);
    await storage.put(THREADED_KEY, [...fresh, { h: handle, ...sent }].slice(-MAX_KEPT));
  } catch {
    // Best effort: a failed send is then only marked as not delivered.
  }
}

/** The threaded text with this handle, taken so it is resent at most once; undefined for one not kept, or kept too long ago. */
export async function takeThreaded(storage: InboxStorage, handle: string, now: number): Promise<Threaded | undefined> {
  const kept = (await storage.get<Threaded[]>(THREADED_KEY)) ?? [];
  const found = kept.find((entry) => entry.h === handle);
  if (found === undefined) return undefined;
  await storage.put(THREADED_KEY, kept.filter((entry) => entry.h !== handle && now - entry.at < KEEP_MS));
  return now - found.at < KEEP_MS ? found : undefined;
}
