/**
 * A Browserbase browser lives five minutes past its last use (Dev2,
 * 2026-10-15): every step Tex runs and every look or tap from the person's
 * `/tex/<handle>` page pushes the end five minutes further out, and a browser
 * nobody touched for five minutes is released. Browserbase bills a kept-alive
 * browser until it is released, and cannot lengthen a running session, so the
 * vendor's own `timeout` (`SESSION_LIFETIME_S`) is only the ceiling and this
 * is what ends a browser early.
 *
 * One Durable Object per person, named by the owner tag, holding that tag and
 * an alarm and nothing else: never the session id, which is found again by the
 * tag when the alarm fires, as every question finds it (./browserbase.ts).
 * Without the binding (a self-hoster, or a test) the ceiling alone applies.
 */

import { findSession, releaseSession, type BrowserbaseEnv } from "./browserbase";

/** How long a browser outlives its last use. */
export const IDLE_MS = 5 * 60 * 1000;

export interface IdleStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** What the Durable Object does, apart from the runtime so it can be tested. */
export class IdleTimer {
  constructor(
    private storage: IdleStorage,
    private env: BrowserbaseEnv,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async touch(owner: string): Promise<void> {
    await this.storage.put("owner", owner);
    await this.storage.setAlarm(this.now() + IDLE_MS);
  }

  async alarm(): Promise<void> {
    const owner = await this.storage.get<string>("owner");
    const session = owner ? await findSession(this.env, owner, this.fetcher).catch(() => null) : null;
    // A touch that landed while the browser was being looked up set a new
    // alarm: the browser is in use again, so it stays.
    const next = await this.storage.getAlarm();
    if (next !== null && next > this.now()) return;
    if (session) await releaseSession(this.env, session.id, this.fetcher).catch(() => undefined);
    console.log(JSON.stringify({ event: "site_shots_browserbase_idle_release", released: session !== null }));
    await this.storage.deleteAll();
  }
}

export interface IdleNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { touch(owner: string): Promise<void> };
}

/** Pushes this person's browser's end five minutes out. Never fails the step it rides on. */
export async function touchIdle(namespace: IdleNamespace | undefined, owner: string): Promise<void> {
  if (!namespace) return;
  try {
    await namespace.get(namespace.idFromName(owner)).touch(owner);
  } catch (error) {
    console.log(JSON.stringify({ event: "site_shots_idle_touch_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}
