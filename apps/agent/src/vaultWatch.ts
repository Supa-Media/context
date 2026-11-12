/**
 * Carrying a task on once the person saved the login Tex asked for (Dev2,
 * 2026-10-24, ordering Instacart groceries: "after adding the email and
 * password Tex should know that i'm done adding").
 *
 * A turn that texted a link to save a login says so (`vaultWatch`,
 * `apps/mcp/src/agent/vaultSaved.js`), and the sender's inbox keeps
 * `VAULT_KEY`: its alarm asks the control plane until a save link was used
 * (`POST /agent-texts/vault-saved`) and hands back when, and the inbox queues
 * a turn of its own with `event: "vault_saved"` and no words
 * (`inbox.ts`, `carryOnAfterSave`), which the gateway answers with Tex
 * carrying the task on.
 *
 * Kept: the phone (this object is already named after it) and times, never
 * the link or what was saved. Given up after the link's life.
 *
 * The watch is the chat's that texted the link, a group chat's included, and
 * names that link by its hashed token (`links`), as the control plane keys
 * it: a save on a link sent in a group wakes that group, as its asker's tag,
 * and never their 1:1 (Dev2, 2026-11-12, the Crystal Care chat's Gusto login:
 * "Tex should know when I've filled out a vault item and continue on from
 * there"). A watch from before links were named looks by phone and time.
 */

import { post, record as asRecord, ServiceError, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";

export const VAULT_KEY = "vault-watch";
/** A group's saved-login turn's routine path: it runs as a job's report does (no ack, no binding, SKIP), and no run waits on it. */
export const VAULT_SAVED_PATH = "(vault saved)";
/** Opening the link, signing in to Context and typing a password takes a little while. */
export const VAULT_FIRST_MS = 15_000;
export const VAULT_EVERY_MS = 10_000;
/** Looks less often once they have had a few minutes. */
export const VAULT_SLOW_AFTER_MS = 5 * 60_000;
export const VAULT_SLOW_MS = 30_000;
/** A save link lives 30 minutes; a little past that nothing more can be saved on it. */
export const VAULT_GIVE_UP_MS = 32 * 60_000;
/**
 * How far back of the watch a save still counts: a link texted as a job's
 * progress line can be saved while that job's turn is still running, before
 * the watch begins at its end.
 */
export const VAULT_SLACK_MS = 15 * 60_000;

/** A group chat's turn to queue once the save lands: its asker's tag, under the message that asked (`inbox.ts` `carryOnAfterSave`). */
export type WatchedGroup = { groupId: string; line: string; messageId: string; text: string };
/** What the chat that texted the link watches: the link's hashed token, and the group it was texted in. */
export type WatchFor = { links?: string[]; group?: WatchedGroup };
type Watch = { phone: string; since: number; nextAt: number } & WatchFor;
export type Saved = { phone: string; savedAt: number; group?: WatchedGroup };

export type VaultWatchDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  now: () => number;
};

/** Called when a turn texted a link to save a login: watch for the save. A watch already running starts over. */
export async function watchForSave(storage: InboxStorage, phone: string, now: number, watching: WatchFor = {}): Promise<void> {
  const nextAt = now + VAULT_FIRST_MS;
  const links = (watching.links ?? []).filter((hash) => /^[0-9a-f]{64}$/.test(hash)).slice(0, 5);
  await storage.put<Watch>(VAULT_KEY, { phone, since: now, nextAt, ...(links.length > 0 ? { links } : {}), ...(watching.group ? { group: watching.group } : {}) });
  await armBy(storage, nextAt);
}

/**
 * From the alarm: look once if a look is due, and keep the alarm for the
 * next. Returns the phone and when a login was saved, once, or null.
 */
export async function checkVaultSaved(storage: InboxStorage, deps: VaultWatchDeps): Promise<Saved | null> {
  const watch = await storage.get<Watch>(VAULT_KEY);
  if (watch === undefined) return null;
  const now = deps.now();
  if (now < watch.nextAt) {
    await armBy(storage, watch.nextAt);
    return null;
  }
  if (now - watch.since >= VAULT_GIVE_UP_MS) {
    await storage.delete(VAULT_KEY);
    return null;
  }
  let answer: SavedAnswer = { status: "waiting" };
  try {
    answer = await fetchSaved(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, watch.phone, watch.since - VAULT_SLACK_MS, watch.links);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
  }
  if (answer.status === "waiting") {
    const nextAt = now + (now - watch.since < VAULT_SLOW_AFTER_MS ? VAULT_EVERY_MS : VAULT_SLOW_MS);
    await storage.put<Watch>(VAULT_KEY, { ...watch, nextAt });
    await armBy(storage, nextAt);
    return null;
  }
  await storage.delete(VAULT_KEY);
  if (answer.status === "gone") {
    logVaultWatch("gone");
    return null;
  }
  return { phone: watch.phone, savedAt: answer.savedAt, ...(watch.group ? { group: watch.group } : {}) };
}

type SavedAnswer = { status: "saved"; savedAt: number } | { status: "waiting" } | { status: "gone" };

/** `POST /agent-texts/vault-saved`. Anything unexpected is a reason to look again. */
export async function fetchSaved(fetcher: Fetch, origin: string, secret: string, phone: string, since: number, links?: string[]): Promise<SavedAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/vault-saved`, secret, { phone, since, ...(links?.length ? { links } : {}) });
  if (status === 404) return { status: "waiting" };
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = asRecord(json);
  if (body.status === "saved" && typeof body.savedAt === "number" && Number.isFinite(body.savedAt)) return { status: "saved", savedAt: body.savedAt };
  return body.status === "gone" ? { status: "gone" } : { status: "waiting" };
}

/** One line per outcome, never the phone. */
export function logVaultWatch(outcome: "queued" | "gone" | "no_chat" | "texted_since" | "group_queued" | "group_full"): void {
  console.log(JSON.stringify({ event: "vault_saved_watch", outcome }));
}

/** Set the alarm for `at` unless one is already due sooner. */
async function armBy(storage: InboxStorage, at: number): Promise<void> {
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if (current === null || current === undefined || current > at) await storage.setAlarm(at);
}
