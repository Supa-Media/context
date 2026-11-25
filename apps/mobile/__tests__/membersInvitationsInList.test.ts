/**
 * @jest-environment jsdom
 */
/**
 * Sent invitations sit in the people list (settings cleanup, 2026-09-29).
 *
 * They were a card of their own titled "Invitations", beside the account row of
 * the same name about invitations *to* you: one word for two lists.
 */
import { afterEach, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {},
  useMutation: () => async () => {},
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MembersSection } from "../features/console/members/MembersSection";
import type { MembersView } from "../features/console/members/members";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function render(view: MembersView): HTMLElement {
  return mountSection(view);
}

function mountSection(view: MembersView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(MembersSection, { view })));
  return container;
}

const view = (invitations: MembersView["invitations"]): MembersView => ({
  members: [
    { userId: "u1", role: "owner", name: "Seyi", email: "seyi@example.com", joinedAt: 0, isMe: true },
  ],
  invitations,
  loading: false,
  failure: null,
});

test("a sent invitation is a row in the people list, with no second heading", () => {
  const host = render(
    view([{ invitationId: "i1", invitee: "@tomi", role: "editor", expiresAt: Date.now() + 5 * 86_400_000 }]),
  );
  const text = host.textContent ?? "";
  expect(text).toContain("@tomi");
  expect(text).toContain("Invited to edit · expires in");
  expect(text).not.toContain("Invitations");
});

test("with nothing sent there is no empty invitations card", () => {
  const host = render(view([]));
  expect(host.textContent ?? "").not.toContain("Nobody is waiting on an invitation.");
});

const click = (host: HTMLElement, testID: string) =>
  act(() => (host.querySelector(`[data-testid="${testID}"]`) as HTMLElement).click());

function withActions(options: { iAmOwner?: boolean; coOwnersAllowed?: boolean } = {}): { view: MembersView; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    view: {
      ...view([{ invitationId: "i1", invitee: "@tomi", role: "member", expiresAt: Date.now() + 86_400_000 }]),
      members: [
        { userId: "u1", role: "owner", name: "Seyi", email: "seyi@example.com", joinedAt: 0, isMe: options.iAmOwner ?? true, isOwner: true },
        { userId: "u2", role: "editor", name: "LK", email: "lk@example.com", joinedAt: 1, isMe: false },
        { userId: "u3", role: "owner", name: "Sayo", email: "sayo@example.com", joinedAt: 2, isMe: options.iAmOwner === false, isOwner: false },
      ],
      actions: {
        invite: async (who, role) => void calls.push(`invite ${who} ${role}`),
        remove: async (id) => void calls.push(`remove ${id}`),
        setRole: async (id, role) => void calls.push(`role ${id} ${role}`),
        withdraw: async (id) => void calls.push(`withdraw ${id}`),
        setOwnerRole: async (id, role) => void calls.push(`owner-role ${id} ${role}`),
        handOver: async (id) => void calls.push(`hand-over ${id}`),
        iAmOwner: options.iAmOwner ?? true,
        coOwnersAllowed: options.coOwnersAllowed ?? true,
      },
    },
  };
}

test("a role is a menu in the artboard's words, and changing it calls setRole", async () => {
  const { view: v, calls } = withActions();
  const host = mountSection(v);
  // The owner's own row has no menu, only the word.
  expect(host.querySelector('[data-testid="member-role-u1"]')).toBeNull();
  expect(host.textContent ?? "").toContain("Owner");
  expect(host.querySelector('[data-testid="member-role-u2"]')?.textContent).toContain("Can edit");
  click(host, "member-role-u2");
  await act(async () => {
    (host.querySelector('[data-testid="member-role-u2-option-member"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["role u2 member"]);
});

test("Remove in the menu only arms; the Confirm beside it removes", async () => {
  const { view: v, calls } = withActions();
  const host = mountSection(v);
  click(host, "member-role-u2");
  click(host, "member-role-u2-option-remove");
  expect(calls).toEqual([]);
  expect(host.textContent ?? "").toContain("cuts off every AI client");
  await act(async () => {
    (host.querySelector('[data-testid="member-remove-u2"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["remove u2"]);
});

test("the invite form opens from + Invite, and Cancel invite withdraws", async () => {
  const { view: v, calls } = withActions();
  const host = mountSection(v);
  expect(host.querySelector('[data-testid="members-invite-form"]')).toBeNull();
  click(host, "members-invite-open");
  expect(host.querySelector('[data-testid="members-invite-form"]')).not.toBeNull();
  await act(async () => {
    (host.querySelector('[data-testid="invitation-withdraw-i1"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["withdraw i1"]);
});

test("a member sees words, never a menu or an invite button", () => {
  const host = mountSection({ ...withActions().view, actions: undefined });
  expect(host.querySelector('[data-testid^="member-role-"]')).toBeNull();
  expect(host.querySelector('[data-testid="members-invite-open"]')).toBeNull();
  expect(host.textContent ?? "").toContain("Can edit");
});

test("the owner makes a co-owner: Co-owner… only arms, says what they get, and Confirm makes them one", async () => {
  const { view: v, calls } = withActions();
  const host = mountSection(v);
  expect(host.querySelector('[data-testid="member-role-u3"]')?.textContent).toContain("Co-owner");
  click(host, "member-role-u2");
  click(host, "member-role-u2-option-co-owner");
  expect(calls).toEqual([]);
  expect(host.textContent ?? "").toContain("will see every private note");
  await act(async () => {
    (host.querySelector('[data-testid="member-co-owner-u2"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["owner-role u2 owner"]);
});

test("the owner hands over to a co-owner after a red Confirm, or steps them down", async () => {
  const { view: v, calls } = withActions();
  const host = mountSection(v);
  click(host, "member-role-u3");
  click(host, "member-role-u3-option-hand-over");
  expect(host.textContent ?? "").toContain("becomes the owner and you become a co-owner");
  await act(async () => {
    (host.querySelector('[data-testid="member-hand-over-u3"]') as HTMLElement).click();
  });
  click(host, "member-role-u3");
  await act(async () => {
    (host.querySelector('[data-testid="member-role-u3-option-member"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["hand-over u3", "owner-role u3 member"]);
});

test("a co-owner sees no co-owner choices on others, and can step themself down", async () => {
  const { view: v, calls } = withActions({ iAmOwner: false });
  const host = mountSection(v);
  expect(host.querySelector('[data-testid="member-role-u1"]')).toBeNull();
  click(host, "member-role-u2");
  expect(host.querySelector('[data-testid="member-role-u2-option-co-owner"]')).toBeNull();
  click(host, "member-role-u3");
  await act(async () => {
    (host.querySelector('[data-testid="member-role-u3-option-step-down"]') as HTMLElement).click();
  });
  expect(calls).toEqual(["owner-role u3 editor"]);
});

test("a personal workspace offers no Co-owner…", () => {
  const host = mountSection(withActions({ coOwnersAllowed: false }).view);
  click(host, "member-role-u2");
  expect(host.querySelector('[data-testid="member-role-u2-option-co-owner"]')).toBeNull();
});
