/**
 * @jest-environment jsdom
 */

/**
 * "Tagged launch" in a phone's search opens Home with the launch chip on
 * (board 04 of the phone Home artboards, approved 2026-09-30). Search is an
 * overlay and Home may not be mounted when the tag is pressed, so the ask
 * waits for Home — and is taken once, so the next visit starts on All.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The initial state ignoring `pending`.   → "a tag asked for before Home mounts is waiting for it"
 *  2. No listener while mounted.              → "a tag asked for while Home is open switches it"
 *  3. `pending` never cleared.                → "taken once: the next Home starts on All"
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { showTagOnHome, useHomeTag } from "../features/console/home/homeTag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: string | null | undefined;
const live: (() => void)[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});

function mountHome() {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Home() {
    seen = useHomeTag()[0];
    return null;
  }
  act(() => root.render(createElement(Home)));
  const unmount = () => act(() => root.unmount());
  live.push(unmount);
  return () => {
    live.splice(live.indexOf(unmount), 1);
    unmount();
  };
}

describe("a tag pressed in search opens on Home", () => {
  test("a tag asked for before Home mounts is waiting for it", () => {
    showTagOnHome("launch");
    mountHome();
    expect(seen).toBe("launch");
  });

  test("a tag asked for while Home is open switches it", () => {
    mountHome();
    act(() => showTagOnHome("weekly"));
    expect(seen).toBe("weekly");
  });

  test("taken once: the next Home starts on All", () => {
    showTagOnHome("client");
    const leave = mountHome();
    expect(seen).toBe("client");
    leave();
    mountHome();
    expect(seen).toBeNull();
  });
});
