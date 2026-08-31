/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Two presses for something that cannot be taken back, and the second one
 * expires.
 *
 * The expiry is the part worth a test. The pattern was written twice — the
 * delete-account card and the remove-member row — and neither had a way back
 * to `idle`, so arming a control and walking away left it armed: the next
 * press deleted an account or cut somebody's access, minutes after the decision
 * to, and possibly not by the person who made it. A two-press control with an
 * unbounded window is a one-press control fired at a moment nobody chose.
 *
 * Fake timers throughout, because the alternative is a test that waits five
 * real seconds and a suite that grows by five seconds for every case here.
 */

const { useArming, ARMED_MS } =
  require("../features/console/useArming") as typeof import("../features/console/useArming");

function mount(run: () => void | Promise<void>) {
  let live: ReturnType<typeof useArming> | null = null;
  function Probe() {
    live = useArming(run);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return {
    api: () => live!,
    press: () => act(() => live!.press()),
    disarm: () => act(() => live!.disarm()),
    tick: (ms: number) => act(() => void jest.advanceTimersByTime(ms)),
    /** Let the in-flight `run` promise settle and React flush what follows. */
    settle: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("two presses, and the second expires", () => {
  test("the first press arms and runs nothing", () => {
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    armed.press();

    expect(armed.api().stage).toBe("armed");
    expect(calls).toBe(0);
    armed.unmount();
  });

  test("the second press runs it, synchronously", () => {
    /*
      Synchronously matters: callers set their own "Deleting…" state around this
      call. An earlier draft deferred `run` to a microtask to keep the side
      effect out of a `setState` updater, and that quietly broke every caller
      and test that looked at the world immediately after the press.
    */
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    armed.press();
    armed.press();

    expect(calls).toBe(1);
    /*
      And back to `idle`, because a synchronous `run` has already finished by
      the time it returns — "working" was the stranded state, not a state.

      This assertion read `"working"` until the settle was added, and that is
      exactly the shape of the defect: `SettingsPane`'s Disconnect passes a
      synchronous `run` (it fires `actions.disconnect()` with `void … .finally`
      and returns), so the control jammed on the FIRST confirmed press —
      success or failure, not only failure — and stayed jammed until the pane
      remounted. A caller that wants the control held during its own work
      drives that from its own state, as `SettingsPane` does with
      `setDisconnecting`.
    */
    expect(armed.api().stage).toBe("idle");
    armed.unmount();
  });

  test("the offer expires, and a later press only arms again", () => {
    // The whole reason this hook exists.
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    armed.press();
    expect(armed.api().stage).toBe("armed");

    armed.tick(ARMED_MS);
    expect(armed.api().stage).toBe("idle");

    armed.press();
    expect(calls).toBe(0);
    expect(armed.api().stage).toBe("armed");
    armed.unmount();
  });

  test("it is still live just before the deadline", () => {
    // Paired with the case above so "expires" cannot be satisfied by a control
    // that disarms immediately and is therefore impossible to confirm.
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    armed.press();
    armed.tick(ARMED_MS - 1);
    armed.press();

    expect(calls).toBe(1);
    armed.unmount();
  });

  test("a double tap fires once, not twice", () => {
    /*
      Two presses in one frame: the second handler runs before React has
      re-rendered, so a `stage`-based decision would see `idle` twice and arm
      twice instead of arming and firing. The hook reads a ref for this.
    */
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    act(() => {
      armed.api().press();
      armed.api().press();
      armed.api().press();
    });

    expect(calls).toBe(1);
    armed.unmount();
  });

  test("disarm puts it away", () => {
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
    });

    armed.press();
    armed.disarm();

    expect(armed.api().stage).toBe("idle");
    armed.press();
    expect(calls).toBe(0);
    armed.unmount();
  });

  test("unmounting cannot leave a timer behind", () => {
    // Navigating away mid-arm. Without the effect's cleanup this fires into an
    // unmounted tree, which React warns about and which would also mean the
    // control was still armed in a screen nobody is looking at.
    const armed = mount(() => {});
    armed.press();
    armed.unmount();

    expect(() => jest.advanceTimersByTime(ARMED_MS * 2)).not.toThrow();
  });
});

/**
 * WHAT HAPPENS AFTER `run` FAILS.
 *
 * `press()` returns early on `"working"` and `disarm()` only acts on
 * `"armed"`, so nothing moved the stage back — and `run()` was called as
 * `void run()`, discarding the promise. A rejection therefore left the control
 * stranded: the label reverts, the button re-enables, the armed warning is
 * gone, and every further press is a no-op until the component remounts.
 *
 * Two live call sites, both a regression from moving this state into the hook.
 * The one that matters is **Disconnect** — the console's control for revoking
 * our own access to a bucket the customer owns. CLAUDE.md's first
 * non-negotiable is that "a customer can revoke our storage credential without
 * asking us first", and a button that dies on its first failed attempt is a
 * revoke that does not work at the moment somebody needs it to. It had no test
 * of any kind.
 *
 * Every rejection below is given a handler by the test itself. Without one,
 * the pre-fix behaviour is an *unhandled* rejection that kills the worker
 * rather than failing an assertion — which is its own evidence, and useless as
 * a regression check.
 */
describe("after the work finishes", () => {
  /** A promise the test already handles, so only the hook's handling is on trial. */
  function handled<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    return promise;
  }

  /**
   * The stage is HELD while the work is in flight, which is the half the other
   * checks cannot see.
   *
   * Replacing the promise branch with a bare `done()` — settle immediately,
   * ignore the promise — passes every other check in this file, including all
   * three regression checks below. The only thing that catches it is a label
   * assertion in `deleteAccount.test.ts`, in another file, which is itself
   * microtask-order-dependent. So the wrong fix for this defect is one line
   * away and was, until this check, invisible here.
   */
  test("the stage is held for as long as the work runs, not just afterwards", async () => {
    let resolve: (() => void) | null = null;
    const armed = mount(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );

    armed.press();
    armed.press();
    expect(armed.api().stage).toBe("working");

    // Still working after a turn of the microtask queue — a settle that fired
    // on its own rather than on the promise would already have moved.
    await armed.settle();
    expect(armed.api().stage).toBe("working");

    await act(async () => {
      resolve!();
      await Promise.resolve();
    });
    expect(armed.api().stage).toBe("idle");
    armed.unmount();
  });

  test("a failed run leaves the control usable rather than stranded", async () => {
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
      return handled(Promise.reject(new Error("the network, or the server, or both")));
    });

    armed.press();
    armed.press();
    expect(calls).toBe(1);

    await armed.settle();
    expect(armed.api().stage).toBe("idle");

    // ...and it genuinely works again rather than merely reading as if it
    // might: two more presses call `run` a second time.
    armed.press();
    armed.press();
    expect(calls).toBe(2);
    armed.unmount();
  });

  test("and a run that succeeds settles the same way", async () => {
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
      return Promise.resolve();
    });

    armed.press();
    armed.press();
    await armed.settle();

    expect(armed.api().stage).toBe("idle");
    expect(calls).toBe(1);
    armed.unmount();
  });

  test("a run that throws synchronously does not strand it either", async () => {
    let calls = 0;
    const armed = mount(() => {
      calls += 1;
      throw new Error("thrown before any promise exists");
    });

    armed.press();
    armed.press();
    await armed.settle();

    expect(armed.api().stage).toBe("idle");
    armed.press();
    armed.press();
    expect(calls).toBe(2);
    armed.unmount();
  });

  test("and unmounting while the work is in flight sets no state on a dead component", async () => {
    let reject: ((reason: Error) => void) | null = null;
    const pending = handled(
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
    );
    const armed = mount(() => pending);

    armed.press();
    armed.press();
    armed.unmount();

    const warnings: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void warnings.push(args);
    try {
      reject!(new Error("after the pane went away"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      console.error = realError;
    }

    expect(warnings).toEqual([]);
  });
});
