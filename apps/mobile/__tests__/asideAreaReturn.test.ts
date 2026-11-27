/**
 * @jest-environment jsdom
 */
/**
 * A page's side (a bot, an area) leaving puts the right panel back as it was before it came.
 *
 * Closing a bot's details left the Area tab gone, and the panel fell back to Meetings, a tab nobody chose (Dev,
 * 2026-11-26: "when bot details are open and I close out, it goes to calendar"). See `leaveArea` in
 * `features/console/aside/asideChoice.ts`.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: null, records: [], canContinue: false, ending: null, audio: {}, offline: false }),
  useTick: () => 0,
}));
jest.mock("../features/tex/chat/TexChatTab", () => ({ TexChatTab: () => null }));

import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { forgetAsideChoice, leaveArea, rememberBeforeArea } from "../features/console/aside/asideChoice";
import { PageSideProvider, useOfferPageSide } from "../features/console/aside/pageSide";
import { APPROVALS } from "./approvalsFixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEX = { workspaceId: "ws1", endpoint: "https://gateway.example.test/mcp" };
const unmounts: (() => void)[] = [];

afterEach(() => {
  forgetAsideChoice();
  while (unmounts.length > 0) unmounts.pop()!();
  document.body.innerHTML = "";
});

function Offer({ side }: { side: ReactNode | null }) {
  useOfferPageSide(side);
  return null;
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const render = (side: ReactNode | null) =>
    act(() =>
      root.render(
        createElement(PageSideProvider, null, createElement(Offer, { side }), createElement(AsidePanel, { started: null, approvals: APPROVALS, tex: TEX, onOpenNote: () => {} })),
      ),
    );
  render(null);
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = (id: string) => {
    const node = find(id);
    if (node === null) throw new Error(`no element with testID ${id}`);
    act(() => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  return { find, press, render };
}

const BOT = createElement("div", { "data-testid": "bot-side" });

describe("closing a bot's details puts the panel back", () => {
  test("the tab chosen before the bot opened comes back, not Meetings", () => {
    const panel = mount();
    panel.press("aside-tab-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    panel.render(BOT);
    expect(panel.find("bot-side")).not.toBeNull();
    panel.render(null);
    expect(panel.find("bot-side")).toBeNull();
    expect(panel.find("aside-tex")).not.toBeNull();
    expect(panel.find("aside-meetings")).toBeNull();
  });

  test("a tab the person chose while the bot was up stays chosen", () => {
    const panel = mount();
    panel.press("aside-tab-tex");
    panel.render(BOT);
    panel.press("aside-tab-meetings");
    panel.render(null);
    expect(panel.find("aside-meetings")).not.toBeNull();
  });
});

describe("leaveArea", () => {
  const was = { tab: "tex" as const, open: true, folded: false };

  test("brings back the tab, and shuts or folds the panel the bot opened", () => {
    rememberBeforeArea({ tab: "note", open: false, folded: false });
    expect(leaveArea({ tab: "area", open: true, folded: false })).toEqual({ tab: "note", shut: true });
    rememberBeforeArea({ tab: "tex", open: true, folded: true });
    expect(leaveArea({ tab: "area", open: true, folded: false })).toEqual({ tab: "tex", fold: true });
  });

  test("does nothing once the person moved to another tab, or with nothing remembered", () => {
    rememberBeforeArea(was);
    expect(leaveArea({ tab: "meetings", open: true, folded: false })).toEqual({});
    expect(leaveArea({ tab: "area", open: true, folded: false })).toEqual({});
  });

  test("a second side before the first left keeps what the person had", () => {
    rememberBeforeArea(was);
    rememberBeforeArea({ tab: "area", open: true, folded: false });
    expect(leaveArea({ tab: "area", open: true, folded: false })).toEqual({ tab: "tex" });
  });
});
