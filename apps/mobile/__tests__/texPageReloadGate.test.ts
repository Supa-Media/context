/**
 * @jest-environment jsdom
 */

/**
 * The Tex page reads itself again at most once per gap, however many changes
 * the live feed announces (2026-11-17): a busy turn's stream of "read it
 * again" frames used to start one whole read each, hundreds a minute, which
 * overloaded the person's own workspace object and failed their sign-ins.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-17):
 *  1. `onPatch` calling `load()` directly again → "a burst of a hundred
 *     changes costs one read now and one owed" fails (dozens of reads).
 *  2. `reloadGate` starting a read while one runs → "never two reads at once"
 *     fails.
 *  3. `reloadGate` dropping a request inside the gap instead of owing it →
 *     "a change inside the gap is read once the gap ends, never lost" fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { reloadGate, RELOAD_GAP_MS } from "../features/tex/page/reloadGate";
import { fixtureSource } from "../features/tex/page/texPageFixture";
import type { PatchFrame } from "../features/tex/page/texPageLive";
import type { TexPageSource } from "../features/tex/page/texPageSource";
import { forgetTexPages } from "../features/tex/page/texPageMemory";
import { useTexPage } from "../features/tex/page/useTexPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** A clock and timers the test moves by hand. */
function manualTime() {
  let clock = 1_000_000;
  const timers: Array<{ at: number; run: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => clock,
    later: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: clock + ms, run, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((t) => t.id === (handle as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      clock += ms;
      for (const t of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(t), 1);
        t.run();
      }
      await flush();
    },
    pending: () => timers.length,
  };
}

describe("reloadGate", () => {
  test("a burst of a hundred requests costs one read now and one owed, made when the gap ends", async () => {
    const time = manualTime();
    let reads = 0;
    const gate = reloadGate(async () => void reads++, time);
    for (let i = 0; i < 100; i++) gate.request();
    await flush();
    expect(reads).toBe(1);
    await time.advance(RELOAD_GAP_MS);
    expect(reads).toBe(2);
    // Nothing more was asked: nothing more is read.
    await time.advance(RELOAD_GAP_MS * 5);
    expect(reads).toBe(2);
  });

  test("never two reads at once", async () => {
    const time = manualTime();
    let open = 0;
    let most = 0;
    const finish: Array<() => void> = [];
    const gate = reloadGate(
      () =>
        new Promise<void>((resolve) => {
          open++;
          most = Math.max(most, open);
          finish.push(() => {
            open--;
            resolve();
          });
        }),
      time,
    );
    gate.request();
    await flush();
    // The read is slower than the gap: asks while it runs wait for it.
    await time.advance(RELOAD_GAP_MS * 3);
    gate.request();
    gate.request();
    await flush();
    expect(most).toBe(1);
    finish.shift()!();
    await flush();
    // The owed read starts once the first ends (the gap has long passed), and only then.
    expect(open).toBe(1);
    expect(most).toBe(1);
  });

  test("a change inside the gap is read once the gap ends, never lost", async () => {
    const time = manualTime();
    let reads = 0;
    const gate = reloadGate(async () => void reads++, time);
    gate.request();
    await flush();
    await time.advance(RELOAD_GAP_MS / 2);
    gate.request();
    await flush();
    expect(reads).toBe(1);
    expect(time.pending()).toBe(1);
    await time.advance(RELOAD_GAP_MS / 2);
    expect(reads).toBe(2);
  });

  test("a read owed when the page closes is never made", async () => {
    const time = manualTime();
    let reads = 0;
    const gate = reloadGate(async () => void reads++, time);
    gate.request();
    await flush();
    gate.request();
    gate.cancel();
    await time.advance(RELOAD_GAP_MS * 2);
    expect(reads).toBe(1);
  });
});

describe("the Tex page under a stream of changes", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    forgetTexPages();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("a hundred 'read it again' frames cost two reads of the page, not a hundred", async () => {
    const base = fixtureSource();
    let overviews = 0;
    let push: ((patch: PatchFrame) => void) | null = null;
    const source: TexPageSource = {
      ...base,
      async overview(chat, part) {
        overviews++;
        return base.overview(chat, part);
      },
      live(_chat, onPatch, onLive) {
        push = onPatch;
        onLive(true);
        return { close: () => {} } as ReturnType<NonNullable<TexPageSource["live"]>>;
      },
    };
    function Harness() {
      useTexPage(source, "me");
      return null;
    }
    act(() => root.render(createElement(Harness)));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const afterOpen = overviews;
    await act(async () => {
      for (let i = 0; i < 100; i++) push!({ section: i % 3 === 0 ? "thinking" : i % 3 === 1 ? "behind" : "tiles" } as PatchFrame);
      await new Promise((r) => setTimeout(r, 0));
    });
    // Each read asks the first screen and the tiles side by side: two asks per read.
    // Opening reads once; the burst adds at most one read more, owed until the gap ends.
    expect(afterOpen).toBe(2);
    expect(overviews - afterOpen).toBeLessThanOrEqual(2);
    await act(async () => {
      await new Promise((r) => setTimeout(r, RELOAD_GAP_MS + 50));
    });
    expect(overviews - afterOpen).toBeLessThanOrEqual(2);
  });
});
