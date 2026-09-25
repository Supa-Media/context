/**
 * @jest-environment jsdom
 */

/**
 * The staff console's Credentials tab, actually rendered.
 *
 * Split from `adminPaneRender.test.ts`, which covers who the page renders for
 * and that the tabs separate the errands. These are the rules of the one tab
 * that holds secrets:
 *
 *  1. **Delete asks first.** It used to fire on the first press.
 *  2. **A value never outlives its write.** Cleared on success, and the next
 *     dialog starts empty.
 *  3. **A failure says the server's sentence, never the raw error** — a failed
 *     action's message can carry its arguments, and here that is a credential.
 *  4. **Replace keeps the name**, so a replacement cannot land under a typo.
 *
 * The values typed here are fake and exist only in this file.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   Delete calling `deleteSecret` directly, without the dialog    3
 *   the value kept, and the dialog left open, after a save        1
 *   `messageFor` replaced by `String(error)`                      1
 *   Replace opening the dialog with an empty, editable name       1
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/** Keyed by the Convex function's own name; see `adminPaneRender.test.ts`. */
const mockAnswers = new Map<string, unknown>();
/** Every call the pane makes to an action or a mutation, with its arguments. */
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];
/** What the next action or mutation call does; throws unless a test says. */
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

function mount(): HTMLElement {
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
  return container;
}

/*
  These look in the whole document rather than the mount point: the
  credential dialogs are `Modal`s, which react-native-web portals to the body.
*/
function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(_container: HTMLElement, testID: string): void {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    node.click();
  });
}

function has(_container: HTMLElement, testID: string): boolean {
  return find(testID) !== null;
}

/** react-native-web renders `TextInput` as an `input`; this is how one is typed in. */
function type(testID: string, text: string): void {
  const field = find(testID);
  if (field === null) throw new Error(`no field called ${testID}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Lets a pending action or mutation settle and React commit what followed. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function pageText(): string {
  return document.body.textContent ?? "";
}

/**
 * An admin, with the reports left loading: this file is about the
 * Credentials tab, and the Growth tab it opens on draws its skeleton.
 */
function asAdmin(): void {
  mockAnswers.set("functions/admin:amIAdmin", true);
}

describe("credentials", () => {
  const configured = [
    {
      name: "STRIPE_SECRET_KEY",
      description: "Stripe secret key.",
      fingerprint: "0f0f0f0f",
      updatedAt: Date.now() - 3 * 86_400_000,
      updatedByEmail: "admin@example.test",
    },
  ];

  beforeEach(() => {
    asAdmin();
    mockAnswers.set("functions/admin:listSecrets", configured);
  });

  test("delete asks first, and says what stops working", async () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    expect(find("admin-credentials-count")?.textContent).toBe("4");
    click(container, "admin-secret-delete-STRIPE_SECRET_KEY");
    // The press opened a confirmation; it did not delete anything.
    expect(mockCalls).toEqual([]);
    expect(has(container, "admin-secret-delete-dialog")).toBe(true);
    expect(pageText()).toContain("Until it is set again");
    mockCall = async () => null;
    click(container, "admin-secret-confirm-delete");
    await settle();
    expect(mockCalls).toEqual([
      { name: "functions/admin:deleteSecret", args: { name: "STRIPE_SECRET_KEY" } },
    ]);
    expect(has(container, "admin-secret-delete-dialog")).toBe(false);
  });

  test("cancelling a delete deletes nothing", () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    click(container, "admin-secret-delete-STRIPE_SECRET_KEY");
    const cancel = [...document.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent === "Cancel",
    ) as HTMLElement;
    act(() => cancel.click());
    expect(has(container, "admin-secret-delete-dialog")).toBe(false);
    expect(mockCalls).toEqual([]);
  });

  test("a saved value is cleared, and only the fingerprint is shown", async () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    click(container, "admin-secret-pick-SEARCH_D1_API_TOKEN");
    expect((find("admin-secret-name") as HTMLInputElement).value).toBe("SEARCH_D1_API_TOKEN");
    type("admin-secret-value", "fake-value-for-test");
    mockCall = async (_name, args) => ({ name: args.name, fingerprint: "a1b2c3d4" });
    click(container, "admin-secret-save");
    await settle();
    expect(mockCalls[0]).toEqual({
      name: "functions/admin:setSecret",
      args: { name: "SEARCH_D1_API_TOKEN", value: "fake-value-for-test", description: undefined },
    });
    expect(has(container, "admin-secret-dialog")).toBe(false);
    expect(find("admin-secret-saved")?.textContent).toContain(
      "SEARCH_D1_API_TOKEN set — fingerprint a1b2c3d4",
    );
    expect(pageText()).not.toContain("fake-value-for-test");
    // Reopening starts from nothing, not from the last paste.
    click(container, "admin-secret-add");
    expect((find("admin-secret-value") as HTMLInputElement).value).toBe("");
  });

  test("a failed save says the server's sentence, never the raw error", async () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    click(container, "admin-secret-add");
    type("admin-secret-name", "SOME_NAME");
    type("admin-secret-value", "fake-value-for-test");
    mockCall = async () => {
      // What a failed action can look like: its arguments in the message.
      throw new Error('setSecret({"value":"fake-value-for-test"}) failed');
    };
    click(container, "admin-secret-save");
    await settle();
    expect(find("admin-secret-error")?.textContent).toBe(
      "That did not work. Check the name and try again.",
    );
    expect(pageText()).not.toContain("fake-value-for-test");
  });

  test("replace keeps the name and does not ask for it", async () => {
    const container = mount();
    click(container, "admin-tab-credentials");
    click(container, "admin-secret-replace-STRIPE_SECRET_KEY");
    expect(has(container, "admin-secret-name")).toBe(false);
    type("admin-secret-value", "fake-value-for-test");
    mockCall = async (_name, args) => ({ name: args.name, fingerprint: "9f9f9f9f" });
    click(container, "admin-secret-save");
    await settle();
    expect(mockCalls[0]?.args.name).toBe("STRIPE_SECRET_KEY");
  });
});
