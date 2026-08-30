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

function mount(run: () => void) {
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
    const armed = mount(() => (calls += 1));

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
    const armed = mount(() => (calls += 1));

    armed.press();
    armed.press();

    expect(calls).toBe(1);
    expect(armed.api().stage).toBe("working");
    armed.unmount();
  });

  test("the offer expires, and a later press only arms again", () => {
    // The whole reason this hook exists.
    let calls = 0;
    const armed = mount(() => (calls += 1));

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
    const armed = mount(() => (calls += 1));

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
    const armed = mount(() => (calls += 1));

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
    const armed = mount(() => (calls += 1));

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
