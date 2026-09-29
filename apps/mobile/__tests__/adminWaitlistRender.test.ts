/**
 * @jest-environment jsdom
 */

/**
 * The staff console's Waitlist tab, actually rendered.
 *
 * Mounted the way `adminSecretsRender.test.ts` mounts the Credentials tab:
 * the whole pane, with `convex/react` answered from a table keyed by function
 * name. The rules:
 *
 *  1. **Rows reach the screen**, the answer to "what would you use it for?"
 *     included, and a dash where there is none.
 *  2. **Let in on a row lets in that row**, and the sentence after it counts
 *     what the server changed.
 *  3. **Bulk Remove removes the selection** and nothing else.
 *  4. **Add emails names what it skipped** rather than dropping it quietly.
 *
 * Each runs twice: at a phone's width, where the rows stack, and at a
 * desk's, where they are a table. jsdom does no layout and reports a width
 * of 0, so without `setWidth` every case would run on the phone layout only.
 *
 * Addresses here are fake and exist only in this file.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   row Let in passing every row's id                             2
 *   bulk Remove calling `admitWaitlist`                           2
 *   the `invalid` list left out of the outcome notice             2
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/** Keyed by the Convex function's own name; see `adminPaneRender.test.ts`. */
const mockAnswers = new Map<string, unknown>();
/** Every call the pane makes to a mutation, with its arguments. */
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];
/** What the next mutation call does; throws unless a test says. */
let mockCall: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => {
  throw new Error("not used in this test");
};

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<
    typeof import("convex/server")
  >("convex/server");
  const callable = (reference: never) => async (args: Record<string, unknown>) => {
    const name = getFunctionName(reference);
    mockCalls.push({ name, args });
    return mockCall(name, args);
  };
  return {
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useAction: callable,
    useMutation: callable,
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AdminPane } from "../features/admin/AdminPane";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
  mockCall = async () => {
    throw new Error("not used in this test");
  };
});

function mount(): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(AdminPane));
  });
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

/** A multi-line `TextField` renders as a `textarea` on the web. */
function type(testID: string, text: string): void {
  const field = find(testID);
  if (field === null) throw new Error(`no field called ${testID}`);
  act(() => {
    const proto =
      field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** See `contextIntroNotice.test.ts`: react-native-web measures the element. */
function setWidth(width: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const day = 86_400_000;
const waiting = [
  {
    id: "wl_one",
    email: "ada@example.test",
    status: "waiting",
    joinedAt: Date.UTC(2026, 8, 20),
    source: "login",
    useFor: "Notes for my research group",
    admittedAt: null,
  },
  {
    id: "wl_two",
    email: "grace@example.test",
    status: "waiting",
    joinedAt: Date.UTC(2026, 8, 20) - day,
    source: "home",
    useFor: null,
    admittedAt: null,
  },
  {
    id: "wl_three",
    email: "linus@example.test",
    status: "waiting",
    joinedAt: Date.UTC(2026, 8, 20) - 2 * day,
    source: "home",
    useFor: null,
    admittedAt: null,
  },
];

describe.each([
  { layout: "phone", width: 390 },
  { layout: "desk", width: 1280 },
])("waitlist on a $layout", ({ layout, width }) => {
  beforeEach(() => {
    setWidth(width);
    mockAnswers.set("functions/admin:amIAdmin", true);
    mockAnswers.set("functions/admin:listSecrets", []);
    mockAnswers.set("functions/admin:listWaitlist", {
      rows: waiting,
      more: false,
      counts: { waiting: 3, admitted: 5 },
    });
  });

  test("rows render, with the answer or a dash", () => {
    mount();
    click("admin-tab-waitlist");
    expect(find("admin-waitlist-filter-waiting")?.textContent).toBe("Waiting 3");
    expect(find("admin-waitlist-filter-admitted")?.textContent).toBe("Let in 5");
    const first = find("admin-waitlist-row-wl_one")?.textContent ?? "";
    expect(first).toContain("ada@example.test");
    expect(first).toContain("Notes for my research group");
    expect(first).toContain("20 Sep");
    // A dash in the table's column; on a phone the line is left out instead.
    const second = find("admin-waitlist-row-wl_two")?.textContent ?? "";
    if (layout === "desk") expect(second).toContain("—");
    else expect(second).not.toContain("—");
  });

  test("Let in on a row lets in that row, and says so", async () => {
    mount();
    click("admin-tab-waitlist");
    mockCall = async () => ({ changed: 1 });
    click("admin-waitlist-admit-wl_two");
    await settle();
    expect(mockCalls).toEqual([
      { name: "functions/admin:admitWaitlist", args: { ids: ["wl_two"] } },
    ]);
    expect(find("admin-waitlist-outcome")?.textContent).toContain(
      "Let 1 person in. They'll get an email.",
    );
  });

  test("bulk Remove removes the selection and nothing else", async () => {
    mount();
    click("admin-tab-waitlist");
    expect(find("admin-waitlist-bulk")).toBeNull();
    click("admin-waitlist-pick-wl_one");
    click("admin-waitlist-pick-wl_three");
    expect(find("admin-waitlist-bulk")?.textContent).toContain("2 selected");
    mockCall = async () => ({ changed: 2 });
    click("admin-waitlist-bulk-remove");
    await settle();
    expect(mockCalls).toEqual([
      { name: "functions/admin:removeFromWaitlist", args: { ids: ["wl_one", "wl_three"] } },
    ]);
    expect(find("admin-waitlist-outcome")?.textContent).toContain("Removed 2 people.");
    // The selection is spent once it has been acted on.
    expect(find("admin-waitlist-bulk")).toBeNull();
  });

  test("Add emails lets them in and names what was not an address", async () => {
    mount();
    click("admin-tab-waitlist");
    click("admin-waitlist-add-open");
    type("admin-waitlist-add-emails", "new@example.test, not-an-email\nother@example.test");
    mockCall = async () => ({ changed: 2, invalid: ["not-an-email"] });
    click("admin-waitlist-add-submit");
    await settle();
    expect(mockCalls).toEqual([
      {
        name: "functions/admin:addToWaitlist",
        args: { emails: "new@example.test, not-an-email\nother@example.test" },
      },
    ]);
    expect(find("admin-waitlist-add")).toBeNull();
    const said = find("admin-waitlist-outcome")?.textContent ?? "";
    expect(said).toContain("Let 2 people in. They'll get an email.");
    expect(said).toContain("Not email addresses, so skipped: not-an-email.");
  });
});
