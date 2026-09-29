/**
 * @jest-environment jsdom
 */

/**
 * The Waitlist tab's "Invited by friends" view and community links, rendered.
 *
 * Same harness as `adminWaitlistRender.test.ts`. The rules:
 *
 *  1. **The tab carries the referral total**, and rows reach the screen.
 *  2. **Revoke asks first**, and only the confirmed press calls the server,
 *     with that row's id.
 *  3. **Trace grants to the sender** — the row's `inviterUserId` — and says
 *     no email is sent.
 *  4. **The switch pauses invites**, sending `off: true` when it was on.
 *  5. **A refused link shows the server's own sentence.**
 *
 * Addresses here are fake and exist only in this file.
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

const referrals = {
  rows: [
    {
      id: "ri_one",
      email: "sam@example.test",
      inviterUserId: "user_maya",
      inviterHandle: "maya",
      inviterUsed: 2,
      inviterTotal: 3,
      sentAt: Date.UTC(2026, 8, 29),
      expiresAt: Date.UTC(2026, 9, 13),
      status: "pending",
      joinedHandle: null,
    },
    {
      id: "ri_two",
      email: "jon@example.test",
      inviterUserId: "user_maya",
      inviterHandle: "maya",
      inviterUsed: 2,
      inviterTotal: 3,
      sentAt: Date.UTC(2026, 8, 20),
      expiresAt: Date.UTC(2026, 9, 4),
      status: "joined",
      joinedHandle: "jon",
    },
  ],
  more: false,
  counts: { pending: 1, joined: 1, expired: 0, cancelled: 0, revoked: 0 },
  invitesOff: false,
};

describe.each([
  { layout: "phone", width: 390 },
  { layout: "desk", width: 1280 },
])("invited by friends on a $layout", ({ width }) => {
  beforeEach(() => {
    setWidth(width);
    mockAnswers.set("functions/admin:amIAdmin", true);
    mockAnswers.set("functions/admin:listSecrets", []);
    mockAnswers.set("functions/admin:listWaitlist", { rows: [], more: false, counts: { waiting: 0, admitted: 0 } });
    mockAnswers.set("functions/admin:listReferrals", referrals);
    mockAnswers.set("functions/admin:listCommunityLinks", []);
  });

  function open(): void {
    mount();
    click("admin-tab-waitlist");
    click("admin-waitlist-filter-friends");
  }

  test("the tab counts referrals and rows render", () => {
    mount();
    click("admin-tab-waitlist");
    expect(find("admin-waitlist-filter-friends")?.textContent).toBe("Invited by friends 2");
    click("admin-waitlist-filter-friends");
    expect(find("admin-referrals-filter-pending")?.textContent).toBe("Not used yet 1");
    const first = find("admin-referral-row-ri_one")?.textContent ?? "";
    expect(first).toContain("sam@example.test");
    expect(first).toContain("@maya · 2 used of 3");
    expect(first).toContain("Not used yet");
    expect(find("admin-referral-status-ri_two")?.textContent).toBe("Joined @jon");
    // Revoke is offered on the unused invite only.
    expect(find("admin-referral-revoke-ri_two")).toBeNull();
    click("admin-referrals-filter-joined");
    expect(find("admin-referral-row-ri_one")).toBeNull();
  });

  test("Revoke asks first, then revokes that row", async () => {
    open();
    click("admin-referral-revoke-ri_one");
    expect(mockCalls).toEqual([]);
    expect(find("admin-referral-confirm-ri_one")?.textContent).toContain(
      "Revoke the invite to sam@example.test? The link stops working now. @maya doesn't get it back. Nobody is emailed.",
    );
    mockCall = async () => ({ changed: true });
    click("admin-referral-revoke-confirm-ri_one");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/admin:revokeReferral", args: { inviteId: "ri_one" } }]);
    expect(find("admin-referrals-outcome")?.textContent).toContain("Revoked the invite to sam@example.test.");
    expect(find("admin-referral-confirm-ri_one")).toBeNull();
  });

  test("Trace shows the timeline and grants to the sender", async () => {
    mockAnswers.set("functions/admin:traceReferral", {
      email: "jon@example.test",
      status: "joined",
      inviterHandle: "maya",
      sentAt: Date.UTC(2026, 8, 20),
      expiresAt: Date.UTC(2026, 9, 4),
      cancelledAt: null,
      revokedAt: null,
      joinedAt: Date.UTC(2026, 8, 21),
      joinedHandle: "jon",
      onward: [{ email: "kim@example.test", status: "pending", sentAt: Date.UTC(2026, 8, 25) }],
    });
    open();
    click("admin-referral-trace-ri_two");
    const panel = find("admin-referral-trace-panel-ri_two")?.textContent ?? "";
    expect(panel).toContain("Invited by @maya");
    expect(panel).toContain("Joined as @jon");
    expect(panel).toContain("@jon has invited 1 person");
    expect(panel).toContain("kim@example.test");
    mockCall = async () => ({ extra: 3 });
    click("admin-referral-grant-3-ri_two");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/admin:grantInvites", args: { userId: "user_maya", add: 3 } }]);
    expect(find("admin-referral-grant-said-ri_two")?.textContent).toContain("No email is sent.");
  });

  test("the switch pauses new invites", async () => {
    open();
    mockCall = async () => ({ invitesOff: true });
    click("admin-referrals-switch");
    await settle();
    expect(mockCalls).toEqual([{ name: "functions/admin:setInvitesOff", args: { off: true } }]);
  });

  test("an empty list says how people get invites", () => {
    mockAnswers.set("functions/admin:listReferrals", {
      rows: [],
      more: false,
      counts: { pending: 0, joined: 0, expired: 0, cancelled: 0, revoked: 0 },
      invitesOff: false,
    });
    open();
    expect(find("admin-referrals-empty")?.textContent).toContain("People get 3 invites once they connect an AI.");
  });

  test("adding a link sends it, and a refusal shows the server's sentence", async () => {
    mount();
    click("admin-tab-waitlist");
    click("admin-link-add-open");
    type("admin-link-url", "http://discord.example.test/x");
    mockCall = async () => {
      throw Object.assign(new Error("refused"), { data: { message: "Links must start with https://" } });
    };
    click("admin-link-save");
    await settle();
    expect(mockCalls).toEqual([
      {
        name: "functions/admin:saveCommunityLink",
        args: { kind: "discord", label: "Discord", url: "http://discord.example.test/x", audience: "members" },
      },
    ]);
    expect(find("admin-link-error")?.textContent).toBe("Links must start with https://");
  });
});
