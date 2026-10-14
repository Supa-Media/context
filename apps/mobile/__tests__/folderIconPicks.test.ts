/**
 * @jest-environment jsdom
 */

/**
 * The icon picker's two quick picks (decided by the owner, 2026-10-14): the
 * emoji suggested from the name, and a random one with Shuffle. Nothing is
 * given an icon on its own, so these only ever act on a tap.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { SUGGEST_EMOJI } from "@context/shared/src/iconSuggest";
import { FolderIconDialog } from "../features/console/files/FolderIconDialog";
import { standardEmojiNamed } from "../features/console/files/emoji/standardEmoji";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid='${id}']`);
const LISTED = new Set(SUGGEST_EMOJI.map((one) => one.char));

async function picker(suggest?: () => Promise<string | null>) {
  const set: (string | null)[] = [];
  mount(
    createElement(FolderIconDialog, {
      path: "2-areas/taxes",
      current: null,
      onSet: async (icon: string | null) => void set.push(icon),
      onClose: () => {},
      ...(suggest === undefined ? {} : { suggest }),
    }),
  );
  await act(async () => {});
  return set;
}

test("every emoji the suggestion list holds is one the picker itself offers, under that name", () => {
  for (const one of SUGGEST_EMOJI) expect([one.name, standardEmojiNamed(one.name)?.char]).toEqual([one.name, one.char]);
});

describe("the quick picks", () => {
  test("the suggested emoji is shown once the name has been read, and a tap sets it", async () => {
    let answer: (icon: string | null) => void = () => {};
    const asked = new Promise<string | null>((resolve) => (answer = resolve));
    let calls = 0;
    const set = await picker(() => {
      calls += 1;
      return asked;
    });
    expect(byTestId("folder-icon-suggested-wait")).not.toBeNull();
    await act(async () => answer("💰"));
    expect(calls).toBe(1);
    const suggested = byTestId("folder-icon-suggested");
    expect(suggested?.textContent).toContain("💰");
    await act(async () => suggested!.click());
    expect(set).toEqual(["💰"]);
  });

  test("no suggestion, or nothing to ask, leaves only the random pick", async () => {
    await picker(async () => null);
    expect(byTestId("folder-icon-suggested")).toBeNull();
    expect(byTestId("folder-icon-suggested-wait")).toBeNull();
    expect(byTestId("folder-icon-random")).not.toBeNull();
  });

  test("the random pick is from the list, Shuffle rolls another, and a tap sets it", async () => {
    const set = await picker();
    const glyph = () => [...LISTED].find((char) => byTestId("folder-icon-random")?.textContent?.includes(char));
    const first = glyph();
    expect(first).toBeDefined();
    await act(async () => byTestId("folder-icon-shuffle")!.click());
    const second = glyph();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await act(async () => byTestId("folder-icon-random")!.click());
    expect(set).toEqual([second]);
  });
});
