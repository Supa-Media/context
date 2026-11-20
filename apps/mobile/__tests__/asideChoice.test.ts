/**
 * @jest-environment jsdom
 */
/**
 * The right panel's tab survives the panel being mounted again.
 *
 * Opening the folded strip at `medium` moves the panel from its column to an
 * overlay, which is a new mount. With the tab in component state the press
 * was lost and the panel opened on Meetings (Dev2, 2026-11-20: "no matter if
 * you click the calendar button or the tex button, it takes you to
 * meetings"). See `features/console/aside/asideChoice.ts`.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: null, records: [], canContinue: false, ending: null, audio: {}, offline: false }),
  useTick: () => 0,
}));
jest.mock("../features/tex/chat/TexChatTab", () => ({ TexChatTab: () => null }));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { forgetAsideChoice } from "../features/console/aside/asideChoice";
import { APPROVALS } from "./approvalsFixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEX = { workspaceId: "ws1", endpoint: "https://gateway.example.test/mcp" };
const unmounts: (() => void)[] = [];

afterEach(() => {
  forgetAsideChoice();
  while (unmounts.length > 0) unmounts.pop()!();
  document.body.innerHTML = "";
});

function mount(started: number | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(AsidePanel, { started, approvals: APPROVALS, tex: TEX, onOpenNote: () => {} })));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  unmounts.push(unmount);
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    find,
    unmount: () => {
      unmounts.splice(unmounts.indexOf(unmount), 1);
      unmount();
    },
    press: (id: string) => {
      const node = find(id);
      if (node === null) throw new Error(`no element with testID ${id}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("the tab survives the panel moving", () => {
  test("a tab pressed on one mount is the tab the next mount opens on", () => {
    const first = mount();
    first.press("aside-tab-tex");
    first.unmount();
    const second = mount();
    expect(second.find("aside-tex")).not.toBeNull();
    expect(second.find("aside-meetings")).toBeNull();
  });

  test("an old New meeting does not take the tab back on the next mount", () => {
    const first = mount(1);
    expect(first.find("aside-meetings")).not.toBeNull();
    first.press("aside-tab-tex");
    first.unmount();
    expect(mount(1).find("aside-tex")).not.toBeNull();
  });

  test("a new New meeting still takes it", () => {
    const first = mount(1);
    first.press("aside-tab-tex");
    first.unmount();
    expect(mount(2).find("aside-meetings")).not.toBeNull();
  });
});
