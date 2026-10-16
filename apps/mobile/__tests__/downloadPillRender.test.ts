/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The phone's one way in to downloads (owner, 2026-10-16), mounted: the
 * top-right pill while notes come down, and the Downloads block with a
 * Don't download button per workspace. A device that keeps a copy is the
 * case; a plain browser tab keeps none and says nothing (`mirrorSupported`).
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("../features/offline/mirrorStore", () => ({ mirrorSupported: () => true }));
const mockKv = new Map<string, string>();
jest.mock("../features/offline/store", () => ({
  openStore: () => ({
    durable: true,
    get: async (key: string) => mockKv.get(key) ?? null,
    set: async (key: string, value: string) => void mockKv.set(key, value),
    remove: async (key: string) => void mockKv.delete(key),
    keys: async () => [...mockKv.keys()],
  }),
}));

const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { SyncPill, SyncSheet } =
  require("../features/console/files/SyncSheet") as typeof import("../features/console/files/SyncSheet");
const { NO_PENDING } =
  require("../features/console/files/pendingMarks") as typeof import("../features/console/files/pendingMarks");
const { publishMirrorStatus, forgetMirrorStatus } =
  require("../features/offline/mirrorStatus") as typeof import("../features/offline/mirrorStatus");
const { isOnlineOnly, forgetDownloadChoices } =
  require("../features/offline/downloadChoice") as typeof import("../features/offline/downloadChoice");

const contexts = [
  { id: "a", slug: "supa" },
  { id: "b", slug: "seyi" },
];
const online = { reachability: "online", counts: { pending: 0, conflicted: 0, rejected: 0 }, durable: true, ready: true } as const;

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
  act(() => forgetMirrorStatus());
  forgetDownloadChoices();
  mockKv.clear();
});

function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(ThemeProvider, { scheme: "dark", children: element })));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return (testID: string) => document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

describe("downloads on the phone", () => {
  test("no pill when nothing is coming down", () => {
    publishMirrorStatus("a", { state: "synced", notes: 3, bytes: 0, lastSyncedAt: 1, total: 3 });
    const find = mount(createElement(SyncPill, { sync: online, save: null, contexts, onPress: () => {} }));
    expect(find("download-pill")).toBeNull();
    expect(find("sync-pill")).toBeNull();
  });

  test("the pill counts what is coming down", () => {
    publishMirrorStatus("a", { state: "syncing", notes: 340, bytes: 0, lastSyncedAt: null, total: 1204, remaining: 864 });
    const find = mount(createElement(SyncPill, { sync: online, save: null, contexts, onPress: () => {} }));
    expect(find("download-pill")?.textContent).toBe("340 / 1,204");
  });

  test("the count is drawn in the text colour, not left unset", () => {
    publishMirrorStatus("a", { state: "syncing", notes: 340, bytes: 0, lastSyncedAt: null, total: 1204, remaining: 864 });
    const find = mount(createElement(SyncPill, { sync: online, save: null, contexts, onPress: () => {} }));
    const words = [...find("download-pill")!.querySelectorAll<HTMLElement>("div, span")].find(
      (el) => el.textContent === "340 / 1,204" && el.children.length === 0,
    )!;
    expect(getComputedStyle(words).color).toBe("rgb(255, 255, 255)");
  });

  test("being offline still wins the pill", () => {
    publishMirrorStatus("a", { state: "syncing", notes: 340, bytes: 0, lastSyncedAt: null, total: 1204, remaining: 864 });
    const find = mount(
      createElement(SyncPill, { sync: { ...online, reachability: "offline" }, save: null, contexts, onPress: () => {} }),
    );
    expect(find("download-pill")).toBeNull();
    expect(find("sync-pill")?.textContent).toContain("Offline");
  });

  test("the sheet lists each workspace, and Don't download keeps one online", async () => {
    publishMirrorStatus("a", { state: "syncing", notes: 340, bytes: 0, lastSyncedAt: null, total: 1204, remaining: 864 });
    const find = mount(
      createElement(SyncSheet, {
        sync: online,
        save: null,
        contexts,
        pending: NO_PENDING,
        onOpen: () => {},
        onDismiss: () => {},
      }),
    );
    expect(find("download-row-a")?.textContent).toContain("340 of 1,204");
    const toggle = find("download-toggle-a")!;
    expect(toggle.textContent).toBe("Don't download");
    await act(async () => toggle.click());
    expect(isOnlineOnly("a")).toBe(true);
    expect(find("download-row-a")?.textContent).toContain("Online only");
    expect(find("download-toggle-a")?.textContent).toBe("Download");
  });
});
