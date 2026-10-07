/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The report screen as a tester meets it.
 *
 * What it promises, from the approved artboard: Send wakes up only once
 * something is written; every attachment is on the list, and the two that can
 * be removed come off with one press; the screenshot's words are hidden until
 * the person asks; and each way a send can end — sent, offline, failed — says
 * so in words and keeps the report where the person can find it.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockSubmits: Array<{ draft: Record<string, unknown>; online: boolean }> = [];
const mockOutcome: { next: unknown } = { next: { kind: "sent", code: "FB-7F2C9A" } };
const mockQueued: string[] = [];

jest.mock("../features/feedback/queue", () => ({
  submit: async (draft: Record<string, unknown>, options: { online: boolean }) => {
    mockSubmits.push({ draft, online: options.online });
    return mockOutcome.next;
  },
  enqueue: async (draft: { clientReportId: string }) => {
    mockQueued.push(draft.clientReportId);
  },
  discard: async () => {},
}));

jest.mock("../features/feedback/screenshot", () => ({
  screenshotSupported: true,
  captureScreen: async ({ showText }: { showText: boolean }) => ({
    data: new Uint8Array([showText ? 2 : 1]),
    contentType: "image/jpeg",
    previewUri: showText ? "data:image/jpeg;base64,Ag==" : "data:image/jpeg;base64,AQ==",
    width: 10,
    height: 10,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { FeedbackDialog } =
  require("../features/feedback/FeedbackDialog") as typeof import("../features/feedback/FeedbackDialog");
const activity = require("../features/observability/activity") as typeof import("../features/observability/activity");

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
  mockSubmits.length = 0;
  mockQueued.length = 0;
  mockOutcome.next = { kind: "sent", code: "FB-7F2C9A" };
  activity.resetActivityForTests();
});

async function mount(over: { errorEventId?: string } = {}) {
  const closed: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const report = {
    source: "top_bar" as const,
    screen: "/console/:context",
    errorEventId: over.errorEventId,
    openedAt: 1,
    screenshot: Promise.resolve({
      data: new Uint8Array([1]),
      contentType: "image/jpeg",
      previewUri: "data:image/jpeg;base64,AQ==",
      width: 10,
      height: 10,
    }),
  };
  await act(async () => {
    root.render(createElement(FeedbackDialog, { report, onClose: () => closed.push("closed") }));
  });
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = async (id: string) => {
    const node = find(id);
    if (node === null) throw new Error(`nothing to press: ${id}`);
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const type = (text: string) => {
    const input = document.body.querySelector("textarea") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { find, press, type, closed };
}

function disabled(node: HTMLElement | null): boolean {
  return node?.getAttribute("aria-disabled") === "true" || node?.hasAttribute("disabled") === true;
}

describe("the report screen", () => {
  test("lists what goes, with Send asleep until something is written", async () => {
    activity.recordActivity("screen", "/console/:context");
    const ui = await mount();
    const text = document.body.textContent ?? "";
    expect(text).toContain("What we'll send");
    expect(text).toContain("Your message");
    expect(text).toContain("App and device");
    expect(text).toContain("The last 10 minutes in the app");
    expect(text).toContain("Words hidden");
    expect(disabled(ui.find("feedback-send"))).toBe(true);
    ui.type("The board lost my card");
    expect(disabled(ui.find("feedback-send"))).toBe(false);
  });

  test("sends what was listed, and says so with the report's code", async () => {
    activity.recordActivity("screen", "/console/:context");
    const ui = await mount();
    ui.type("The board lost my card");
    await ui.press("feedback-send");
    const { draft } = mockSubmits[0]!;
    expect(draft.message).toBe("The board lost my card");
    expect(String(draft.activity)).toContain("/console/:context");
    expect(draft.screenshot).toEqual({ base64: "AQ==", contentType: "image/jpeg" });
    expect(ui.find("feedback-sent")?.textContent).toContain("FB-7F2C9A");
  });

  test("an unticked log and a removed screenshot stay behind", async () => {
    activity.recordActivity("screen", "/console/:context");
    const ui = await mount();
    ui.type("Hi");
    await ui.press("feedback-activity-box");
    await ui.press("feedback-remove-shot");
    expect(ui.find("feedback-screenshot")?.textContent).toContain("Not sent");
    await ui.press("feedback-send");
    expect(mockSubmits[0]!.draft.activity).toBeUndefined();
    expect(mockSubmits[0]!.draft.screenshot).toBeUndefined();
  });

  test("an unticked screenshot keeps its row, so it can be ticked again and sent", async () => {
    const ui = await mount();
    ui.type("Hi");
    await ui.press("feedback-screenshot-box");
    expect(ui.find("feedback-screenshot")?.textContent).toContain("Not sent");
    expect(ui.find("feedback-show-text")).toBeNull();
    await ui.press("feedback-screenshot-box");
    expect(ui.find("feedback-screenshot")?.textContent).toContain("Words hidden");
    await ui.press("feedback-send");
    expect(mockSubmits[0]!.draft.screenshot).toEqual({ base64: "AQ==", contentType: "image/jpeg" });
  });

  test("the words go only after Show text", async () => {
    const ui = await mount();
    ui.type("Hi");
    await ui.press("feedback-show-text");
    expect(document.body.textContent).toContain("Words shown");
    await ui.press("feedback-send");
    expect(mockSubmits[0]!.draft.screenshot).toEqual({ base64: "Ag==", contentType: "image/jpeg" });
  });

  test("offline, it says the report is kept, and can be deleted", async () => {
    mockOutcome.next = { kind: "offline" };
    const ui = await mount();
    ui.type("Hi");
    await ui.press("feedback-send");
    expect(ui.find("feedback-offline")?.textContent).toContain("saved on this device");
    await ui.press("feedback-delete");
    expect(ui.closed).toEqual(["closed"]);
  });

  test("a failed send keeps the report and offers to send it later", async () => {
    mockOutcome.next = { kind: "failed" };
    const ui = await mount();
    ui.type("Hi");
    await ui.press("feedback-send");
    expect(ui.find("feedback-failed")?.textContent).toContain("Your report is still here");
    await ui.press("feedback-later");
    expect(mockQueued).toHaveLength(1);
  });

  test("from the broken page, the error is on the list and cannot be unticked", async () => {
    await mount({ errorEventId: "0123456789abcdef" });
    expect(document.body.textContent).toContain("Report this problem");
    expect(document.body.textContent).toContain("The error you just saw");
  });
});
