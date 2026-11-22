/**
 * A LAB TEST CHAT ON A PULL REQUEST'S CODE: THE MAILBOX BETWEEN PRODUCTION AND THAT PULL REQUEST'S PREVIEW (Dev2,
 * 2026-11-22: test chats gain "run on PR #N's code", so a change is tried in a test chat before it merges; it runs on
 * the pull request's own preview, with fictional people and stand-in mail and calendar, never production's data).
 *
 * Production's gateway never holds a preview's keys and a preview never holds production's: a GitHub workflow on main
 * (`.github/workflows/lab-preview-chat.yml`, `packages/sandbox/src/lab-bridge.mjs`) sits between them. It signs a
 * fictional developer persona in on the preview with the preview deploy key CI already holds, then takes the test
 * chat's calls from here and hands each to the preview's own `/tex-lab/sandbox`, and its answer back. It reaches here
 * with GitHub's signed token for that workflow on main (`preview.js`), so nothing new is kept anywhere.
 *
 * One mailbox per test chat on a preview, in a `LabSandbox` object of its own named by a random bridge id
 * (`labsandbox:bridge:<id>`): what it is for (the pull request, the person and their test chat), the calls waiting for
 * the workflow (kept, so a call made before the workflow starts waits for it), and the preview's own id for the test
 * chat once its `open` is answered. An answer goes straight back to the call still waiting for it, never kept.
 */

/** How long one `take` waits for a call before it answers none. */
export const TAKE_WAIT_MS = 20_000;
/** A workflow that has not asked for calls in this long is gone: another run may take the mailbox over. */
export const RUNNER_GONE_MS = 60_000;
/** The most calls waiting at once, and the largest call. */
export const MAX_QUEUED = 50;
export const MAX_CALL_BYTES = 1_000_000;
/** How long the mailbox is kept after it was opened or last used. */
export const BRIDGE_TTL_MS = 24 * 3_600_000;

const INFO = "bridge";
const QUEUE = "bridge:queue";
const PREVIEW_ID = /^[0-9a-f]{16}$/;

/**
 * The mailbox, kept on the object instance (the calls waiting for an answer live only in memory: a call whose object
 * went away is answered by its own timeout, and tried again).
 */
export class BridgeMailbox {
  constructor(state, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.state = state;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.waiting = new Map();
    this.takers = [];
    this.seenAt = 0;
  }

  async info() {
    return (await this.state.storage.get(INFO)) ?? null;
  }

  async queue() {
    return (await this.state.storage.get(QUEUE)) ?? [];
  }

  /** One op (`bridge.<op>`), its JSON body in, its JSON answer out. */
  async serve(op, body) {
    switch (op) {
      case "bridge.open":
        return await this.open(body);
      case "bridge.call":
        return await this.call(body);
      case "bridge.take":
        return await this.take(body);
      case "bridge.answer":
        return await this.answer(body);
      case "bridge.status":
        return await this.status();
      case "bridge.dispatched":
        return await this.patch({ dispatchedAt: this.now() });
      case "bridge.stop":
        return await this.stop();
      default:
        return null;
    }
  }

  async patch(fields) {
    const info = await this.info();
    if (info === null) return { error: "gone" };
    await this.state.storage.put(INFO, { ...info, ...fields });
    return { ok: true };
  }

  /** Made once, by the route that opens the test chat: the pull request, and whose test chat this is. */
  async open({ pr, userId, sandboxId }) {
    if ((await this.info()) !== null) return { error: "taken" };
    if (!Number.isSafeInteger(pr) || pr < 1 || typeof userId !== "string" || typeof sandboxId !== "string") return { error: "bad_call" };
    await this.state.storage.put(INFO, { pr, userId, sandboxId, openedAt: this.now(), previewId: null, run: null, n: 0, dispatchedAt: 0 });
    await this.state.storage.setAlarm?.(this.now() + BRIDGE_TTL_MS);
    return { ok: true };
  }

