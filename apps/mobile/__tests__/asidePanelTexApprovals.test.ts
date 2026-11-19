/**
 * @jest-environment jsdom
 */

/**
 * THE RIGHT PANEL HAS NO APPROVALS TAB; THE TEX CHAT CARRIES THEM.
 *
 * The owner, 2026-11-19: "no approvals tab, just make the approvals happen
 * right inside the message box". The panel draws no Approvals tab or body for
 * any state of the approvals view. It hands that view to the Tex chat, which
 * answers each approval inline (`texApprovalCard.test.ts`), and the Tex tab
 * carries the count. Split out of `asidePanelRender.test.ts`, which keeps the
 * meeting rules, to keep that file under the architecture threshold.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: null, records: [], canContinue: false, ending: null, audio: {}, offline: false }),
  useTick: () => 0,
}));

/*
  The Tex chat, as a spy. It polls a gateway and draws a conversation, and
  neither is what these tests are about. What they check is the props the
  panel hands it: that it is the one that now carries the approvals view.
*/
const mockTexProps: { workspaceId: string; endpoint: string; approvals?: unknown }[] = [];
jest.mock("../features/tex/chat/TexChatTab", () => ({
  TexChatTab: (props: { workspaceId: string; endpoint: string; approvals?: unknown }) => {
    mockTexProps.push(props);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { APPROVALS, NOTHING_WAITING } from "./approvalsFixture";
import type { ApprovalsView } from "../features/approvals/useApprovals";

/** Two emails waiting for the person's yes. */
const TWO_WAITING: ApprovalsView = {
  ...APPROVALS,
  items: [APPROVALS.items[0], { ...APPROVALS.items[0], id: "a2", summary: "send an email to pat@example.com" }],
};

/** The Tex chat's place in the panel: the owner's personal workspace, and its MCP endpoint. */
const TEX = { workspaceId: "ws1", endpoint: "https://gateway.example.test/mcp" };

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockTexProps.length = 0;
});

function mount(options: { approvals?: ApprovalsView; tex?: typeof TEX | null } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(AsidePanel, {
        started: null,
        approvals: options.approvals,
        tex: options.tex ?? null,
        onOpenNote: () => {},
      }),
    ),
  );
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

describe("approvals in the right panel", () => {
  /**
   * Approvals is not a tab (owner, 2026-11-19: "no approvals tab, just make
   * the approvals happen right inside the message box"). Even with something
   * waiting, and a listing that failed, the panel draws no Approvals tab and
   * no body of its own for it.
   *
   * ## Sabotage record
   *
   * Applied, suite run, named test observed failing, reverted.
   *
   *  1. The Approvals entry put back into `ASIDE_TABS`.
   *     → **1 fails**: `there is no Approvals tab, even when something is waiting`.
   */
  test("there is no Approvals tab, even when something is waiting and the listing failed", () => {
    const panel = mount({ approvals: { ...APPROVALS, phase: "failed", error: "The list could not be read." }, tex: TEX });
    expect(panel.find("aside-tab-approvals")).toBeNull();
    expect(panel.find("aside-approvals")).toBeNull();
    expect(panel.text()).not.toContain("Approvals");
    panel.press("aside-tab-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    expect(panel.find("aside-approvals")).toBeNull();
  });

  test("with nothing waiting there is no Approvals tab", () => {
    const panel = mount({ approvals: NOTHING_WAITING });
    expect(panel.find("aside-meetings")).not.toBeNull();
    expect(panel.find("aside-tab-approvals")).toBeNull();
  });

  test("the Tex chat is handed the approvals view, which is where they are answered", () => {
    const panel = mount({ approvals: APPROVALS, tex: TEX });
    panel.press("aside-tab-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    const last = mockTexProps[mockTexProps.length - 1];
    expect(last).toMatchObject({ workspaceId: TEX.workspaceId, endpoint: TEX.endpoint });
    expect(last.approvals).toBe(APPROVALS);
  });

  test("the Tex tab says how many are waiting, from the Meetings tab too", () => {
    const panel = mount({ approvals: TWO_WAITING, tex: TEX });
    const count = panel.find("aside-tab-tex-count");
    expect(count?.textContent).toBe("2");
    expect(panel.find("aside-tab-tex")?.contains(count!)).toBe(true);
    expect(panel.find("aside-tab-tex")?.getAttribute("aria-label")).toBe("Tex, 2 waiting");
    // It is still on the Meetings tab, which is where the panel opens.
    expect(panel.find("aside-meetings")).not.toBeNull();
  });

  test("with nothing waiting the Tex tab has no count", () => {
    const panel = mount({ approvals: NOTHING_WAITING, tex: TEX });
    expect(panel.find("aside-tab-tex")).not.toBeNull();
    expect(panel.find("aside-tab-tex-count")).toBeNull();
    expect(panel.find("aside-tab-tex")?.getAttribute("aria-label")).toBe("Tex");
  });

});
