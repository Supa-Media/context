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
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(MembersSection, { view, viewerRole: "owner" })));
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
  expect(text).toContain("Invited as editor");
  expect(text).not.toContain("Invitations");
  expect(host.querySelector('[data-testid="members-invited-count"]')?.textContent).toBe("1 invited");
});

test("with nothing sent there is no invited count and no empty invitations card", () => {
  const host = render(view([]));
  const text = host.textContent ?? "";
  expect(host.querySelector('[data-testid="members-invited-count"]')).toBeNull();
  expect(text).not.toContain("Nobody is waiting on an invitation.");
});
