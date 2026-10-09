/**
 * @jest-environment jsdom
 */

/**
 * The staff console's People tab, actually rendered (Dev2, 2026-10-09).
 *
 * Mounted like `adminWaitlistRender.test.ts`: the whole pane, `convex/react`
 * answered from a table keyed by function name. The rules:
 *
 *  1. **A person's card shows who they are**: every address, the first marked
 *     as where mail goes, their phone, and each workspace with its role.
 *  2. **Add phone saves that person's phone** and says so.
 *  3. **A number somebody else holds is refused on screen**, naming them.
 *
 * Addresses and numbers here are fake and exist only in this file.
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const kayla = {
  userId: "u_kayla",
  name: "Kayla",
  username: "kayla",
  emails: ["kayla@home.example", "kayla@work.example"],
  phone: null,
  textingPhones: [],
  joinedAt: Date.UTC(2026, 9, 1, 12),
  workspaces: [
    { slug: "kayla", name: "Kayla", kind: "personal", role: "owner" },
    { slug: "workteam", name: "Work team", kind: "shared", role: "member" },
  ],
};

beforeEach(() => {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/admin:listSecrets", []);
  mockAnswers.set("functions/admin:listPeople", [kayla]);
});

describe("the People tab", () => {
  test("a card shows the addresses, the phone and every workspace with its role", () => {
    mount();
    click("admin-tab-people");
    const card = find("admin-person-u_kayla")?.textContent ?? "";
    expect(card).toContain("Kayla");
    expect(card).toContain("@kayla");
    expect(card).toContain("kayla@home.example");
    expect(card).toContain("Mail goes here");
    expect(card).toContain("kayla@work.example");
    expect(card).toContain("No phone yet");
    expect(card).toContain("@kayla · Owner");
    expect(card).toContain("@workteam · Can read");
  });

  test("Add phone saves that person's phone", async () => {
    mockCall = async () => ({ status: "saved", phone: "+14155550100" });
    mount();
    click("admin-tab-people");
    click("admin-person-phone-edit-u_kayla");
    type("admin-person-phone-input-u_kayla", "+1 415 555 0100");
    click("admin-person-phone-save-u_kayla");
    await settle();
    expect(mockCalls).toEqual([
      { name: "functions/admin:setPersonPhone", args: { userId: "u_kayla", phone: "+1 415 555 0100" } },
    ]);
    expect(find("admin-person-u_kayla")?.textContent).toContain("Saved +14155550100.");
  });

  test("a number somebody else holds is refused, naming them", async () => {
    mockCall = async () => ({ status: "taken", phone: "+14155550100", heldBy: "boss@work.example" });
    mount();
    click("admin-tab-people");
    click("admin-person-phone-edit-u_kayla");
    type("admin-person-phone-input-u_kayla", "+14155550100");
    click("admin-person-phone-save-u_kayla");
    await settle();
    expect(find("admin-person-u_kayla")?.textContent).toContain(
      "+14155550100 already belongs to boss@work.example.",
    );
    expect(find("admin-person-phone-input-u_kayla")).not.toBeNull();
  });
});
