/**
 * A Browserbase browser lives five minutes past its last use (Dev2,
 * 2026-10-15): every step Tex runs and every look or tap from the person's
 * `/tex/<handle>` page pushes the end five minutes further out, and a browser
 * nobody touched for five minutes is released. Browserbase bills a kept-alive
 * browser until it is released, and cannot lengthen a running session, so the
 * vendor's own `timeout` (`SESSION_LIFETIME_S`) is only the ceiling and this
 * is what ends a browser early.
 *
 * One Durable Object per person, named by the owner tag, holding that tag,
 * its deadline and an alarm, and nothing else: never the session id, which is found again by the
 * tag when the alarm fires, as every question finds it (./browserbase.ts).
 * Without the binding (a self-hoster, or a test) the ceiling alone applies.
 */

import { ownerSessionIds, releaseSession, type BrowserbaseEnv } from "./browserbase";

/** How long a browser outlives its last use. */
export const IDLE_MS = 5 * 60 * 1000;
/** How soon a release that Browserbase could not answer is tried again. */
export const RETRY_MS = 60 * 1000;

export interface IdleStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** Runs `fn` with no other event let in until it is done (blockConcurrencyWhile). */
export type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;

/** What the Durable Object does, apart from the runtime so it can be tested. */
export class IdleTimer {
  constructor(
    private storage: IdleStorage,
    private env: BrowserbaseEnv,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
    private exclusive: Exclusive = (fn) => fn(),
  ) {}

  async touch(owner: string): Promise<void> {
    const until = this.now() + IDLE_MS;
    await this.storage.put("owner", owner);
    // The deadline is kept, not read back from the alarm: an alarm can run
    // more than once, and inside its handler getAlarm says nothing of a touch.
    await this.storage.put("until", until);
    await this.storage.setAlarm(until);
  }

  /**
   * No touch is let in while the browser is looked up and released, so a step
   * at the five-minute mark waits, then finds no browser and starts a new one,
   * rather than running on one being released under it. A failed lookup or
   * release asks again in a minute, for as long as Browserbase is down
   * (the runtime's own retries stop after six): only a browser known to be
   * gone, or released, ends the timer.
   */
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const owner = await this.storage.get<string>("owner");
      let ids: string[];
      try {
        ids = owner ? await ownerSessionIds(this.env, owner, this.fetcher) : [];
        // Used since this alarm was set: the browser stays until its own deadline.
        const until = await this.storage.get<number>("until");
        if (typeof until === "number" && until > this.now()) {
          await this.storage.setAlarm(until);
          return;
        }
        for (const id of ids) await releaseSession(this.env, id, this.fetcher);
      } catch {
        console.log(JSON.stringify({ event: "site_shots_browserbase_idle_retry" }));
        await this.storage.setAlarm(this.now() + RETRY_MS);
        return;
      }
      console.log(JSON.stringify({ event: "site_shots_browserbase_idle_release", released: ids.length }));
      await this.storage.deleteAll();
    });
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
