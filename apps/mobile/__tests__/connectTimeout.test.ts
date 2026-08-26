/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConnectForm } from "../features/console/storage/ConnectForm";
import type { ConnectFormValues } from "../features/console/storage/connect";
import { CONNECT_TIMEOUT_MS, raceTimeout } from "../features/console/storage/timeout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A bind that never returns must not lock the connect form.
 *
 * `bindStorage` is a Convex action doing real network I/O against an endpoint
 * we have never spoken to before, and `ConvexReactClient.action()` has no
 * client-side timeout. `ConnectForm` awaited it with `submitting` true, and
 * `submitting` is what makes every field `editable={false}` and what disables
 * Connect **and Cancel**. A hang therefore left a form nobody could type in,
 * submit, or leave — holding a secret somebody had just pasted.
 *
 * Two layers, because they fail differently:
 *
 *  - `raceTimeout` on its own, with injected timers, so every branch including
 *    "it answered one tick after we gave up" is pinned. The same shape
 *    `reverify.ts` uses and for the same reason.
 *  - the real form mounted through `react-native-web`, because the bug was
 *    never in the promise — it was in which controls `submitting` disables.
 *
 * Verified to fail with the fix reverted: with the plain `await` back, the form
 * is still submitting after 45s and Cancel is still disabled.
 */

const VALID: ConnectFormValues = {
  provider: "r2",
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-context",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t-example-value",
  rootPrefix: "",
  forcePathStyle: null,
};

describe("raceTimeout", () => {
  const timers = () => {
    const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    return {
      scheduled,
      ms: 1_000,
      schedule: (fn: () => void, ms: number) => {
        scheduled.push({ fn, ms, cancelled: false });
        return scheduled.length - 1;
      },
      cancel: (handle: number) => {
        scheduled[handle]!.cancelled = true;
      },
    };
  };

  test("a value that arrives in time is the answer, and the timer is cancelled", async () => {
    const t = timers();
    const settled = await raceTimeout(Promise.resolve("ok"), t);
    expect(settled).toEqual({ kind: "value", value: "ok" });
    expect(t.scheduled[0]!.cancelled).toBe(true);
  });

  test("a throw is reported as a failure, not as a timeout", async () => {
    const t = timers();
    const boom = new Error("AccessDenied");
    const settled = await raceTimeout(Promise.reject(boom), t);
    expect(settled).toEqual({ kind: "failed", error: boom });
    expect(t.scheduled[0]!.cancelled).toBe(true);
  });

  test("nothing at all inside the window is a timeout", async () => {
    const t = timers();
    const settled = raceTimeout(new Promise(() => {}), t);
    t.scheduled[0]!.fn();
    expect(await settled).toEqual({ kind: "timeout" });
  });

  test("an answer that arrives after we gave up is dropped", async () => {
    const t = timers();
    let land: (value: string) => void = () => {};
    const settled = raceTimeout(
      new Promise<string>((resolve) => {
        land = resolve;
      }),
      t,
    );
    t.scheduled[0]!.fn();
    // "Connected" appearing under a panel that already said we had stopped
    // waiting is worse than saying nothing. The pane's own subscription is what
    // reports a bind that really did land.
    land("connected");
    expect(await settled).toEqual({ kind: "timeout" });
  });
});

describe("the connect form, when the bind hangs", () => {
  let container: HTMLElement;
  let unmount: () => void;
  let cancelled: number;

  function mount(connect: (values: ConnectFormValues) => Promise<{ status: string }>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(
        createElement(ConnectForm, {
          connect,
          initial: VALID,
          onCancel: () => {
            cancelled += 1;
          },
        }),
      );
    });
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
  }

  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

  /** RN-Web renders a disabled `Pressable` as a `<button disabled>`. */
  const isDisabled = (testID: string) => (q(testID) as HTMLButtonElement).disabled === true;
  /** …and `editable={false}` as `readonly` on the input. */
  const isReadOnly = (testID: string) => (q(testID) as HTMLInputElement).readOnly === true;

  beforeEach(() => {
    jest.useFakeTimers();
    cancelled = 0;
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test("everything locks while it is in flight — which is the bug", () => {
    mount(() => new Promise(() => {}));
    act(() => {
      q("connect-submit")!.click();
    });

    expect(isDisabled("connect-submit")).toBe(true);
    expect(isDisabled("connect-cancel")).toBe(true);
    expect(isReadOnly("connect-endpoint")).toBe(true);
    expect(isReadOnly("connect-secret")).toBe(true);
    // Pressing Cancel does nothing, because it is disabled. This is the state
    // that must not be permanent.
    act(() => {
      q("connect-cancel")!.click();
    });
    expect(cancelled).toBe(0);
  });

  test("the form comes back, and says why, once we stop waiting", async () => {
    mount(() => new Promise(() => {}));
    act(() => {
      q("connect-submit")!.click();
    });

    await act(async () => {
      jest.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    });

    expect(isDisabled("connect-cancel")).toBe(false);
    expect(isDisabled("connect-submit")).toBe(false);
    expect(isReadOnly("connect-endpoint")).toBe(false);
    expect(isReadOnly("connect-secret")).toBe(false);

    // Cancel is a real way out again.
    act(() => {
      q("connect-cancel")!.click();
    });
    expect(cancelled).toBe(1);

    // And it says what happened, without claiming to know whether the bind
    // landed — because it does not.
    expect(container.textContent).toContain("Still waiting on your provider");
    expect(container.textContent).toContain("If the connection did go through");
  });

  test("the values are still in the fields, so retrying is not a re-paste", async () => {
    mount(() => new Promise(() => {}));
    act(() => {
      q("connect-submit")!.click();
    });
    await act(async () => {
      jest.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    });
    expect((q("connect-endpoint") as HTMLInputElement).value).toBe(VALID.endpoint);
    expect((q("connect-secret") as HTMLInputElement).value).toBe(VALID.secretAccessKey);
    // Present is not the same as usable: a locked field holding the right text
    // is still a form nobody can correct a typo in.
    expect(isReadOnly("connect-endpoint")).toBe(false);
    expect(isReadOnly("connect-secret")).toBe(false);
  });

  test("a bind that answers in time is unaffected", async () => {
    let land: (result: { status: string }) => void = () => {};
    mount(
      () =>
        new Promise<{ status: string }>((resolve) => {
          land = resolve;
        }),
    );
    act(() => {
      q("connect-submit")!.click();
    });
    await act(async () => {
      land({ status: "connected" });
    });

    expect(isDisabled("connect-cancel")).toBe(false);
    expect(container.textContent).not.toContain("Still waiting on your provider");

    // The timer it cancelled cannot fire later and put a timeout panel under a
    // form that already succeeded.
    await act(async () => {
      jest.advanceTimersByTime(CONNECT_TIMEOUT_MS * 2);
    });
    expect(container.textContent).not.toContain("Still waiting on your provider");
  });
});
