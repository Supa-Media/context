import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  REVERIFY_OK_RESET_MS,
  REVERIFY_TIMEOUT_MS,
  createReverifyController,
  type ObservedBinding,
  type ReverifyState,
} from "../features/console/storage/reverify";

/**
 * Re-verify is the only escape from a binding stuck in `error` after a
 * transient blip, so the interesting cases are the ones where nothing comes
 * back — a probe that never lands, a second click mid-flight, a component that
 * unmounts while a timer is armed.
 *
 * `reverifyStorage` queues a probe and returns before it runs, so "the outcome"
 * is a later value of `getStorageBinding` pushed down the reactive
 * subscription. That is what `observe` models.
 */

/** A fake clock, so timeouts are asserted rather than slept through. */
function makeClock() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  let now = 0;

  return {
    schedule(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    cancel(id: number) {
      pending.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, task] of [...pending.entries()]) {
        if (task.at <= now) {
          pending.delete(id);
          task.fn();
        }
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

const BINDING: ObservedBinding = { status: "error", updatedAt: 1_000 };

function setup(queue?: () => Promise<{ queued: boolean; status: string }>) {
  const clock = makeClock();
  const states: ReverifyState[] = [];
  let calls = 0;
  const controller = createReverifyController<number>({
    queue: () => {
      calls += 1;
      return (queue ?? (async () => ({ queued: true, status: "error" })))();
    },
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (handle) => clock.cancel(handle),
    onChange: (state) => states.push(state),
  });
  return {
    clock,
    states,
    controller,
    get calls() {
      return calls;
    },
    get last() {
      return states[states.length - 1];
    },
  };
}

/** Let the queue promise's `.then` run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("the happy path", () => {
  test("queues, shows progress, and settles when the row moves", async () => {
    const s = setup();
    s.controller.start(BINDING);
    expect(s.last).toEqual({ kind: "running" });
    await flush();

    s.controller.observe({ status: "connected", updatedAt: 2_000, lastVerifiedAt: 2_000 });
    expect(s.last.kind).toBe("ok");
    expect(s.last).toHaveProperty("message", expect.stringContaining("reachable and writable"));
  });

  /**
   * The most common outcome there is: re-checking a `connected` binding that is
   * still connected. Waiting for the *status* to change would hang forever on
   * exactly this case, which is why `moved()` watches `updatedAt`.
   */
  test("a connected binding that stays connected still settles", async () => {
    const s = setup();
    s.controller.start({ status: "connected", updatedAt: 1_000 });
    await flush();
    s.controller.observe({ status: "connected", updatedAt: 1_050 });
    expect(s.last.kind).toBe("ok");
  });

  test("a probe that lands in the same millisecond settles on lastVerifiedAt", async () => {
    const s = setup();
    s.controller.start({ status: "error", updatedAt: 1_000, lastVerifiedAt: 500 });
    await flush();
    s.controller.observe({ status: "connected", updatedAt: 1_000, lastVerifiedAt: 1_000 });
    expect(s.last.kind).toBe("ok");
  });

  test("the success note clears itself, so it cannot go stale on screen", async () => {
    const s = setup();
    s.controller.start(BINDING);
    await flush();
    s.controller.observe({ status: "connected", updatedAt: 2_000 });
    expect(s.last.kind).toBe("ok");

    s.clock.advance(REVERIFY_OK_RESET_MS);
    expect(s.last).toEqual({ kind: "idle" });
    expect(s.clock.pendingCount).toBe(0);
  });
});

describe("a probe that comes back bad", () => {
  test("reports the fix for the code, not just the provider's prose", async () => {
    const s = setup();
    s.controller.start(BINDING);
    await flush();
    s.controller.observe({
      status: "error",
      updatedAt: 2_000,
      errorCode: "NOT_WRITABLE",
      lastError: "AccessDenied",
    });

    expect(s.last.kind).toBe("failed");
    if (s.last.kind !== "failed") return;
    expect(s.last.failure.headline).toContain("read but not written to");
    expect(s.last.failure.next).toContain("put and delete");
    expect(s.last.failure.detail).toBe("AccessDenied");
  });

  test("an ambiguous-addressing failure asks for the addressing choice", async () => {
    const s = setup();
    s.controller.start(BINDING);
    await flush();
    s.controller.observe({
      status: "error",
      updatedAt: 2_000,
      errorCode: "AMBIGUOUS_ADDRESSING",
    });
    expect(s.last.kind === "failed" && s.last.failure.needsAddressingChoice).toBe(true);
  });

  // Failures stay until the next run: unlike the success note, this is
  // something the person still has to act on.
  test("a failure does not clear itself", async () => {
    const s = setup();
    s.controller.start(BINDING);
    await flush();
    s.controller.observe({ status: "error", updatedAt: 2_000, errorCode: "UNREACHABLE" });
    s.clock.advance(REVERIFY_OK_RESET_MS * 10);
    expect(s.last.kind).toBe("failed");
  });
});

