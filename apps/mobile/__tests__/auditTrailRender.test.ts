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
import { AdvancedPanel } from "../features/console/settings/panels/AdvancedPanel";
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
      createElement(AdvancedPanel, {
        view: {
          moves: { jobs: [], loading: false, failure: null },
          audit: { events, loading: false, failure: null },
          keyExport: undefined,
        },
      }),
    );
  });
  return container;
}

const HOUR = 3_600_000;

describe("the audit trail panel", () => {
  test("a run of identical renewals draws as one row with a count, and the edit keeps its own", () => {
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
      renewal("r2", HOUR),
      renewal("r3", 2 * HOUR),
      {
        eventId: "w1",
        action: "file.write",
        actorUserId: "u1",
        actorEmail: "owner@example.test",
        paths: ["1-projects/plan.md"],
        at: now - 3 * HOUR,
      },
    ]);

    const rows = container.querySelectorAll('[data-testid="audit-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Renewed the in-app agent's sign-in");
    expect(rows[0]?.textContent).toContain("3 times · 2 hours ago to just now");
    expect(rows[1]?.textContent).toContain("Edited a note");
    expect(rows[1]?.textContent).toContain("1-projects/plan.md");
  });
});
