/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, test } from "@jest/globals";

/**
 * Invite friends, drawn: what it shows for each state the server can be in,
 * and that Cancel asks the server rather than editing the list itself. And the
 * end-of-setup card's two new rows, which appear only when there is something
 * behind them.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { InviteFriendsDialog } from "../features/referrals/InviteFriendsDialog";
import { SetupDone } from "../features/console/setupWidget/SetupDone";
import type { MyInvites } from "../features/referrals/invites";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mutations: Array<{ name: string; args: unknown }> = [];

function clientAnswering(mine: MyInvites | null) {
  return {
    watchQuery: (ref: never) => ({
      localQueryResult: () => (getFunctionName(ref) === "functions/referrals:mine" ? mine : undefined),
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
    mutation: async (ref: never, args: unknown) => {
      mutations.push({ name: getFunctionName(ref), args });
      return { changed: true };
    },
    action: async () => ({}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    byId,
    text: () => document.body.textContent ?? "",
    press: async (id: string) => {
      const target = byId(id);
      if (target === null) throw new Error(`nothing to press: ${id}`);
      await act(async () => {
        target.click();
      });
    },
  };
}

const base: MyInvites = { off: false, locked: null, unlocksAt: null, total: 3, left: 1, invites: [] };

function dialog(mine: MyInvites | null) {
  return mount(
    createElement(ConvexProvider, { client: clientAnswering(mine) }, createElement(InviteFriendsDialog, { onClose: () => {} })),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  mutations = [];
});

describe("Invite friends", () => {
  test("lists what happened to each invite, and Cancel asks the server", async () => {
    const view = dialog({
      ...base,
      invites: [
        { id: "a", email: "jon@studio.test", status: "joined", sentAt: 0, expiresAt: 1, cancelledAt: null, joinedHandle: "jon" },
        { id: "b", email: "lee@north.test", status: "pending", sentAt: 0, expiresAt: 1, cancelledAt: null, joinedHandle: null },
      ],
    });
    expect(view.text()).toContain("Joined as @jon");
    expect(view.byId("invite-email")).not.toBeNull();
    await view.press("invite-cancel");
    expect(mutations).toEqual([{ name: "functions/referrals:cancel", args: { inviteId: "b" } }]);
    expect(view.byId("invite-undo")).not.toBeNull();
  });

  test("says what stops a send instead of offering the field", () => {
    const locked = dialog({ ...base, locked: "setup" });
    expect(locked.byId("invite-email")).toBeNull();
    expect(locked.byId("invite-blocker")?.textContent).toMatch(/Connect Claude/);
    document.body.innerHTML = "";
    const spent = dialog({ ...base, left: 0 });
    expect(spent.byId("invite-blocker")?.textContent).toMatch(/used all 3/);
  });

  test("with nothing sent yet, says where invites will show", () => {
    expect(dialog(base).text()).toContain("People you invite show up here.");
  });
});

describe("You're set up.", () => {
  const props = { onClose: () => {}, onCopyBootstrap: async () => true };

  test("has no community or invite rows when there is nothing behind them", () => {
    const view = mount(createElement(SetupDone, props));
    expect(view.byId("setup-done-community")).toBeNull();
    expect(view.byId("setup-done-invite")).toBeNull();
  });

  test("offers Discord and the invites left when they exist", () => {
    const view = mount(
      createElement(SetupDone, { ...props, onJoinCommunity: () => {}, invitesLeft: 3, onInviteFriends: () => {} }),
    );
    expect(view.byId("setup-done-community")).not.toBeNull();
    expect(view.text()).toContain("You have 3 invites");
  });
});