describe("when nothing comes back", () => {
  test("times out with a message that does not claim the probe failed", () => {
    const s = setup();
    s.controller.start(BINDING);
    s.clock.advance(REVERIFY_TIMEOUT_MS);

    expect(s.last.kind).toBe("timeout");
    expect(s.last).toHaveProperty("message", expect.stringContaining("Still waiting"));
    expect(s.last).toHaveProperty("message", expect.stringContaining("queued"));
  });

  test("a row that moves after the timeout is ignored rather than re-settling", () => {
    const s = setup();
    s.controller.start(BINDING);
    s.clock.advance(REVERIFY_TIMEOUT_MS);
    s.controller.observe({ status: "connected", updatedAt: 9_000 });
    expect(s.last.kind).toBe("timeout");
  });

  test("the timeout is cancelled once an outcome lands", async () => {
    const s = setup();
    s.controller.start(BINDING);
    await flush();
    s.controller.observe({ status: "error", updatedAt: 2_000 });
    expect(s.clock.pendingCount).toBe(0);
  });
});

describe("when the request itself fails", () => {
  test("a rate limit says what to do rather than spinning", async () => {
    const s = setup(async () => {
      throw new ConvexError({ code: "RATE_LIMITED", message: "Too many requests." });
    });
    s.controller.start(BINDING);
    await flush();

    expect(s.last.kind).toBe("failed");
    if (s.last.kind !== "failed") return;
    expect(s.last.failure.headline).toContain("enough checks");
    expect(s.clock.pendingCount).toBe(0);
  });

  test("a non-owner gets the reason, not a generic shrug", async () => {
    const s = setup(async () => {
      throw new ConvexError({ code: "INSUFFICIENT_ROLE", message: "no" });
    });
    s.controller.start(BINDING);
    await flush();
    expect(s.last.kind === "failed" && s.last.failure.headline).toContain("Only an owner");
  });

  test("a backend that declines to queue does not leave a spinner promising otherwise", async () => {
    const s = setup(async () => ({ queued: false, status: "error" }));
    s.controller.start(BINDING);
    await flush();
    expect(s.last.kind).toBe("failed");
    expect(s.last.kind === "failed" && s.last.failure.headline).toContain("wasn't queued");
  });
});

describe("clicking twice, and unmounting", () => {
  test("a second click while one is running is ignored", async () => {
    const s = setup();
    s.controller.start(BINDING);
    s.controller.start(BINDING);
    await flush();
    expect(s.calls).toBe(1);
  });

  test("a run after dismissing is a fresh run", async () => {
    const s = setup();
    s.controller.start(BINDING);
    s.controller.dismiss();
    expect(s.last).toEqual({ kind: "idle" });

    s.controller.start(BINDING);
    await flush();
    s.controller.observe({ status: "connected", updatedAt: 2_000 });
    expect(s.last.kind).toBe("ok");
    expect(s.calls).toBe(2);
  });

  /**
   * The generation counter earns its keep here: the abandoned run's queue
   * promise resolves after the second run started, and must not touch it.
   */
  test("an abandoned run cannot settle the run that replaced it", async () => {
    const releases: Array<(value: { queued: boolean; status: string }) => void> = [];
    const s = setup(
      () =>
        new Promise<{ queued: boolean; status: string }>((resolve) => {
          releases.push(resolve);
        }),
    );
    s.controller.start(BINDING);
    s.controller.dismiss();
    s.controller.start(BINDING);

    // The *first* run's request finally answers, long after it was abandoned.
    releases[0]({ queued: false, status: "error" });
    await flush();
    // It belongs to generation 1; generation 2 is still running and untouched.
    expect(s.last).toEqual({ kind: "running" });

    // And the live run settles normally afterwards.
    releases[1]({ queued: true, status: "error" });
    await flush();
    s.controller.observe({ status: "connected", updatedAt: 2_000 });
    expect(s.last.kind).toBe("ok");
  });

  test("disposing cancels the timer and stops every later callback", async () => {
    const s = setup();
    s.controller.start(BINDING);
    const seen = s.states.length;

    s.controller.dispose();
    expect(s.clock.pendingCount).toBe(0);

    s.controller.observe({ status: "connected", updatedAt: 9_000 });
    s.controller.start(BINDING);
    s.clock.advance(REVERIFY_TIMEOUT_MS * 2);
    await flush();

    expect(s.states.length).toBe(seen);
  });

  test("observing without a run in flight does nothing", () => {
    const s = setup();
    s.controller.observe({ status: "connected", updatedAt: 9_000 });
    expect(s.states).toEqual([]);
  });
});
