/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import type { MessagesBackupView } from "@context/desktop-bridge";
import { fakeDesktopBridge, type FakeDesktopBridge } from "@context/desktop-bridge/fake";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useAction: () => async () => undefined,
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { MessagesPanel } =
  require("../../features/console/settings/panels/MessagesPanel") as typeof import("../../features/console/settings/panels/MessagesPanel");
const { MessagesBackupCard } =
  require("../../features/messagesBackup/MessagesBackupCard") as typeof import("../../features/messagesBackup/MessagesBackupCard");
/* eslint-enable @typescript-eslint/no-require-imports */

import { has, installShell, mount, resetDesktop, teardownDesktop } from "./fixtures";

/**
 * Settings › Messages and the first-run card, over the package's fake shell
 * (boards 1 and 2 of the Messages backup, approved by the owner 2026-10-26).
 *
 * Sabotage record, as temporary edits:
 *
 *   the switch calling setEnabled with the value it already has           1
 *   the card's Turn off doing nothing                                       1
 *   (the phase and outdated rows are in `messagesBackupView.test.ts`)
 */

const VIEW: MessagesBackupView = {
  phase: "copying",
  copiedRows: 10,
  totalRows: 40,
  reachedBack: Date.parse("2024-03-14T10:00:00Z"),
  problem: null,
  account: "+1 ••• 4410",
  machine: "MacBook Pro",
};

function shellWith(view: Partial<MessagesBackupView> | null, enabled = true): FakeDesktopBridge {
  return fakeDesktopBridge({
    imessage: {
      enabled,
      permission: view?.phase === "needs_permission" ? "denied" : "granted",
      lastSyncedAt: null,
      lastError: null,
      ...(view === null ? {} : { backup: { ...VIEW, ...view } }),
    },
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function press(root: ParentNode, testId: string) {
  const target = root.querySelector(`[data-testid="${testId}"]`);
  act(() => {
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  resetDesktop();
});

afterEach(() => {
  teardownDesktop();
});

describe("Settings › Messages", () => {
  test("names whose texts and which Mac, and how far the copy has got", async () => {
    installShell(shellWith({}));
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    expect(mounted.container.textContent).toContain("Texts for +1 ••• 4410 · MacBook Pro");
    expect(mounted.container.textContent).toContain("Copying, newest first");
    expect(mounted.container.textContent).toContain("10 of 40 messages · back to March 2024 so far");
    expect(mounted.container.textContent).toContain("Never Tex in a group chat.");
    mounted.unmount();
  });

  test("the switch turns the backup off on the Mac", async () => {
    const shell = shellWith({});
    installShell(shell);
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    press(mounted.container, "messages-switch");
    await settle();
    expect(shell.imessageSetEnabledCalls).toEqual([false]);
    expect(mounted.container.textContent).toContain("What's already copied stays");
    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  test("waiting for Full Disk Access offers the pane that grants it", async () => {
    const shell = shellWith({ phase: "needs_permission" });
    installShell(shell);
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    expect(mounted.container.textContent).toContain("Waiting for Full Disk Access");
    press(mounted.container, "messages-open-settings");
    await settle();
    expect(shell.imessageFullDiskAccessRequests).toBe(1);
    mounted.unmount();
  });

  test("an unconnected Mac says that is why nothing is copied, with the way out", async () => {
    installShell(shellWith({ phase: "not_connected" }));
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    expect(mounted.container.textContent).toContain("nothing is copied until it is connected");
    expect(has(mounted.container, "this-machine-connect")).toBe(true);
    mounted.unmount();
  });

  test("a Mac app from before the backup is asked to update, and offered no switch", async () => {
    installShell(shellWith(null));
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    expect(has(mounted.container, "messages-outdated")).toBe(true);
    expect(has(mounted.container, "messages-switch")).toBe(false);
    mounted.unmount();
  });

  test("in a browser, the page says where the backup is turned on", async () => {
    const mounted = mount(createElement(MessagesPanel, { owned: true }));
    await settle();

    expect(has(mounted.container, "messages-not-on-mac")).toBe(true);
    mounted.unmount();
  });

  test("an account with no workspace of its own has nowhere to keep texts", async () => {
    installShell(shellWith({}));
    const mounted = mount(createElement(MessagesPanel, { owned: false }));
    await settle();

    expect(has(mounted.container, "messages-no-workspace")).toBe(true);
    expect(has(mounted.container, "messages-switch")).toBe(false);
    mounted.unmount();
  });
});

describe("the first-run card", () => {
  test("is up while the backup is on and waiting, with the two steps and Turn off", async () => {
    const shell = shellWith({ phase: "needs_permission" });
    installShell(shell);
    const mounted = mount(createElement(MessagesBackupCard));
    await settle();

    expect(has(document.body, "messages-backup-card")).toBe(true);
    expect(document.body.textContent).toContain("Copying texts for +1 ••• 4410 on MacBook Pro");
    expect(document.body.textContent).toContain("Privacy & Security › Full Disk Access");

    press(document.body, "messages-backup-card-open");
    await settle();
    expect(shell.imessageFullDiskAccessRequests).toBe(1);

    press(document.body, "messages-backup-card-off");
    await settle();
    expect(shell.imessageSetEnabledCalls).toEqual([false]);
    expect(has(document.body, "messages-backup-card")).toBe(false);
    mounted.unmount();
  });

  test("goes for good once the permission lands", async () => {
    const shell = shellWith({ phase: "needs_permission" });
    installShell(shell);
    const mounted = mount(createElement(MessagesBackupCard));
    await settle();
    expect(has(document.body, "messages-backup-card")).toBe(true);

    await act(async () => {
      shell.emitImessage({ enabled: true, permission: "granted", lastSyncedAt: null, lastError: null, backup: VIEW });
      await Promise.resolve();
    });
    expect(has(document.body, "messages-backup-card")).toBe(false);
    mounted.unmount();
  });

  test("is never up while copying, when off, or on a Mac app from before the backup", async () => {
    for (const shell of [shellWith({}), shellWith({ phase: "needs_permission" }, false), shellWith(null)]) {
      resetDesktop();
      installShell(shell);
      const mounted = mount(createElement(MessagesBackupCard));
      await settle();
      expect(has(document.body, "messages-backup-card")).toBe(false);
      mounted.unmount();
    }
  });
});