  /**
   * A call for the preview: queued (kept) for the workflow, and answered when the workflow hands its answer back, or
   * `{ timeout: true }` after `waitMs`. `kind: "open"` is the test chat's own open: its answer names the preview's id.
   */
  async call({ body, waitMs = 25_000, kind = "op" }) {
    const info = await this.info();
    if (info === null) return { error: "gone" };
    if (info.stopped) return { error: "stopped" };
    if (!body || typeof body !== "object" || JSON.stringify(body).length > MAX_CALL_BYTES) return { error: "bad_call" };
    const queue = await this.queue();
    if (queue.length >= MAX_QUEUED) return { error: "busy" };
    const n = info.n + 1;
    await this.state.storage.put(INFO, { ...info, n });
    await this.state.storage.put(QUEUE, [...queue, { n, kind, body }]);
    await this.state.storage.setAlarm?.(this.now() + BRIDGE_TTL_MS);
    this.wake();
    const wait = Math.max(0, Math.min(Number(waitMs) || 0, 120_000));
    return await new Promise((resolve) => {
      const timer = this.setTimer(async () => {
        this.waiting.delete(n);
        // A call nobody took yet is dropped with its waiter, so a person's retry never runs it twice; an open stays,
        // since the preview's test chat is made by it whenever the workflow starts.
        let dropped = false;
        if (kind !== "open") {
          const left = await this.queue();
          dropped = left.some((c) => c.n === n);
          if (dropped) await this.state.storage.put(QUEUE, left.filter((c) => c.n !== n));
        }
        resolve({ timeout: true, n, connected: this.connected(), dropped });
      }, wait);
      this.waiting.set(n, (answer) => {
        this.clearTimer(timer);
        resolve(answer);
      });
    });
  }

  connected() {
    return this.now() - this.seenAt < RUNNER_GONE_MS;
  }

  wake() {
    const takers = this.takers.splice(0);
    for (const resolve of takers) resolve();
  }

  /**
   * The workflow asking for calls: every call waiting, or none after `waitMs`. One run holds the mailbox; another is let
   * in only once that one has not asked for `RUNNER_GONE_MS` (it ended, and the person's next call started a new one).
   */
  async take({ run, waitMs = TAKE_WAIT_MS }) {
    const info = await this.info();
    if (info === null || info.stopped) return { stop: true };
    if (typeof run !== "string" || run === "") return { error: "bad_call" };
    if (info.run !== null && info.run !== run && this.now() - (info.seenAt ?? 0) < RUNNER_GONE_MS) return { refused: "another run holds this test chat" };
    this.seenAt = this.now();
    if (info.run !== run || this.now() - (info.seenAt ?? 0) > 5_000) await this.state.storage.put(INFO, { ...info, run, seenAt: this.seenAt });
    let queue = await this.queue();
    if (queue.length === 0) {
      const wait = Math.max(0, Math.min(Number(waitMs) || 0, TAKE_WAIT_MS));
      await new Promise((resolve) => {
        const timer = this.setTimer(resolve, wait);
        this.takers.push(() => {
          this.clearTimer(timer);
          resolve();
        });
      });
      queue = await this.queue();
    }
    if (queue.length > 0) await this.state.storage.put(QUEUE, []);
    const now = await this.info();
    if (now?.stopped) return { stop: true, pr: info.pr };
    return { pr: info.pr, previewId: now?.previewId ?? null, calls: queue };
  }

  /** The workflow handing a call's answer back: to the call still waiting for it; an open's names the preview's id. */
  async answer({ run, n, status, answer }) {
    const info = await this.info();
    if (info === null) return { error: "gone" };
    if (info.run !== run) return { refused: "another run holds this test chat" };
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(status)) return { error: "bad_call" };
    this.seenAt = this.now();
    if (answer && typeof answer === "object" && PREVIEW_ID.test(String(answer.sandboxId ?? "")) && info.previewId === null && status === 200) {
      await this.state.storage.put(INFO, { ...info, previewId: answer.sandboxId, seenAt: this.seenAt });
    }
    const resolve = this.waiting.get(n);
    this.waiting.delete(n);
    resolve?.({ status, answer });
    return { ok: true, waited: resolve !== undefined };
  }

  async status() {
    const info = await this.info();
    if (info === null) return { error: "gone" };
    return {
      pr: info.pr,
      previewId: info.previewId,
      connected: this.connected() || this.now() - (info.seenAt ?? 0) < RUNNER_GONE_MS,
      dispatchedAt: info.dispatchedAt ?? 0,
      queued: (await this.queue()).length,
      stopped: info.stopped === true,
    };
  }

  /** Reset: the workflow is told to stop, and every waiting call is answered. */
  async stop() {
    const info = await this.info();
    if (info !== null) await this.state.storage.put(INFO, { ...info, stopped: true });
    await this.state.storage.put(QUEUE, []);
    this.wake();
    for (const [n, resolve] of this.waiting) resolve({ status: 410, answer: { error: "This test chat was reset." }, n });
    this.waiting.clear();
    return { ok: true };
  }
}
