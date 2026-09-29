/**
 * @jest-environment jsdom
 */

/**
 * The in-app message path, actually rendered: several messages asking at
 * once, one provider deciding (`features/messages/`).
 *
 * `inAppMessages.test.ts` has the rules; this proves the wiring carries them —
 * that a message which asks through the hooks is really held back, really
 * remembered on the account, and really carried up from a device.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   `useMessageSlot` ignoring the provider's pick                     1
 *   the carry-up effect removed                                       1
 *   dismiss not telling the account                                   1
 *   dismiss not keeping the device copy                               1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockMarks: unknown[] = [];

jest.mock("convex/react", () => ({
  useMutation: () => async (args: unknown) => {
    mockMarks.push(args);
    return null;
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MessagesProvider } from "../features/messages/MessagesProvider";
import { useInAppMessage, useMessageSlot } from "../features/messages/useInAppMessage";

const BETA_KEY = "test.beta.seen";
const OFFER_KEY = "test.offer.seen";

function Beta() {
  const message = useInAppMessage({ id: "beta-notice", eligible: true, deviceKey: BETA_KEY });
  return message.visible
    ? createElement("button", { "data-testid": "beta", onClick: message.dismiss }, "Got it")
    : null;
}

function Setup({ retired }: { retired: boolean }) {
  const { visible } = useMessageSlot({ id: "setup-checklist", workspaceId: "w1", eligible: true, seen: retired });
  return visible ? createElement("div", { "data-testid": "setup" }) : null;
}

function Offer() {
  const message = useInAppMessage({
    id: "storage-layout-offer",
    workspaceId: "w1",
    eligible: true,
    deviceKey: OFFER_KEY,
  });
  return message.visible
    ? createElement("button", { "data-testid": "offer", onClick: message.dismiss }, "Not now")
    : null;
}

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  window.localStorage.clear();
  mockMarks.length = 0;
});

async function mount(reads: unknown, children: ReactNode[]): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(createElement(MessagesProvider, { reads, children }));
  });
  // The device reads, then the provider's pick.
  await act(async () => {});
  await act(async () => {});
}

const shown = (id: string) => document.querySelector(`[data-testid="${id}"]`) !== null;

async function press(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (node === null) throw new Error(`nothing called ${id}`);
  await act(async () => {
    node.click();
  });
  await act(async () => {});
}

describe("several messages asking at once", () => {
  test("one at a time: the beta notice, then the setup checklist, and the tip waits for another visit", async () => {
    await mount([], [
      createElement(Offer, { key: "o" }),
      createElement(Setup, { key: "s", retired: false }),
      createElement(Beta, { key: "b" }),
    ]);
    expect([shown("beta"), shown("setup"), shown("offer")]).toEqual([true, false, false]);

    await press("beta");
    expect([shown("beta"), shown("setup"), shown("offer")]).toEqual([false, true, false]);
  });

  test("a tip alone in a visit is shown", async () => {
    await mount([], [createElement(Offer, { key: "o" }), createElement(Setup, { key: "s", retired: true })]);
    expect(shown("offer")).toBe(true);
  });

  test("nothing is shown before the account has answered", async () => {
    await mount(undefined, [createElement(Beta, { key: "b" })]);
    expect(shown("beta")).toBe(false);
  });
});

describe("answers belong to the account", () => {
  test("answered on another device: not shown here", async () => {
    const reads = [{ message: "beta-notice", workspaceId: null, variant: null, seenAt: 1 }];
    await mount(reads, [createElement(Beta, { key: "b" })]);
    expect(shown("beta")).toBe(false);
    expect(mockMarks).toEqual([]);
  });

  test("answered only on this device: not shown, and carried up to the account", async () => {
    window.localStorage.setItem(BETA_KEY, "2026-09-01T00:00:00.000Z");
    await mount([], [createElement(Beta, { key: "b" })]);
    expect(shown("beta")).toBe(false);
    expect(mockMarks).toEqual([{ message: "beta-notice" }]);
  });

  test("answering keeps it on the account and on this device", async () => {
    await mount([], [createElement(Offer, { key: "o" })]);
    await press("offer");
    expect(shown("offer")).toBe(false);
    expect(mockMarks).toEqual([{ message: "storage-layout-offer", workspaceId: "w1" }]);
    expect(window.localStorage.getItem(OFFER_KEY)).not.toBeNull();
  });

  test("a backend that cannot answer leaves this device's copy to decide", async () => {
    await mount(new Error("no such function"), [createElement(Beta, { key: "b" })]);
    expect(shown("beta")).toBe(true);
  });
});
