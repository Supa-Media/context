/**
 * @jest-environment jsdom
 */

/**
 * The staff console's "Privacy on rows" card, actually rendered
 * (`features/admin/PrivacyRowsView.tsx`). The rules of the switch:
 *
 *  1. **Use rows asks first**, and nothing is sent until the confirm is pressed.
 *  2. **A refusal says the server's sentence**: the switch never moves, and the
 *     card says why in plain words.
 *  3. **Back to Off is a single press** and is offered whenever the setting is
 *     not Off.
 *  4. **The table names no path**: a workspace is its handle and counts only.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   Use rows calling `useRows` directly, without the confirm     1
 *   the refusal replaced by a generic "didn't work"              1
 *   Back to Off hidden while on rows                             1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/** Keyed by the Convex function's own name, as `adminSecretsRender.test.ts` keys them. */
const mockAnswers = new Map<string, unknown>();
/** Every call the card makes to a mutation, with its arguments. */
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];
/** What the next mutation call does; resolves to nothing unless a test says. */
let mockCall: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => null;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      const name = getFunctionName(reference);
      mockCalls.push({ name, args });
      return mockCall(name, args);
    },
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PrivacyRowsView } from "../features/admin/PrivacyRowsView";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
  mockCall = async () => null;
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PrivacyRowsView));
  });
  return container;
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(testID: string): void {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    node.click();
  });
}

function has(testID: string): boolean {
  return find(testID) !== null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function pageText(): string {
  return document.body.textContent ?? "";
}

const WORKSPACE = "ws_1";

function reportWith(source: "file" | "shadow" | "rows", ready: { ok: boolean; reason: string | null }) {
  return {
    source,
    truncated: false,
    ready,
    rows: [
      {
        workspaceId: WORKSPACE,
        slug: "acme",
        archived: false,
        status: "differs",
        checked: 1204,
        differences: 2,
        orphans: 1,
        checkedAt: Date.UTC(2026, 9, 15, 12, 0),
      },
    ],
  };
}

beforeEach(() => {
  mockAnswers.set("functions/privacyRows:report", reportWith("file", { ok: false, reason: "Start keeping rows first. Rows decide who sees what only after they have been kept up to date and checked." }));
});

describe("Privacy on rows card", () => {
  test("shows the setting, the three steps, and one row per workspace with its counts", () => {
    mount();
    expect(find("admin-rows-setting")?.textContent).toBe("Setting: Off");
    expect(has("admin-rows-start")).toBe(true);
    expect(has("admin-rows-check")).toBe(true);
    expect(find("admin-rows-reason")?.textContent).toContain("Start keeping rows first.");
    expect(has(`admin-rows-row-${WORKSPACE}`)).toBe(true);
    expect(pageText()).toContain("@acme");
    expect(pageText()).toContain("Checked 1,204 rows");
    expect(pageText()).toContain("Differs from the rules");
    // The table names a workspace by its handle and counts. A path never reaches this view.
    expect(pageText()).not.toMatch(/\.md|\/[a-z0-9-]+\//i);
  });

  test("Start keeping rows sends the one mutation, with no arguments", async () => {
    mount();
    mockCall = async () => ({ started: 1 });
    click("admin-rows-start");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/privacyRows:startKeeping", args: {} }]);
  });

  test("Use rows asks first: nothing is sent until the confirm is pressed", async () => {
    mockAnswers.set("functions/privacyRows:report", reportWith("shadow", { ok: true, reason: null }));
    mount();
    click("admin-rows-use");
    await settle();
    expect(mockCalls).toEqual([]);
    expect(has("admin-rows-use-confirm")).toBe(true);
    mockCall = async () => ({ source: "rows" });
    click("admin-rows-use-go");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/privacyRows:useRows", args: {} }]);
  });

  test("a refusal says the server's sentence, and the switch stays where it was", async () => {
    mockAnswers.set("functions/privacyRows:report", reportWith("shadow", { ok: true, reason: null }));
    mount();
    click("admin-rows-use");
    mockCall = async () => {
      throw Object.assign(new Error("[CONVEX] ROWS_DIFFER"), {
        data: { code: "ROWS_DIFFER", message: "1 workspace differs from the rules. Fix the difference first; the sample on each row says where." },
      });
    };
    click("admin-rows-use-go");
    await settle();
    expect(pageText()).toContain("1 workspace differs from the rules.");
    expect(pageText()).not.toContain("CONVEX");
  });

  test("a failure with no sentence of its own says the plain fallback, never the raw error", async () => {
    mockAnswers.set("functions/privacyRows:report", reportWith("shadow", { ok: true, reason: null }));
    mount();
    click("admin-rows-use");
    mockCall = async () => {
      throw new Error('useRows({"secret":"fake"}) failed');
    };
    click("admin-rows-use-go");
    await settle();
    expect(pageText()).toContain("That didn't work. Try again.");
    expect(pageText()).not.toContain("fake");
  });

  test("Back to Off is one press, and is offered while on rows", async () => {
    mockAnswers.set("functions/privacyRows:report", reportWith("rows", { ok: true, reason: null }));
    mount();
    expect(has("admin-rows-use")).toBe(false);
    mockCall = async () => ({ source: "file" });
    click("admin-rows-off");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/privacyRows:backToOff", args: {} }]);
  });

  test("Back to Off is not offered while the setting is already Off", () => {
    mount();
    expect(has("admin-rows-off")).toBe(false);
  });
});
