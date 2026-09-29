/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HandoffCard } from "../features/console/storage/handoff/HandoffCard";
import { handoffSteps } from "../features/console/storage/handoff/steps";
import type { ConsoleStorage } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Leaving managed storage, on the glass: the states an owner can find the move
 * in, and the promise every one of them keeps (the download is always there,
 * and nothing says the workspace stopped running).
 *
 * ## Sabotage record
 *
 * Dropping the `readyToSwitch` check in `HandoffCard` drew Stop on a move that
 * was already switching, failing "a move switching over can no longer be
 * stopped". Reading `managedRetainedUntil` without comparing it to now drew
 * the switch-back offer after the copy was gone, failing the last test.
 */

const NOW = Date.UTC(2026, 8, 29, 12);

function managed(overrides: Partial<ConsoleStorage> = {}): ConsoleStorage {
  return {
    connected: true,
    status: "connected",
    provider: "r2",
    managed: true,
    conditionalWrite: true,
    updatedAt: 0,
    ...overrides,
  };
}

function mount(props: Partial<Parameters<typeof HandoffCard>[0]> & { storage: ConsoleStorage }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { move: 0, stop: 0, download: 0, back: 0 };
  act(() => {
    root.render(
      createElement(HandoffCard, {
        owner: true,
        onMove: () => calls.move++,
        onStop: async () => {
          calls.stop++;
        },
        onDownload: () => calls.download++,
        onSwitchBack: () => calls.back++,
        now: NOW,
        ...props,
      }),
    );
  });
  const q = (id: string) =>
    document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    calls,
    q,
    get text() {
      return container.textContent ?? "";
    },
    click(id: string) {
      const element = q(id);
      if (element === null) throw new Error(`no control called ${id}`);
      act(() => element.click());
    },
    async press(label: string) {
      const button = [...document.body.querySelectorAll('[role="button"], button')].find(
        (element) => element.textContent === label,
      ) as HTMLElement | undefined;
      if (button === undefined) throw new Error(`no button labelled ${label}`);
      await act(async () => button.click());
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the way out of managed storage", () => {
  test("offers the move to an owner and the download to everyone", () => {
    const owner = mount({ storage: managed() });
    expect(owner.q("storage-handoff")?.textContent).toBe("Move to my own bucket");
    owner.click("storage-download-all");
    expect(owner.calls.download).toBe(1);
    owner.unmount();

    const member = mount({ storage: managed(), owner: false });
    expect(member.q("storage-handoff")).toBeNull();
    expect(member.q("storage-download-all")).not.toBeNull();
    expect(member.text).toContain("Only an owner");
    member.unmount();
  });

  test("draws nothing for a workspace that was never on managed storage", () => {
    const screen = mount({ storage: managed({ managed: false }) });
    expect(screen.text).toBe("");
    screen.unmount();
  });

  test("stopping asks first, then stops", async () => {
    const screen = mount({
      storage: managed({ handoffStatus: "copying", handoffPhase: "copy", handoffClaimed: true }),
    });
    screen.click("storage-handoff-stop");
    expect(document.body.textContent).toContain("Stop the move?");
    expect(screen.calls.stop).toBe(0);
    const confirms = [...document.body.querySelectorAll("*")].filter(
      (element) => element.textContent === "Stop the move" && element.children.length === 0,
    );
    // The card's button and the dialog's; the dialog's is the last drawn.
    await act(async () => (confirms[confirms.length - 1] as HTMLElement).click());
    expect(screen.calls.stop).toBe(1);
    screen.unmount();
  });

  test("a move switching over can no longer be stopped", () => {
    const screen = mount({
      storage: managed({
        handoffStatus: "copying",
        handoffPhase: "verify_target",
        handoffReadyToSwitch: true,
      }),
    });
    expect(screen.q("storage-handoff-stop")).toBeNull();
    expect(screen.q("storage-handoff-step-switch")?.textContent).toContain("Switching over");
    expect(screen.q("storage-download-all")).not.toBeNull();
    screen.unmount();
  });

  test("a bucket that already has files is refused in plain words, with a retry", () => {
    const screen = mount({
      storage: managed({ handoffStatus: "failed", handoffErrorCode: "DESTINATION_NOT_EMPTY" }),
    });
    expect(screen.text).toContain("Your bucket already has files in it");
    expect(screen.text).toContain("won't change or delete anything already there");
    expect(screen.q("storage-handoff")?.textContent).toBe("Retry");
    screen.unmount();
  });

  test("names the files that stopped a move", () => {
    const screen = mount({
      storage: managed({
        handoffStatus: "failed",
        handoffErrorCode: "OBJECT_TOO_LARGE",
        handoffFailedKeys: ["meetings/kickoff.m4a"],
      }),
    });
    expect(screen.text).toContain("1 file didn't copy");
    expect(screen.q("storage-handoff-failed-files")?.textContent).toContain("meetings/kickoff.m4a");
    screen.unmount();
  });

  test("a stopped move reads as nothing changed, not as a failure", () => {
    const screen = mount({
      storage: managed({
        handoffStatus: "failed",
        handoffErrorCode: "CANCELLED",
        handoffBucket: "my-notes",
      }),
    });
    expect(screen.q("storage-handoff-failed")).toBeNull();
    expect(screen.q("storage-handoff-stopped")?.textContent).toContain("Nothing changed");
    expect(screen.q("storage-handoff")?.textContent).toBe("Move to my own bucket");
    screen.unmount();
  });

  test("after a move, offers the way back only while Context's copy is kept", () => {
    const kept = mount({
      storage: managed({ managed: false, managedRetainedUntil: NOW + 86_400_000 }),
    });
    expect(kept.text).toContain("Your workspace now lives in your bucket");
    kept.click("storage-switch-back");
    expect(kept.calls.back).toBe(1);
    kept.unmount();

    const gone = mount({
      storage: managed({ managed: false, managedRetainedUntil: NOW - 1 }),
    });
    expect(gone.text).toBe("");
    gone.unmount();
  });
});

describe("the five steps a move walks", () => {
  test("map the backend's phases to what an owner reads", () => {
    const states = (progress: Parameters<typeof handoffSteps>[0]) =>
      handoffSteps(progress).map((step) => step.state).join(",");
    expect(states({ phase: "count", claimed: false })).toBe("current,todo,todo,todo,todo");
    expect(states({ phase: "count", claimed: true })).toBe("done,current,todo,todo,todo");
    expect(states({ phase: "copy" })).toBe("done,done,current,todo,todo");
    expect(states({ phase: "verify_source" })).toBe("done,done,done,current,todo");
    expect(states({ phase: "verify_target", readyToSwitch: true })).toBe(
      "done,done,done,done,current",
    );
  });

  test("put a bar only on the step that is moving, capped at the total", () => {
    const steps = handoffSteps({ phase: "copy", total: 10, processed: 14 });
    expect(steps.find((step) => step.key === "copy")?.progress).toEqual({ done: 10, total: 10 });
    expect(steps.filter((step) => step.progress !== undefined)).toHaveLength(1);
  });
});
