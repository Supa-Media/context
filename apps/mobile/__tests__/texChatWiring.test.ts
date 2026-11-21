/**
 * @jest-environment jsdom
 */

/**
 * THE TEX TAB'S WIRING, ON THE GLASS.
 *
 * `texChatTab.test.ts` proves the rows; this proves what the tab adds on top
 * of them: the delivery line under a person's own row, the retry, the run cards
 * (finished and live), the header's mark, the composer in stop mode, the
 * toast, and Esc stopping a busy turn.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/tex/chat/useAppChat", () => ({
  useAppChat: () => {
    throw new Error("the Tex tab is drawn from the view it is given, in these tests");
  },
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppChatRow, ChatLine } from "../features/tex/chat/appChatGateway";
import type { AppChatView } from "../features/tex/chat/useAppChat";
import { TexChatView } from "../features/tex/chat/TexChatTab";
import type { LiveStep } from "../features/tex/chat/appChatRun";

const AT = Date.UTC(2026, 10, 20, 8, 25, 0);

function row(over: Partial<AppChatRow> & { id: string }): AppChatRow {
  return { who: "tex", text: "", at: AT, kind: "text", ...over };
}

type Calls = unknown[][];

function fakeView(over: Partial<AppChatView> = {}): AppChatView & { calls: Calls } {
  const calls: Calls = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  return {
    available: true,
    phase: "listed",
    lines: [] as ChatLine[],
    busy: false,
    sending: false,
    error: null,
    answers: {},
    send: record("send") as AppChatView["send"],
    retry: record("retry") as AppChatView["retry"],
    answer: record("answer") as AppChatView["answer"],
    react: record("react") as AppChatView["react"],
    edit: record("edit") as AppChatView["edit"],
    unsend: record("unsend") as AppChatView["unsend"],
    downloadFile: record("downloadFile") as AppChatView["downloadFile"],
    pictureUrl: () => null,
    typing: () => {},
    run: null,
    stop: record("stop") as AppChatView["stop"],
    retryRow: record("retryRow") as AppChatView["retryRow"],
    toast: null,
    ...over,
    calls,
  };
}

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
});

function mount(view: AppChatView & { calls: Calls }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const draw = (next: AppChatView & { calls: Calls }) => act(() => root.render(createElement(TexChatView, { view: next })));
  draw(view);
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    draw,
    calls: view.calls,
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

const STEPS: LiveStep[] = [
  { k: "tool", at: 0, name: "search_notes", what: "reading list", ms: 1200 },
  { k: "tool", at: 1, name: "read_note", what: "areas/bible-study/Daniel 5 study.md" },
];

describe("the delivery line under a person's own row", () => {
  test("a sent text says Delivered under it, with its time", () => {
    const t = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "hello", state: "sent" })] }));
    expect(t.find("tex-delivery-m1")?.textContent).toContain("Delivered");
  });

  test("a read text says Read", () => {
    const t = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "hello", state: "read" })] }));
    expect(t.find("tex-delivery-m1")?.textContent).toContain("Read");
  });

  test("Tex's own rows get no delivery line", () => {
    const t = mount(fakeView({ lines: [row({ id: "t1", text: "hi" })] }));
    expect(t.find("tex-delivery-t1")).toBeNull();
  });

  test("Try again on a failed text calls retryRow for that row", () => {
    const t = mount(fakeView({ lines: [row({ id: "m1", who: "me", text: "hello", state: "failed", failedAt: AT })] }));
    t.press("tex-delivery-m1-retry");
    expect(t.calls).toContainEqual(["retryRow", "m1"]);
  });
});

describe("the run cards", () => {
  test("a finished run sits above its Tex row; the newest is open, an older one folded", () => {
    const t = mount(
      fakeView({
        lines: [
          row({ id: "t1", text: "first", run: { secs: 94, steps: STEPS } }),
          row({ id: "t2", text: "second", run: { secs: 12, steps: STEPS } }),
        ],
      }),
    );
    expect(t.text()).toContain("Worked 12s");
    expect(t.find("tex-run-t2-step-0")).not.toBeNull();
    expect(t.find("tex-run-t1-step-0")).toBeNull();
    t.press("tex-run-t1-head");
    expect(t.find("tex-run-t1-step-0")).not.toBeNull();
  });

  test("a live run shows at the end of the list and the old typing mark is gone", () => {
    const t = mount(
      fakeView({
        busy: true,
        lines: [row({ id: "m1", who: "me", text: "go", state: "reading" })],
        run: { turn: "turn-1", covers: ["m1"], startedAt: Date.now() - 3000, steps: STEPS },
      }),
    );
    expect(t.find("tex-run-live")).not.toBeNull();
    expect(t.find("tex-typing")).toBeNull();
  });

  test("busy with no run yet keeps the typing mark", () => {
    const t = mount(fakeView({ busy: true }));
    expect(t.find("tex-typing")).not.toBeNull();
    expect(t.find("tex-run-live")).toBeNull();
  });
});

describe("the header, the composer and the stop", () => {
  test("the composer is in stop mode while busy, and send mode when not", () => {
    const t = mount(fakeView({ busy: true }));
    expect(document.querySelector('[aria-label="Stop Tex"]')).not.toBeNull();
    t.draw(fakeView({ busy: false }));
    expect(document.querySelector('[aria-label="Stop Tex"]')).toBeNull();
  });

  test("Esc calls stop while Tex is busy", () => {
    const t = mount(fakeView({ busy: true }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(t.calls).toContainEqual(["stop"]);
  });

  test("Esc does nothing when Tex is not busy", () => {
    const t = mount(fakeView({ busy: false }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(t.calls.filter((call) => call[0] === "stop")).toEqual([]);
  });

  test("a toast shows above the box while the view has one", () => {
    const t = mount(fakeView({ toast: "Stopped. Tex keeps what it already did." }));
    expect(t.find("tex-toast")?.textContent).toBe("Stopped. Tex keeps what it already did.");
    t.draw(fakeView({ toast: null }));
    expect(t.find("tex-toast")).toBeNull();
  });
});
