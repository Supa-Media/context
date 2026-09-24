/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

/**
 * The control plane, as `ThisMachineCard` reaches it.
 *
 * The card now answers the machine approval the shell parks, which means one
 * action and one auth reading. Both are staged rather than provided, because
 * what is being checked is a *decision* — whether this page mints a credential,
 * and what it tells the shell — and a real Convex client would make that a
 * question about a network.
 */
let mockAuthState = { isLoading: false, isAuthenticated: true };
let mockMintCalls: { requestId: string }[] = [];
let mockMintAnswer: (args: { requestId: string }) => Promise<unknown> = async () => ({
  redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
  workspaceSlug: "seyi",
});

jest.mock("convex/react", () => ({
  useConvexAuth: () => mockAuthState,
  useAction: () => (args: { requestId: string }) => {
    mockMintCalls.push(args);
    return mockMintAnswer(args);
  },
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { ThisMachineCard } =
  require("../../features/meetings/components/ThisMachineCard") as typeof import("../../features/meetings/components/ThisMachineCard");
/* eslint-enable @typescript-eslint/no-require-imports */

import {
  describeMachine,
  has,
  installShell,
  machineTitle,
  mount,
  resetDesktop,
  teardownDesktop,
} from "./fixtures";

/**
 * The machine's own card, in settings. See `fixtures.ts` for the fake shell
 * and the sabotage record that proves it.
 */

beforeEach(() => {
  resetDesktop();
  mockAuthState = { isLoading: false, isAuthenticated: true };
  mockMintCalls = [];
  mockMintAnswer = async () => ({
    redirectTo: "http://127.0.0.1:53411/context-hook/callback?code=fake&state=fake",
    workspaceSlug: "seyi",
  });
});

afterEach(() => {
  teardownDesktop();
});

describe("this machine, in settings", () => {
  test("a machine with no grant is offered one, and told what it gets", () => {
    const view = describeMachine({
      state: "disconnected",
      gateway: null,
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.action).toBe("connect");
    expect(view.pill).toBe("Not connected");
  });

  /**
   * `revoked` is not `disconnected`, and this is the reason it is worth a
   * separate word: only one of them has finished meetings waiting on a button.
   */
  test("a revoked machine says the queue is waiting", () => {
    const view = describeMachine({
      state: "revoked",
      gateway: "https://gateway.invalid",
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.tone).toBe("warn");
    expect(view.sentence).toMatch(/queued/i);
    expect(view.action).toBe("connect");
  });

  test("a connected machine says where meetings go, and never how", () => {
    const view = describeMachine({
      state: "connected",
      gateway: "https://gateway.invalid/mcp",
      encrypted: true,
      connecting: false,
      error: null,
    });
    expect(view.sentence).toContain("https://gateway.invalid/mcp");
    expect(view.action).toBe("disconnect");
    expect(JSON.stringify(view)).not.toMatch(/token|secret|credential/i);
  });

  test("a machine with no encrypted storage is told so before it connects", () => {
    const view = describeMachine({
      state: "disconnected",
      gateway: null,
      encrypted: false,
      connecting: false,
      error: null,
    });
    expect(view.notice).toMatch(/encrypted storage/i);
  });

  test("the heading names the kind of machine, never the machine", () => {
    expect(machineTitle({ app: "Context", version: "1.0.0", platform: "macos" })).toBe(
      "Context on this Mac",
    );
    expect(machineTitle(null)).toBe("This machine");
  });

  test("the card is not drawn in a browser", () => {
    const mounted = mount(createElement(ThisMachineCard));
    expect(mounted.container.textContent).toBe("");
    mounted.unmount();
  });

  test("...and in a shell it draws the connection, from the bridge", async () => {
    const shell = fakeDesktopBridge({
      connection: {
        state: "connected",
        gateway: "https://gateway.invalid",
        encrypted: true,
        connecting: false,
        error: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
    });

    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(mounted.container.textContent).toContain("https://gateway.invalid");

    const button = mounted.container.querySelector('[data-testid="this-machine-disconnect"]');
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(shell.calls).toContain("connection.disconnect");

    mounted.unmount();
    // Unmounting detaches: a settings pane is opened and closed all day, and a
    // handler that could not be detached is a leak per visit.
    expect(shell.listenerCount()).toBe(0);
  });

  test("the desktop integration card exposes iMessage import from the bridge", async () => {
    const shell = fakeDesktopBridge({
      imessage: {
        enabled: false,
        permission: "granted",
        lastSyncedAt: null,
        lastError: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(has(mounted.container, "this-machine-imessage")).toBe(true);
    expect(mounted.container.textContent).toContain("iMessage");
    expect(mounted.container.textContent).toContain("Import is off on this Mac.");

    const button = mounted.container.querySelector(
      '[data-testid="this-machine-imessage-toggle"]',
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(shell.imessageSetEnabledCalls).toEqual([true]);

    mounted.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  test("a denied iMessage grant explains the exact recovery and opens Full Disk Access", async () => {
    const shell = fakeDesktopBridge({
      imessage: {
        enabled: true,
        permission: "denied",
        lastSyncedAt: null,
        lastError: null,
      },
    });
    installShell(shell);

    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(has(mounted.container, "this-machine-imessage-permission-guide")).toBe(true);
    expect(mounted.container.textContent).toContain("Privacy & Security → Full Disk Access");
    expect(mounted.container.textContent).toContain("quit and reopen");
    expect(has(mounted.container, "this-machine-imessage-toggle")).toBe(false);

    const open = mounted.container.querySelector('[data-testid="this-machine-imessage-open-settings"]');
    await act(async () => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(shell.imessageFullDiskAccessRequests).toBe(1);

    mounted.unmount();
  });

  test("the first permission refusal raises the guide without waiting for another click", async () => {
    const shell = fakeDesktopBridge({
      imessage: {
        enabled: true,
        permission: "unknown",
        lastSyncedAt: null,
        lastError: null,
      },
    });
    installShell(shell);
    const mounted = mount(createElement(ThisMachineCard));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      shell.emitImessage({
        enabled: true,
        permission: "denied",
        lastSyncedAt: null,
        lastError: null,
      });
      await Promise.resolve();
    });
    expect(shell.imessageFullDiskAccessRequests).toBe(1);

    // A later status heartbeat in the same denied state must not stack sheets.
    await act(async () => {
      shell.emitImessage({
        enabled: true,
        permission: "denied",
        lastSyncedAt: null,
        lastError: null,
      });
      await Promise.resolve();
    });
    expect(shell.imessageFullDiskAccessRequests).toBe(1);
    mounted.unmount();
  });

  /*
    One machine, two settings panels.

    Settings asks about recording under **Meetings** and about Messages under
    **Chats**, because a person looking for their texts does not think
    "meetings". This card is the one place both live, so it takes a `focus`
    rather than being split — and what makes that safe is that the two halves
    are not symmetrical. Both spend the *same* machine grant (`apps/desktop`'s
    iMessage import writes through `write_note` with this machine's token), so
    Chats cannot simply drop the connection state: an unconnected machine is
    precisely why somebody's messages are not arriving.
  */
  const IMESSAGE_SHELL = {
    enabled: false,
    permission: "granted" as const,
    lastSyncedAt: null,
    lastError: null,
  };

  async function machine(focus: "meetings" | "chats" | undefined, shell: FakeDesktopBridge) {
    installShell(shell);
    const mounted = mount(createElement(ThisMachineCard, focus === undefined ? {} : { focus }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return mounted;
  }

  test("Meetings is the machine without the Messages half", async () => {
    const mounted = await machine(
      "meetings",
      fakeDesktopBridge({ imessage: { ...IMESSAGE_SHELL, enabled: true } }),
    );

    expect(has(mounted.container, "this-machine-title")).toBe(true);
    expect(has(mounted.container, "this-machine-imessage")).toBe(false);
    expect(mounted.container.textContent).not.toContain("iMessage");

    mounted.unmount();
  });

  test("Chats keeps Messages and drops the meetings sentence", async () => {
    const mounted = await machine(
      "chats",
      fakeDesktopBridge({
        imessage: IMESSAGE_SHELL,
        connection: {
          state: "connected",
          gateway: "https://gateway.invalid",
          encrypted: true,
          connecting: false,
          error: null,
        },
      }),
    );

    expect(has(mounted.container, "this-machine-imessage")).toBe(true);
    expect(mounted.container.textContent).toContain("Import is off on this Mac.");
    // The machine's own copy is about meetings, because that is what the grant
    // was built for. Under a Chats heading it answers a question nobody asked.
    expect(mounted.container.textContent).not.toContain("Meetings recorded here go to");
    // And Disconnect stops meetings too, so it lives on the panel that says so.
    expect(has(mounted.container, "this-machine-disconnect")).toBe(false);

    mounted.unmount();
  });

  test("...and says an unconnected machine is why nothing is arriving, with the way out", async () => {
    const mounted = await machine("chats", fakeDesktopBridge({ imessage: IMESSAGE_SHELL }));

    expect(mounted.container.textContent).toContain("nothing arrives until it is connected");
    // The one control that unblocks Messages is here, unlike Disconnect.
    expect(has(mounted.container, "this-machine-connect")).toBe(true);

    mounted.unmount();
  });

  test("Chats draws nothing at all where the shell has no Messages support", async () => {
    // A card headed with this Mac's name over one blank line is a worse answer
    // than no card — the same rule the settings sections themselves follow.
    const mounted = await machine("chats", fakeDesktopBridge({ noImessage: true }));

    expect(mounted.container.textContent).toBe("");

    mounted.unmount();
  });
});

/* -------------------------------------------------------------------------- */
