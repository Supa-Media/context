/**
 * @jest-environment jsdom
 */

/**
 * The audit trail's folding, actually drawn: the pure grouping is pinned in
 * `auditGroups.test.ts`, and this proves the panel uses it. Without this, the
 * panel could go back to mapping `view.events` directly and every pure test
 * would stay green while the wall of renewals came back.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ActivityPanel } from "../features/console/settings/panels/ActivityPanel";
import type { ConsoleAuditEvent } from "../features/console/advanced/advanced";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mountTrail(events: ConsoleAuditEvent[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ActivityPanel, {
        view: { events, loading: false, failure: null },
        members: [{ userId: "u1", role: "owner", name: "Sam", joinedAt: 0, isMe: true }],
        sectioned: true,
      }),
    );
  });
  return container;
}

/** Text as read, without the isolates that wrap every name somebody else chose. */
const plain = (text: string | null | undefined) => (text ?? "").replace(/[\u2066-\u2069]/g, "");

describe("the activity panel", () => {
  test("routine sign-ins are hidden until asked for, then fold into one row", () => {
    const now = Date.now();
    const renewal = (id: string, ago: number): ConsoleAuditEvent => ({
      eventId: id,
      action: "agent.session.renewed",
      actorUserId: "u1",
      actorEmail: "owner@example.test",
      paths: [],
      at: now - ago,
    });
    const container = mountTrail([
      renewal("r1", 0),
      renewal("r2", 60_000),
      renewal("r3", 120_000),
      {
        eventId: "w1",
        action: "file.write",
        actorUserId: "u1",
        actorEmail: "owner@example.test",
        paths: ["1-projects/plan.md"],
        at: now - 180_000,
      },
    ]);

    const rows = () => container.querySelectorAll('[data-testid="audit-row"]');
    const text = (row: Element | undefined) => plain(row?.textContent);
    expect(rows()).toHaveLength(1);
    expect(text(rows()[0])).toContain("Sam edited plan");
    expect(container.textContent).toContain("3 hidden");

    act(() => {
      (container.querySelector('[data-testid="activity-show-routine"]') as HTMLElement).click();
    });
    expect(rows()).toHaveLength(2);
    expect(text(rows()[0])).toContain("Sam renewed the in-app agent's sign-in");
    expect(text(rows()[0])).toContain("3 times");
  });

  test("a filter keeps only its kind of row", () => {
    const now = Date.now();
    const container = mountTrail([
      { eventId: "a", action: "member.invited", actorUserId: "u1", paths: [], at: now },
      { eventId: "b", action: "file.write", actorUserId: "u1", paths: ["x.md"], at: now - 1000 },
    ]);
    act(() => {
      (container.querySelector('[data-testid="activity-filter-people"]') as HTMLElement).click();
    });
    const rows = container.querySelectorAll('[data-testid="audit-row"]');
    expect(rows).toHaveLength(1);
    expect(plain(rows[0]?.textContent)).toContain("Sam invited somebody");
  });
});
