/**
 * Carrying a task on once someone pressed Done on Tex's take-over screen
 * (Dev2, 2026-11-12: "it should notify tex so it continues on").
 *
 * A turn that texted a link to take over its browser names that browser
 * (`handbackWatch`: a hash of its tag, `apps/mcp/src/agent/handback.js`), and
 * the sender's inbox keeps `HANDBACK_KEY`: its alarm asks the control plane
 * (`POST /agent-texts/handed-back`) until that browser was handed back, then
 * queues the chat's own turn with `event: "browser_handed_back"` and no
 * words, as a saved login's turn is (`vaultWatch.ts`). A group chat's watch
 * wakes that chat, under the message that asked.
 *
 * Done should feel immediate, so the first minutes are looked at every few
 * seconds; the browser is held 15 minutes while it waits on someone
 * (`apps/mcp/src/agent/browserHold.js`), so the watch ends soon after.
 * Kept: the phone, times and the browser's hash, never the link.
 */

import { post, record as asRecord, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import { queueGroupByCode } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import type { WatchedGroup } from "./vaultWatch";

export const HANDBACK_KEY = "handback-watch";
/** A group's hand-back turn's routine path: it runs as a saved login's does (no ack, no binding), and no run waits on it. */
export const HANDBACK_PATH = "(browser handed back)";
export const HANDBACK_FIRST_MS = 3_000;
export const HANDBACK_EVERY_MS = 3_000;
/** Looks less often once a few minutes have gone by. */
export const HANDBACK_SLOW_AFTER_MS = 5 * 60_000;
export const HANDBACK_SLOW_MS = 15_000;
/** The browser is held 15 minutes waiting on someone; a little past that there is nothing to hand back. */
export const HANDBACK_GIVE_UP_MS = 20 * 60_000;

type Watch = { phone: string; since: number; nextAt: number; browsers: string[]; group?: WatchedGroup };
export type HandedBack = { phone: string; doneAt: number; group?: WatchedGroup };

export type HandbackWatchDeps = { fetch: Fetch; controlPlaneOrigin: string; workerSecret: string; now: () => number };

/** The browser hash a turn's answer names, or null: hex SHA-256 only. */
export function watchedBrowser(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** Called when a turn texted a take-over link: watch for its Done. A watch already running starts over. */
export async function watchForHandback(storage: InboxStorage, phone: string, now: number, browser: string, group?: WatchedGroup): Promise<void> {
  if (watchedBrowser(browser) === null) return;
  const nextAt = now + HANDBACK_FIRST_MS;
  await storage.put<Watch>(HANDBACK_KEY, { phone, since: now, nextAt, browsers: [browser], ...(group ? { group } : {}) });
  await armBy(storage, nextAt);
}

/** From the alarm: look once if a look is due, and keep the alarm for the next. Returns the hand-back once, or null. */
export async function checkHandedBack(storage: InboxStorage, deps: HandbackWatchDeps): Promise<HandedBack | null> {
  const watch = await storage.get<Watch>(HANDBACK_KEY);
  if (watch === undefined) return null;
  const now = deps.now();
  if (now < watch.nextAt) {
    await armBy(storage, watch.nextAt);
    return null;
  }
  if (now - watch.since >= HANDBACK_GIVE_UP_MS) {
    await storage.delete(HANDBACK_KEY);
    logHandbackWatch("gave_up");
    return null;
  }
  let doneAt: number | null = null;
  try {
    doneAt = await fetchHandedBack(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, watch.browsers, watch.since);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  if (doneAt === null) {
    const nextAt = now + (now - watch.since < HANDBACK_SLOW_AFTER_MS ? HANDBACK_EVERY_MS : HANDBACK_SLOW_MS);
    await storage.put<Watch>(HANDBACK_KEY, { ...watch, nextAt });
    await armBy(storage, nextAt);
    return null;
  }
  await storage.delete(HANDBACK_KEY);
  return { phone: watch.phone, doneAt, ...(watch.group ? { group: watch.group } : {}) };
}

/** `POST /agent-texts/handed-back`: when one of `browsers` was handed back since `since`, or null. */
export async function fetchHandedBack(fetcher: Fetch, origin: string, secret: string, browsers: string[], since: number): Promise<number | null> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/handed-back`, secret, { browsers, since });
  if (status === 404) return null;
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = asRecord(json);
  return body.status === "done" && typeof body.doneAt === "number" && Number.isFinite(body.doneAt) ? body.doneAt : null;
}

/** One line per outcome, never the phone. */
export function logHandbackWatch(outcome: "queued" | "gave_up" | "no_chat" | "texted_since" | "group_queued" | "group_full"): void {
  console.log(JSON.stringify({ event: "browser_handback_watch", outcome }));
}

/** A Done on a browser handed over in a group chat: that chat's turn, on its asker's tag, under the ask. */
export async function queueHandedBackInGroup(storage: InboxStorage, back: HandedBack & { group: WatchedGroup }, now: number): Promise<void> {
  const { groupId, line, messageId, text } = back.group;
  const message: GroupMessage = { kind: "group-message", eventId: `handed-back:${back.doneAt}`, groupId, line, from: back.phone, participants: [], messageId, text, routine: { runId: `handback:${back.doneAt}`, path: HANDBACK_PATH }, event: "browser_handed_back" };
  logHandbackWatch((await queueGroupByCode(storage, message, now)) === "queued" ? "group_queued" : "group_full");
}

/** Set the alarm for `at` unless one is already due sooner. */
async function armBy(storage: InboxStorage, at: number): Promise<void> {
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if (current === null || current === undefined || current > at) await storage.setAlarm(at);
}
