/**
 * @jest-environment jsdom
 */

/**
 * AN APPROVAL IN THE TEX LOG, ON THE GLASS.
 *
 * A held call from an AI client is asked in the middle of the Tex chat, as a
 * card where it was asked, and its Approve and Decline are pressed there. This
 * mounts `TexChatView` with a fake chat and a fake approvals view, and proves
 * where the card sits, what a press sends, and that a settled card says what
 * happened without a reload. `chatTimeline` is tested on its own below.
 *
 * Fake values only: "Claude Desktop", example.test addresses.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, jest, test } from "@jest/globals";

// The hook is replaced: the tab is drawn from the view it is given.
jest.mock("../features/tex/chat/useAppChat", () => ({
  useAppChat: () => {
    throw new Error("the Tex tab is drawn from the view it is given, in these tests");
  },
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Approval, DecisionAction } from "../features/approvals/gateway";
import type { DecidedApproval } from "../features/approvals/useApprovals";
import type { AppChatRow, ChatLine } from "../features/tex/chat/appChatGateway";
import type { AppChatView } from "../features/tex/chat/useAppChat";
import { TEX_EMPTY, TexChatView } from "../features/tex/chat/TexChatTab";
import { chatTimeline, type TimelineApprovals } from "../features/tex/chat/approvalTimeline";

const AT = Date.UTC(2026, 10, 19, 9, 0);
const MIN = 60_000;

function row(over: Partial<AppChatRow> & { id: string }): AppChatRow {
  return { who: "tex", text: "", at: AT, kind: "text", ...over };
}

function approval(over: Partial<Approval> & { id: string }): Approval {
  return {
    summary: "share the Q4 plan with sam@example.test",
    tool: "share_note",
    args: { note: "q4-plan.md", to: "sam@example.test" },
    audience: null,
    client: "Claude Desktop",
    createdAt: AT + MIN,
    expiresAt: AT + 30 * MIN,
    kind: null,
    ...over,
  };
}

function decided(item: Approval, outcome: DecidedApproval["outcome"], note: string | null): DecidedApproval {
  return { approval: item, outcome, note };
}

type Decides = Array<[string, DecisionAction]>;

function fakeChat(lines: ChatLine[]): AppChatView {
  const noop = () => {};
  return {
    available: true,
    phase: "listed",
    lines,
    busy: false,
    sending: false,
    error: null,
    answers: {},
    send: noop,
    retry: noop,
    answer: noop,
    react: noop,
    edit: noop,
    unsend: noop,
    pictureUrl: () => null,
  } as unknown as AppChatView;
}

function fakeApprovals(
  over: Partial<TimelineApprovals> & {
    phase?: "idle" | "listed" | "failed";
    error?: string | null;
    notice?: { tone: "ok" | "warn"; text: string } | null;
  } = {},
) {
  const decides: Decides = [];
  return {
    decides,
    view: {
      available: true,
      phase: over.phase ?? "listed",
      loading: false,
      items: over.items ?? [],
      decided: over.decided ?? [],
      error: over.error ?? null,
      busyId: over.busyId ?? null,
      notice: over.notice ?? null,
      refresh: () => {},
      decide: (id: string, action: DecisionAction) => {
        decides.push([id, action]);
      },
    },
  };
}

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
});

function mount(lines: ChatLine[], approvals: ReturnType<typeof fakeApprovals>["view"] | undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const draw = (nextLines: ChatLine[], nextApprovals: typeof approvals) =>
    act(() => root.render(createElement(TexChatView, { view: fakeChat(nextLines), approvals: nextApprovals })));
  draw(lines, approvals);
  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    draw,
    press: (testId: string) => {
      const node = find(testId);
      if (node === null) throw new Error(`no element with testID ${testId}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    order: (...testIds: string[]) => {
      const nodes = testIds.map((id) => find(id));
      for (let i = 0; i < nodes.length - 1; i += 1) {
        const a = nodes[i];
        const b = nodes[i + 1];
        if (a === null || b === null || a === undefined || b === undefined) return false;
        // DOCUMENT_POSITION_FOLLOWING: the second node comes after the first.
        if (!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      }
      return true;
    },
  };
}

describe("a pending approval in the log", () => {
  const first = row({ id: "r1", text: "Hi, what's up?", at: AT });
  const second = row({ id: "r2", text: "Share the plan with Sam?", at: AT + 2 * MIN });
  const item = approval({ id: "ap_1" });

  test("is drawn between the two rows it sits between, with Approve and Decline", () => {
    const approvals = fakeApprovals({ items: [item] });
    const tab = mount([first, second], approvals.view);

    expect(tab.order("tex-row-r1", "tex-approval-ap_1", "tex-row-r2")).toBe(true);
    expect(tab.text()).toContain("Waiting for your OK");
    expect(tab.text()).toContain(item.summary);
    expect(tab.text()).toContain("Asked by Claude Desktop");
    expect(tab.find("tex-approval-approve-ap_1")?.textContent).toBe("Approve");
    expect(tab.find("tex-approval-decline-ap_1")?.textContent).toBe("Decline");
    expect(tab.find("tex-approval-always-ap_1")).toBeNull();
  });

  test("Approve calls decide with approve, and the card flips to Approved with no buttons", () => {
    const approvals = fakeApprovals({ items: [item] });
    const tab = mount([first, second], approvals.view);

    tab.press("tex-approval-approve-ap_1");
    expect(approvals.decides).toEqual([["ap_1", "approve"]]);

    tab.draw([first, second], fakeApprovals({ decided: [decided(item, "approved", "Approved. It ran as asked.")] }).view);
    expect(tab.find("tex-approval-state-ap_1")?.textContent).toBe("Approved");
    expect(tab.text()).toContain("Approved. It ran as asked.");
    expect(tab.find("tex-approval-approve-ap_1")).toBeNull();
    expect(tab.find("tex-approval-decline-ap_1")).toBeNull();
  });

  test("Decline calls decide with deny, and the card flips to Declined", () => {
    const approvals = fakeApprovals({ items: [item] });
    const tab = mount([first, second], approvals.view);

    tab.press("tex-approval-decline-ap_1");
    expect(approvals.decides).toEqual([["ap_1", "deny"]]);

    tab.draw([first, second], fakeApprovals({ decided: [decided(item, "declined", "Denied. Nothing ran.")] }).view);
    expect(tab.find("tex-approval-state-ap_1")?.textContent).toBe("Declined");
    expect(tab.find("tex-approval-decline-ap_1")).toBeNull();
  });

  test("a card that was gone says so", () => {
    const tab = mount([first, second], fakeApprovals({ decided: [decided(item, "gone", "It expired.")] }).view);
    expect(tab.find("tex-approval-state-ap_1")?.textContent).toBe("No longer waiting");
  });

  test("while a decision is in flight the card says Sending and its buttons are disabled", () => {
    const tab = mount([first, second], fakeApprovals({ items: [item], busyId: "ap_1" }).view);
    expect(tab.find("tex-approval-busy-ap_1")?.textContent).toBe("Sending…");
    expect(tab.find("tex-approval-approve-ap_1")?.getAttribute("aria-disabled")).toBe("true");
    expect(tab.find("tex-approval-decline-ap_1")?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("a vault key's first use", () => {
  test("has a 'Yes, from now on' button that sends approve_always", () => {
    const key = approval({ id: "ap_key", kind: "vault_use", summary: "use your bank key", tool: "vault_use", args: {} });
    const approvals = fakeApprovals({ items: [key] });
    const tab = mount([row({ id: "r1" })], approvals.view);

    expect(tab.find("tex-approval-always-ap_key")?.textContent).toBe("Yes, from now on");
    tab.press("tex-approval-always-ap_key");
    expect(approvals.decides).toEqual([["ap_key", "approve_always"]]);
  });

  test("a card payment has no Always button", () => {
    const pay = approval({ id: "ap_pay", kind: "vault_pay", summary: "fill your card at a shop", tool: "vault_pay", args: {} });
    const tab = mount([], fakeApprovals({ items: [pay] }).view);
    expect(tab.find("tex-approval-always-ap_pay")).toBeNull();
    expect(tab.find("tex-approval-approve-ap_pay")).not.toBeNull();
    expect(tab.find("tex-approval-pay-ap_pay")?.textContent).toContain("once, on this site only");
  });
});

describe("a decision that did not go through", () => {
  test("leaves the card waiting and says why under it", () => {
    const item = approval({ id: "ap_1" });
    const text = "That did not go through. Nothing was approved or denied. Try again in a moment.";
    const tab = mount([], fakeApprovals({ items: [item], notice: { tone: "warn", text } }).view);
    expect(tab.find("tex-approval-approve-ap_1")).not.toBeNull();
    expect(tab.find("tex-approvals-notice")?.textContent).toBe(text);
  });

  test("a settled card's own note is not said twice", () => {
    const item = approval({ id: "ap_1" });
    const text = "Approved, but it did not run.";
    const tab = mount(
      [],
      fakeApprovals({ decided: [{ approval: item, outcome: "approved", note: text }], notice: { tone: "warn", text } }).view,
    );
    expect(tab.find("tex-approval-note-ap_1")?.textContent).toBe(text);
    expect(tab.find("tex-approvals-notice")).toBeNull();
  });
});

describe("the empty chat and a failed listing", () => {
  test("an empty chat with one pending approval shows the card, not the empty line", () => {
    const tab = mount([], fakeApprovals({ items: [approval({ id: "ap_1" })] }).view);
    expect(tab.find("tex-approval-ap_1")).not.toBeNull();
    expect(tab.find("tex-empty")).toBeNull();
    expect(tab.text()).not.toContain(TEX_EMPTY);
  });

  test("an empty chat with nothing waiting still says what to do", () => {
    const tab = mount([], fakeApprovals().view);
    expect(tab.find("tex-empty")?.textContent).toBe(TEX_EMPTY);
  });

  test("a failed listing shows its sentence under the rows", () => {
    const tab = mount([row({ id: "r1", text: "Hi" })], fakeApprovals({ phase: "failed", error: "I could not reach your context. Try again in a moment." }).view);
    expect(tab.find("tex-approvals-error")?.textContent).toBe("I could not reach your context. Try again in a moment.");
  });

  test("no approvals prop draws the chat as before", () => {
    const tab = mount([row({ id: "r1", text: "Hi" })], undefined);
    expect(tab.find("tex-row-r1")).not.toBeNull();
    expect(tab.find("tex-approvals-error")).toBeNull();
  });
});

describe("Tex's own asks use the same card", () => {
  test("the open ask is headed Waiting for your OK and answered Declined", () => {
    const ask = row({ id: "a1", text: "Send the invoice to Sam?", ask: { id: "ap_9", open: true } });
    const tab = mount([ask], undefined);
    expect(tab.text()).toContain("Waiting for your OK");
    expect(tab.find("tex-deny-a1")?.textContent).toBe("Decline");
  });
});

describe("chatTimeline", () => {
  const line = (id: string, at: number) => row({ id, at });
  const card = (id: string, createdAt: number) => approval({ id, createdAt });
  const kinds = (entries: ReturnType<typeof chatTimeline>) =>
    entries.map((entry) => (entry.kind === "line" ? entry.line.id : entry.approval.id));

  test("lines keep their order and a card sits where it was asked", () => {
    const lines = [line("a", 100), line("b", 300), line("c", 500)];
    const approvals = { items: [card("x", 200), card("y", 400)], decided: [], busyId: null };
    expect(kinds(chatTimeline(lines, approvals))).toEqual(["a", "x", "b", "y", "c"]);
  });

  test("a card asked at the same moment as a line comes after that line", () => {
    const lines = [line("a", 100), line("b", 300)];
    const approvals = { items: [card("x", 100)], decided: [], busyId: null };
    expect(kinds(chatTimeline(lines, approvals))).toEqual(["a", "x", "b"]);
  });

  test("cards asked in the same gap are ordered by when they were asked", () => {
    const lines = [line("a", 100), line("b", 900)];
    const approvals = { items: [card("late", 500), card("early", 200)], decided: [], busyId: null };
    expect(kinds(chatTimeline(lines, approvals))).toEqual(["a", "early", "late", "b"]);
  });

  test("a card asked after the last line goes at the foot", () => {
    const lines = [line("a", 100)];
    const approvals = { items: [card("x", 900)], decided: [], busyId: null };
    expect(kinds(chatTimeline(lines, approvals))).toEqual(["a", "x"]);
  });

  test("a card asked before any line goes at the top", () => {
    const lines = [line("a", 100)];
    const approvals = { items: [card("x", 50)], decided: [], busyId: null };
    expect(kinds(chatTimeline(lines, approvals))).toEqual(["x", "a"]);
  });

  test("a busy card is marked busy, and a decided one carries its outcome and note", () => {
    const lines = [line("a", 100)];
    const approvals = {
      items: [card("busy", 200)],
      decided: [decided(card("done", 150), "declined", "Denied. Nothing ran.")],
      busyId: "busy",
    };
    const entries = chatTimeline(lines, approvals);
    expect(entries).toHaveLength(3);
    const busy = entries.find((entry) => entry.kind === "approval" && entry.approval.id === "busy");
    expect(busy).toMatchObject({ state: "busy" });
    const done = entries.find((entry) => entry.kind === "approval" && entry.approval.id === "done");
    expect(done).toMatchObject({ state: "declined", note: "Denied. Nothing ran." });
  });

  test("null and undefined approvals leave just the lines", () => {
    const lines = [line("a", 100), line("b", 300)];
    expect(kinds(chatTimeline(lines, null))).toEqual(["a", "b"]);
    expect(kinds(chatTimeline(lines, undefined))).toEqual(["a", "b"]);
  });
});
