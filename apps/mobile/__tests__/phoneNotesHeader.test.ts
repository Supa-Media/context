/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * **The phone's first page is Notes, with how much is downloaded under it**
 * (Dev2, 2026-10-18): "the header being inbox is a little weird when it's not
 * actually the inbox folder", then "under it can have a clickable number of
 * notes downloaded underneath notes, and get rid of the ugly pill in the top
 * right".
 *
 * SABOTAGE: drawing "Inbox" again fails the first test; dropping
 * `onDownloads` from the line fails the second.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PhoneInbox } = require("../features/console/home/PhoneInbox") as typeof import("../features/console/home/PhoneInbox");

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

function page(extra: Record<string, unknown>) {
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() =>
    root.render(
      createElement(PhoneInbox, {
        source: { notes: [{ path: "0-inbox/a.md", title: "A", lede: null, tags: [] }], folders: ["0-inbox"], shared: new Set() },
        opened: [],
        entries: [],
        isMe: () => true,
        onOpen: (path: string) => opened.push(path),
        onAll: () => {},
        ...extra,
      } as never),
    ),
  );
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { container, find, opened };
}

describe("the phone's Notes title", () => {
  test("says Notes, and its Inbox count still opens the Inbox folder", () => {
    const ui = page({});
    expect(ui.container.querySelector('[role="heading"]')?.textContent).toBe("Notes");
    act(() => ui.find("phone-inbox-count")!.click());
    expect(ui.opened).toEqual(["0-inbox"]);
  });

  test("has the downloaded count under it, which opens Downloads", () => {
    let shown = 0;
    const ui = page({ downloaded: "1,204 notes downloaded", onDownloads: () => (shown += 1) });
    const line = ui.find("phone-notes-downloaded")!;
    expect(line.textContent).toBe("1,204 notes downloaded");
    act(() => line.click());
    expect(shown).toBe(1);
  });

  test("and no line where the device keeps no copy", () => {
    expect(page({ downloaded: null }).find("phone-notes-downloaded")).toBeNull();
  });
});

describe("while notes are coming down", () => {
  test("a spinner sits beside the downloaded count, and goes when they are down", () => {
    expect(page({ downloaded: "3 of 9 notes downloaded", downloading: true }).find("phone-notes-downloading")).not.toBeNull();
    expect(page({ downloaded: "9 notes downloaded", downloading: false }).find("phone-notes-downloading")).toBeNull();
  });

  test("a row's first line loads behind a quiet bar, then shows", async () => {
    // Dev2 2026-10-18: "if it's still being downloaded maybe we should have UI to show that it's loading".
    require("../features/console/home/noteLedes").forgetNoteLedes();
    let answer: (value: unknown) => void = () => {};
    const ledeSource = {
      load: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    };
    const ui = page({ ledeSource, recents: [{ path: "0-inbox/a.md", at: Date.now(), kind: "edited" }] });
    const row = () => ui.container.querySelector<HTMLElement>('[data-testid="phone-inbox-note"]')!;
    expect(ui.find("phone-inbox-lede-loading")).not.toBeNull();
    await act(async () => {
      answer({ complete: true, notes: [{ path: "0-inbox/a.md", properties: {}, heading: null, lede: "Call the venue" }] });
    });
    expect(ui.find("phone-inbox-lede-loading")).toBeNull();
    expect(row().textContent).toContain("Call the venue");
  });
});
