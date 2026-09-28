/**
 * @jest-environment jsdom
 *
 * THINGS THAT ARRIVE IN THE FLOW EASE IN; THEY DO NOT JUMP.
 *
 * The presence row over a note, the notices above it, the save row under it,
 * the agents line in the sidebar and a note somebody else just created all
 * used to mount in one frame and shove whatever was under them by their full
 * height. `Reveal` grows the room for them instead, and gives it back the same
 * way. These are the claims that make that true and keep it cheap:
 *
 *  1. Closed is **nothing** — no element at all, so a Reveal that never opens
 *     costs its parent nothing (no zero-height child in a `gap:` column).
 *  2. Opening starts from a collapsed box and then eases to full height, so
 *     there is a height to ease *from*.
 *  3. Closing keeps the last content drawn while the room closes, then
 *     unmounts it — a caller writes `{open ? <X/> : null}` and still gets an
 *     exit.
 *  4. A list only eases in rows that genuinely arrived: not the first load,
 *     not a rename, not forty rows at once.
 *
 * SABOTAGE: return `children` straight from `WebReveal` when open and 1 and 2
 * fail; drop `last.current` and 3 fails; drop the removal check in
 * `useArrivals` and "a rename is not an arrival" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no `matchMedia`, which is where RN-Web reads reduced motion from;
// without it the preference never resolves and nothing is allowed to move.
// Answer "no preference" so the ease is what is under test.
window.matchMedia = ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { Reveal } =
  require("../features/design/components/Reveal") as typeof import("../features/design/components/Reveal");
const { useArrivals, MAX_ARRIVALS } =
  require("../features/design/useArrivals") as typeof import("../features/design/useArrivals");
const { motion } = require("../features/design/tokens/motion") as typeof import("../features/design/tokens/motion");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  jest.useRealTimers();
});

async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

async function rerender(node: ReactNode) {
  await act(async () => root!.render(node));
}

function box(): HTMLElement | null {
  return host!.querySelector('[data-testid="reveal"]');
}

function reveal(open: boolean, label: string | null) {
  return createElement(
    Reveal,
    { open, testID: "reveal" },
    label === null ? null : createElement("span", null, label),
  );
}

describe("Reveal", () => {
  test("closed draws no element at all", async () => {
    await mount(reveal(false, null));
    expect(host!.innerHTML).toBe("");
  });

  test("open on first render is simply there, not easing in", async () => {
    await mount(reveal(true, "here"));
    expect(box()?.style.gridTemplateRows).toBe("1fr");
    expect(box()?.textContent).toBe("here");
  });

  test("opening eases a collapsed box to its full height", async () => {
    await mount(reveal(false, null));
    await rerender(reveal(true, "joined"));
    const el = box();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("joined");
    expect(el!.style.gridTemplateRows).toBe("1fr");
    expect(el!.style.transition).toContain(`grid-template-rows ${motion.layoutMs}ms`);
  });

  test("closing keeps the last content while the room closes, then unmounts", async () => {
    jest.useFakeTimers();
    await mount(reveal(true, "maya is here"));
    await rerender(reveal(false, null));
    const el = box();
    expect(el?.textContent).toBe("maya is here");
    expect(el?.style.gridTemplateRows).toBe("0fr");
    expect(el?.style.opacity).toBe("0");
    await act(async () => {
      jest.advanceTimersByTime(motion.layoutMs);
    });
    expect(host!.innerHTML).toBe("");
  });

  test("reopening mid-close turns around instead of vanishing", async () => {
    jest.useFakeTimers();
    await mount(reveal(true, "a"));
    await rerender(reveal(false, null));
    await rerender(reveal(true, "b"));
    await act(async () => {
      jest.advanceTimersByTime(motion.layoutMs * 2);
    });
    expect(box()?.textContent).toBe("b");
    expect(box()?.style.gridTemplateRows).toBe("1fr");
  });
});

describe("useArrivals", () => {
  let latest: ReadonlySet<string> = new Set();
  function Probe({ keys }: { keys: readonly string[] }) {
    latest = useArrivals(keys);
    return null;
  }
  const probe = (keys: readonly string[]) => createElement(Probe, { keys });

  test("the first load is not an arrival", async () => {
    await mount(probe(["a", "b"]));
    expect([...latest]).toEqual([]);
  });

  test("a row somebody else added is", async () => {
    await mount(probe(["a", "b"]));
    await rerender(probe(["a", "new", "b"]));
    expect([...latest]).toEqual(["new"]);
  });

  test("a rename is not an arrival", async () => {
    await mount(probe(["a", "b"]));
    await rerender(probe(["a", "c"]));
    expect([...latest]).toEqual([]);
  });

  test("a whole folder's worth at once is not", async () => {
    await mount(probe(["a"]));
    const many = Array.from({ length: MAX_ARRIVALS + 1 }, (_, i) => `n${i}`);
    await rerender(probe(["a", ...many]));
    expect([...latest]).toEqual([]);
  });
});
