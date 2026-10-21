/**
 * @jest-environment jsdom
 */

/**
 * THE APPROVALS SCREEN, ON THE GLASS.
 *
 * `approvalsGateway.test.ts` proves the wire and `approvalsCopy.test.ts` the
 * sentences. This mounts the panel and proves what a person can see and press:
 * the empty state, a failed listing, what a row says before a choice, that the
 * arguments are one press away and read-only, and that Approve and Deny send
 * exactly the decision they name.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `ApprovalsPanel` offering Approve with no Deny beside it.
 *     → **1 fails**: `refusing is as easy as accepting`.
 *  2. The row's Deny calling `decide` with "approve".
 *     → **1 fails**: `Deny sends a deny and never an approve`.
 *  3. The empty state hidden while a listing is still in flight, so a list with
 *     nothing in it looks like it is still loading forever.
 *     → **1 fails**: `an empty listing says so`.
 *  4. An email's copy behind the "Show what would run" toggle.
 *     → **1 fails**: `an email is shown whole before Approve`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApprovalsPanel, APPROVALS_EMPTY } from "../features/approvals/ApprovalsPanel";
import type { Approval } from "../features/approvals/gateway";
import type { ApprovalsView } from "../features/approvals/useApprovals";

const NOW = Date.now();

const ITEM: Approval = {
  id: "ap_1",
  summary: "share 1-projects/plan.md with anyone who has the link",
  tool: "create_link",
  args: { path: "1-projects/plan.md" },
  audience: "anyone with the link",
  client: "Claude Desktop",
  createdAt: NOW - 5 * 60_000,
  expiresAt: NOW + 14 * 60_000,
  kind: null,
};

const KEY_ASK: Approval = {
  id: "ap_key",
  summary: "let Claude Code use your Stripe key on api.example.com",
  tool: "vault_list",
  args: { vault_use: { entry: "v0", client: "client_x" } },
  audience: "outside",
  client: "Claude Code",
  createdAt: NOW - 60_000,
  expiresAt: NOW + 9 * 60_000,
  kind: "vault_use",
};

const PAY_ASK: Approval = {
  ...KEY_ASK,
  id: "ap_pay",
  summary: "let Claude Code pay with your Visa ••4242, expires 08/29 on shop.example",
  args: { vault_pay: { entry: "v0", client: "client_x", host: "shop.example" } },
  kind: "vault_pay",
};

function view(over: Partial<ApprovalsView> = {}): ApprovalsView & { decided: string[] } {
  const decided: string[] = [];
  return {
    available: true,
    phase: "listed",
    loading: false,
    items: [],
    error: null,
    busyId: null,
    notice: null,
    refresh: () => {},
    decide: (id, action) => {
      decided.push(`${action}:${id}`);
    },
    ...over,
    decided,
  };
}

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
});

function mount(props: ApprovalsView & { decided: string[] }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(ApprovalsPanel, { view: props })));
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("what is waiting", () => {
  test("an empty listing says so", () => {
    const panel = mount(view({ phase: "listed", items: [] }));
    expect(panel.find("approvals-empty")?.textContent).toBe(APPROVALS_EMPTY);
    expect(APPROVALS_EMPTY).toBe("Nothing is waiting for your OK.");
  });

  test("before the first answer it says it is checking, not that nothing is waiting", () => {
    const panel = mount(view({ phase: "idle", loading: true }));
    expect(panel.find("approvals-checking")).not.toBeNull();
    expect(panel.find("approvals-empty")).toBeNull();
  });

  test("a failed listing is a notice, with nothing to approve", () => {
    const panel = mount(view({ phase: "failed", items: [], error: "Try again in a moment." }));
    expect(panel.find("approvals-error")?.textContent).toContain("Try again in a moment.");
    expect(panel.find("approvals-empty")).toBeNull();
    expect(panel.text()).not.toContain("Approve");
  });

  test("a row says who asked, when, and how long it is good for, before any choice", () => {
    const panel = mount(view({ items: [ITEM] }));
    const row = panel.text();
    expect(row).toContain(ITEM.summary);
    expect(row).toContain("Asked by Claude Desktop");
    expect(row).toContain("Asked 5 min ago");
    expect(row).toContain("Expires in 14 min");
  });

  test("an email is shown whole before Approve, with no press needed", () => {
    const copy = "From: seyi@gmail.example\nTo: jo@example.com, sam@example.com\nSubject: Re: Thursday\n\nHi Jo,\n\nThursday at 3 works.\n\nSee https://a.example/1 and https://a.example/2.";
    const panel = mount(view({ items: [{ ...ITEM, id: "ap_mail", tool: "send_email", summary: 'send an email to jo@example.com and 1 more, "Re: Thursday"', detail: copy }] }));
    expect(panel.find("approval-read-ap_mail")?.textContent).toBe(copy);
    expect(panel.find("approval-detail-ap_mail")).toBeNull();
    expect(panel.find("approve-ap_mail")).not.toBeNull();
  });

  test("the arguments are one press away, and only shown when asked for", () => {
    const panel = mount(view({ items: [ITEM] }));
    expect(panel.find(`approval-detail-${ITEM.id}`)).toBeNull();
    panel.press(`approval-toggle-${ITEM.id}`);
    const detail = panel.find(`approval-detail-${ITEM.id}`);
    expect(detail?.textContent).toContain("create_link");
    expect(detail?.textContent).toContain("1-projects/plan.md");
  });
});

describe("the choice", () => {
  /**
   * The two buttons are the design system's `decision` pair: same shape, same
   * weight. A screen where refusing is the quieter control is a dark pattern,
   * whatever its copy says.
   */
  test("refusing is as easy as accepting", () => {
    const panel = mount(view({ items: [ITEM] }));
    expect(panel.find(`approve-${ITEM.id}`)).not.toBeNull();
    expect(panel.find(`deny-${ITEM.id}`)).not.toBeNull();
  });

  test("Approve sends an approval for that row", () => {
    const state = view({ items: [ITEM] });
    mount(state).press(`approve-${ITEM.id}`);
    expect(state.decided).toEqual([`approve:${ITEM.id}`]);
  });

  test("Deny sends a deny and never an approve", () => {
    const state = view({ items: [ITEM] });
    mount(state).press(`deny-${ITEM.id}`);
    expect(state.decided).toEqual([`deny:${ITEM.id}`]);
  });

  test("a saved key's first use offers from now on, just this once and no, and nothing to show", () => {
    const state = view({ items: [KEY_ASK] });
    const panel = mount(state);
    expect(panel.find(`approval-toggle-${KEY_ASK.id}`)).toBeNull();
    expect(panel.find(`approve-always-${KEY_ASK.id}`)?.textContent).toContain("Yes, from now on");
    expect(panel.find(`approve-${KEY_ASK.id}`)?.textContent).toContain("Just this once");
    expect(panel.find(`deny-${KEY_ASK.id}`)?.textContent).toContain("No");
    panel.press(`approve-always-${KEY_ASK.id}`);
    expect(state.decided).toEqual([`approve_always:${KEY_ASK.id}`]);
  });

  test("a card payment is allowed once or not at all, with nothing to show", () => {
    const state = view({ items: [PAY_ASK] });
    const panel = mount(state);
    expect(panel.find(`approval-toggle-${PAY_ASK.id}`)).toBeNull();
    expect(panel.find(`approve-always-${PAY_ASK.id}`)).toBeNull();
    expect(panel.find(`approve-${PAY_ASK.id}`)?.textContent).toContain("Allow this payment");
    expect(panel.find(`deny-${PAY_ASK.id}`)?.textContent).toContain("No");
    expect(panel.find(`approval-pay-${PAY_ASK.id}`)?.textContent).toMatch(/once, on this site only/);
    panel.press(`approve-${PAY_ASK.id}`);
    expect(state.decided).toEqual([`approve:${PAY_ASK.id}`]);
  });

  test("an ordinary held call has no from-now-on", () => {
    expect(mount(view({ items: [ITEM] })).find(`approve-always-${ITEM.id}`)).toBeNull();
  });

  test("nothing can be decided while another decision is in flight", () => {
    const state = view({ items: [ITEM], busyId: "ap_other" });
    mount(state).press(`approve-${ITEM.id}`);
    expect(state.decided).toEqual([]);
  });

  test("the notice after a decision is shown in the panel", () => {
    const panel = mount(view({ items: [], notice: { tone: "ok", text: "Denied. Nothing ran." } }));
    expect(panel.find("approvals-notice")?.textContent).toBe("Denied. Nothing ran.");
  });
});
