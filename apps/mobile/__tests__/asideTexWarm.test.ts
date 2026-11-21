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
 * its argument fails the first test; dropping `!strip` from `texShowing` fails
 * the folding test.
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

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel, TEX_WARM_MS } from "../features/console/aside/AsidePanel";
import { forgetAsideChoice } from "../features/console/aside/asideChoice";
import { FrameContext, type FrameApi } from "../features/app/appFrame/context";
import { initialFrame } from "../features/app/frame";

const TEX = { workspaceId: "ws1", endpoint: "https://gateway.example.test/mcp" };
const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  forgetAsideChoice();
  mockTexProps.length = 0;
  jest.useRealTimers();
});

/** The panel inside a frame of its own that only knows open and folded, as the desktop console draws it. */
function Framed({ tex }: { tex: typeof TEX | null }) {
  const [folded, setFolded] = useState(false);
  const frame = { state: { ...initialFrame, asideOpen: true, asideFolded: folded }, setAsideFolded: setFolded } as unknown as FrameApi;
  return createElement(FrameContext.Provider, { value: frame }, createElement(AsidePanel, { started: null, onOpenNote: () => {}, tex }));
}

function mount(tex: typeof TEX | null, framed = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(framed ? createElement(Framed, { tex }) : createElement(AsidePanel, { started: null, onOpenNote: () => {}, tex })),
  );
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

  // Dev2, 2026-11-21: folding the panel with Tex open left the chat drawn over the note.
  test("folding the panel with Tex open hides the chat behind the rail and keeps it mounted", () => {
    const panel = mount(TEX, true);
    panel.press("aside-tab-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    panel.press("aside-fold");
    expect(panel.find("aside-tex")).toBeNull();
    const warm = panel.find("aside-tex-warm");
    expect(warm).not.toBeNull();
    expect(getComputedStyle(warm as HTMLElement).display).toBe("none");
    expect(mockTexProps.at(-1)).toMatchObject({ active: false });
    panel.press("aside-strip-tex");
    expect(panel.find("aside-tex")).not.toBeNull();
    expect(mockTexProps.at(-1)).toMatchObject({ active: true });
  });
});
