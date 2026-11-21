/**
 * @jest-environment jsdom
 */

/**
 * THE RUN CARD, THE DELIVERY LINE AND THE WORKING MARK, ON THE GLASS.
 *
 * Mounts the three presentational pieces and proves what a person sees and
 * presses: a live run's label and elapsed time, a settled run folded away and
 * opened, a failed send with its retry, a queued line, a delivered line, and
 * Tex's working mark starting and stopping its swing without leaking a timer.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TexRunCard } from "../features/tex/chat/TexRunCard";
import { TexDeliveryLine } from "../features/tex/chat/TexDeliveryLine";
import { AccessibilityInfo } from "react-native";
import { TexWorkingMark } from "../features/tex/chat/TexWorkingMark";
import { QUEUED_SENTENCE, type LiveStep, type RunCardData } from "../features/tex/chat/appChatRun";

const T0 = Date.UTC(2026, 10, 20, 8, 25, 0);

let mounted: { root: Root; container: HTMLElement } | null = null;

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted = { root, container };
  return container;
}

function find(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function press(el: HTMLElement | null) {
  if (el === null) throw new Error("nothing to press");
  act(() => {
    el.click();
  });
}

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted?.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

const tool = (name: string, what: string, extra: Partial<LiveStep> = {}): LiveStep => ({
  k: "tool",
  at: T0,
  name,
  what,
  ...extra,
});

describe("TexRunCard", () => {
  test("live: shows the label, the elapsed seconds and the steps, and cannot be folded", () => {
    const onToggle = jest.fn();
    const run: RunCardData = {
      live: true,
      startedAt: T0,
      now: "Searching notes",
      steps: [
        { k: "think", at: T0, text: "I'll look in the notes." },
        tool("search_notes", "bible study", { ms: 1200, res: "3 notes" }),
        tool("read_note", "Daniel 5 study"),
      ],
    };
    const c = mount(
      createElement(TexRunCard, { run, now: T0 + 12_400, open: false, onToggle, testID: "run-1" }),
    );

    const head = find(c, "run-1-head");
    expect(head?.textContent).toContain("Searching notes");
    expect(head?.textContent).toContain("12s");
    expect(head?.textContent).not.toContain("Show steps");

    expect(find(c, "run-1-step-0")?.textContent).toContain("I'll look in the notes.");
    expect(find(c, "run-1-step-1")?.textContent).toContain("Searched notes “bible study”");
    expect(find(c, "run-1-step-1")?.textContent).toContain("3 notes");
    expect(find(c, "run-1-step-1")?.textContent).toContain("1.2s");
    expect(find(c, "run-1-step-2")?.textContent).toContain("Read “Daniel 5 study”");

    press(head);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("live with no now: the label is the last tool step's words", () => {
    const run: RunCardData = {
      live: true,
      startedAt: T0,
      steps: [tool("write_note", "Daniel 6 study")],
    };
    const c = mount(createElement(TexRunCard, { run, now: T0 + 3_000, open: false, onToggle: () => {}, testID: "r" }));
    expect(find(c, "r-head")?.textContent).toContain("Wrote “Daniel 6 study”");
    expect(find(c, "r-head")?.textContent).toContain("3s");
  });

  test("done and closed: Worked 41s, 7 steps, Show steps, and no step rows", () => {
    const run: RunCardData = {
      live: false,
      secs: 41,
      steps: Array.from({ length: 7 }, (_, i) => tool("read_note", `note ${i}`, { ms: 400 })),
    };
    const c = mount(createElement(TexRunCard, { run, now: T0, open: false, onToggle: () => {}, testID: "run-2" }));

    const head = find(c, "run-2-head");
    expect(head?.textContent).toContain("Worked 41s");
    expect(head?.textContent).toContain("7 steps");
    expect(head?.textContent).toContain("Show steps");
    expect(find(c, "run-2-step-0")).toBeNull();
  });

  test("done and closed: pressing the head asks for a toggle", () => {
    const onToggle = jest.fn();
    const run: RunCardData = { live: false, secs: 5, steps: [tool("read_note", "x")] };
    const c = mount(createElement(TexRunCard, { run, now: T0, open: false, onToggle, testID: "run-3" }));
    press(find(c, "run-3-head"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("done and open: the steps show with their result lines and times, and Hide", () => {
    const run: RunCardData = {
      live: false,
      secs: 9,
      steps: [
        tool("search_email", "from:puttery", { ms: 900, res: "Thread “Your Event is Confirmed!”" }),
        tool("write_note", "Daniel 6 study", { ms: 500, res: "Held for your OK" }),
      ],
    };
    const c = mount(createElement(TexRunCard, { run, now: T0, open: true, onToggle: () => {}, testID: "run-4" }));

    expect(find(c, "run-4-head")?.textContent).toContain("Hide ▴");
    expect(find(c, "run-4-step-0")?.textContent).toContain("Searched mail “from:puttery”");
    expect(find(c, "run-4-step-0")?.textContent).toContain("Thread “Your Event is Confirmed!”");
    expect(find(c, "run-4-step-0")?.textContent).toContain("0.9s");
    expect(find(c, "run-4-step-1")?.textContent).toContain("Held for your OK");
  });

  test("the words are drawn as text, never as markup", () => {
    const run: RunCardData = {
      live: false,
      secs: 2,
      steps: [tool("read_note", "<img src=x onerror=alert(1)>")],
    };
    const c = mount(createElement(TexRunCard, { run, now: T0, open: true, onToggle: () => {}, testID: "run-5" }));
    expect(c.querySelector("img")).toBeNull();
    expect(find(c, "run-5-step-0")?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("TexDeliveryLine", () => {
  test("failed: the sentence names the time, and Try again asks for a retry", () => {
    const onRetry = jest.fn();
    const c = mount(
      createElement(TexDeliveryLine, { state: "failed", at: "8:25 AM", onRetry, testID: "line-1" }),
    );
    expect(c.textContent).toContain("Tex didn't answer this. It hit an error at 8:25 AM.");
    press(find(c, "line-1-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(c.textContent).not.toContain("Delivered");
  });

  test("queued: the queued sentence and the time with Delivered", () => {
    const c = mount(
      createElement(TexDeliveryLine, { state: "queued", at: "8:25 AM", onRetry: () => {}, testID: "line-2" }),
    );
    expect(c.textContent).toContain(QUEUED_SENTENCE);
    expect(c.textContent).toContain("8:25 AM · Delivered");
    expect(find(c, "line-2-retry")).toBeNull();
  });

  test("sent: the time and Delivered on one line", () => {
    const c = mount(
      createElement(TexDeliveryLine, { state: "sent", at: "8:25 AM", onRetry: () => {}, testID: "line-3" }),
    );
    expect(find(c, "line-3")?.textContent).toBe("8:25 AM · Delivered");
  });

  test("failed with a different failure time uses that time", () => {
    const c = mount(
      createElement(TexDeliveryLine, {
        state: "failed",
        at: "8:25 AM",
        failedAt: "8:27 AM",
        onRetry: () => {},
        testID: "line-4",
      }),
    );
    expect(c.textContent).toContain("hit an error at 8:27 AM.");
  });
});

describe("TexWorkingMark", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockRestore();
    jest.useRealTimers();
  });

  /** Lets the reduced-motion read resolve: motion starts only once it says the viewer allows it. */
  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  test("busy: hidden from assistive technology, and redrawn as it swings", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const busy = mount(createElement(TexWorkingMark, { busy: true }));
    const hidden = busy.firstElementChild as HTMLElement | null;
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    await settle();

    const before = busy.innerHTML;
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(busy.querySelector("svg")).not.toBeNull();
    expect(busy.innerHTML).not.toBe(before);
  });

  test("busy under reduced motion: it does not swing and starts no timer", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const busy = mount(createElement(TexWorkingMark, { busy: true }));
    await settle();
    const before = busy.innerHTML;
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(busy.innerHTML).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("unmounting while busy clears the timer, and idle draws still", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    // The mark's own interval is the one this test must see cleared. Other
    // code on the page (the accessibility read, the Tex drawing) may hold its
    // own timers, so every interval the mark opens is tracked by id.
    const opened: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = jest.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      opened.push(id);
      return id;
    }) as typeof setInterval);
    const clearSpy = jest.spyOn(globalThis, "clearInterval").mockImplementation(((id?: unknown) => {
      cleared.push(id);
      return realClear(id as ReturnType<typeof setInterval>);
    }) as typeof clearInterval);
    try {
      const busy = mount(createElement(TexWorkingMark, { busy: true }));
      await settle();
      expect(opened.length).toBe(1);
      act(() => {
        mounted?.root.unmount();
      });
      busy.remove();
      mounted = null;
      expect(cleared).toEqual(opened);

      const idleOpened = opened.length;
      const idle = mount(createElement(TexWorkingMark, { busy: false, size: 22 }));
      expect(idle.querySelector("svg")).not.toBeNull();
      expect(opened.length).toBe(idleOpened);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
