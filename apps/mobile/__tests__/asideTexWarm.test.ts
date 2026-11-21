/**
 * @jest-environment jsdom
 */

/**
 * THE TEX CHAT LOADS BEFORE IT IS OPENED (Dev2, 2026-11-21 roast: the side
 * panel "takes a while to load ... it should be more immediate").
 *
 * The panel mounts the chat hidden once the console has had `TEX_WARM_MS` to
 * load, and opening Tex shows that same chat rather than making a new one, so
 * its history is already there. The chat itself is a spy: what is proven is
 * when it mounts and what it is told.
 *
 * Sabotage (run once, then restored): replacing `useWarmAfterLoad(...)` with
 * its argument fails the first test.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({ live: null, records: [], canContinue: false, ending: null, audio: {}, offline: false }),
  useTick: () => 0,
}));

const mockTexProps: { workspaceId: string; active?: boolean }[] = [];
jest.mock("../features/tex/chat/TexChatTab", () => ({
  TexChatTab: (props: { workspaceId: string; active?: boolean }) => {
    mockTexProps.push(props);
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel, TEX_WARM_MS } from "../features/console/aside/AsidePanel";
import { forgetAsideChoice } from "../features/console/aside/asideChoice";

const TEX = { workspaceId: "ws1", endpoint: "https://gateway.example.test/mcp" };
const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  forgetAsideChoice();
  mockTexProps.length = 0;
  jest.useRealTimers();
});

function mount(tex: typeof TEX | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(AsidePanel, { started: null, onOpenNote: () => {}, tex })));
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    find,
    press: (id: string) => {
      const node = find(id);
      if (node === null) throw new Error(`no element with testID ${id}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

describe("the Tex chat is warm before it is opened", () => {
  test("on Meetings, the chat mounts hidden once the console has had a moment to load, and nothing before", () => {
    jest.useFakeTimers();
    const panel = mount(TEX);
    expect(panel.find("aside-tex-warm")).toBeNull();
    expect(mockTexProps).toHaveLength(0);
    act(() => {
      jest.advanceTimersByTime(TEX_WARM_MS);
    });
    const warm = panel.find("aside-tex-warm");
    expect(warm).not.toBeNull();
    expect(getComputedStyle(warm as HTMLElement).display).toBe("none");
    expect(mockTexProps.at(-1)).toMatchObject({ workspaceId: TEX.workspaceId, active: false });
    panel.press("aside-tab-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    expect(panel.find("aside-tex-warm")).toBeNull();
    expect(mockTexProps.at(-1)).toMatchObject({ active: true });
  });

  test("a console with no Tex chat never mounts one", () => {
    jest.useFakeTimers();
    const panel = mount(null);
    act(() => {
      jest.advanceTimersByTime(TEX_WARM_MS * 2);
    });
    expect(panel.find("aside-tex-warm")).toBeNull();
    expect(mockTexProps).toHaveLength(0);
  });
});
