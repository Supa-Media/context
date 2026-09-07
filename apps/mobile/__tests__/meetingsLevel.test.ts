/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THE LEVEL METER, AND THE THREE STATES IT HAS TO KEEP APART.
 *
 * The bar had never moved on any build, and it was not a cosmetic gap: it is
 * the **only** feedback that exists while a recording is happening — frames,
 * segments and the note all arrive after the meeting is over. The owner spent
 * an evening reasonably concluding his microphone was dead, because the one
 * control a person reads as *"it can hear me"* looked identical whether the
 * microphone was live, denied, or nothing was running at all.
 *
 * So what is asserted here is **distinguishability**, not animation. A person
 * has to be able to tell these apart:
 *
 *   1. nothing is listening — flat, and this is CORRECT rather than broken
 *   2. listening, and the room is quiet — flat too, and visibly not (1)
 *   3. listening, and it can hear you — moving with the voice
 *
 * (1) and (2) are both flat rows, which is why the check is that they differ in
 * *height and tone* rather than that either of them moves. A meter that has to
 * animate to say "I am on" is a meter that says nothing in a silent room, which
 * is the state somebody recording alone spends most of a meeting in.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, MEASURED rather than predicted.
 * Ten checks in this file, all green at baseline:
 *
 *   `WAVEFORM_FLOOR` set equal to `WAVEFORM_IDLE` (states 1 and 2 collapse)   2
 *   `waveformProfile` ignoring `live` (a dead input drawn as a live one)      2
 *   `Waveform` colouring by `tone` alone rather than `tone && live`           1
 *   `useAudioLevel` answering `0` where it means "no meter"                   1
 *   the hook's effect returning no teardown (the meter never detaches)        1
 *   `loudest` taking `mic` only, ignoring the loopback channel                1
 *   the level clamped nowhere, so a reading past full scale runs off the bar  1
 *
 * The first two rows are the ones that matter, and each reddens both the pure
 * profile and the rendered mark — which is what proves those are not one check
 * written twice. Deltas rather than a total, for the reason
 * `docs/decisions/desktop.md` gives at length: a total is a number somebody
 * else's merge falsifies, and this file's own count is in the runner's output.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  Waveform,
  waveformProfile,
  WAVEFORM_IDLE,
  WAVEFORM_FLOOR,
  WAVEFORM_SILHOUETTE,
} = require("../features/meetings/components/Waveform") as typeof import("../features/meetings/components/Waveform");
const { LiveWaveform } =
  require("../features/meetings/components/LiveWaveform") as typeof import("../features/meetings/components/LiveWaveform");
const { loudest, useAudioLevel } =
  require("../features/meetings/capture/level") as typeof import("../features/meetings/capture/level");
/* eslint-enable @typescript-eslint/no-require-imports */

/** The tallest bar drawn, in points, from what actually reached the DOM. */
function barHeights(host: HTMLElement): number[] {
  return [...host.querySelectorAll<HTMLElement>("[data-testid='meter'] > *")].map((bar) =>
    Number.parseFloat(bar.style.height),
  );
}

function barColours(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-testid='meter'] > *")].map(
    (bar) => bar.style.backgroundColor,
  );
}

function mount(element: Parameters<ReturnType<typeof createRoot>["render"]>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    rerender: (next: typeof element) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

describe("the meter's three states", () => {
  test("nothing listening, listening-and-quiet, and listening-and-hearing are three different pictures", () => {
    const idle = waveformProfile({ live: false });
    const quiet = waveformProfile({ live: true, level: 0 });
    const speech = waveformProfile({ live: true, level: 0.7 });

    // 1 — flat, and deliberately so.
    expect(new Set(idle.fractions)).toEqual(new Set([WAVEFORM_IDLE]));
    expect(idle.live).toBe(false);

    // 2 — flat as well, and this is the state the old mark could not say. It is
    // the *gap* that carries it, so the gap is what is asserted.
    expect(new Set(quiet.fractions)).toEqual(new Set([WAVEFORM_FLOOR]));
    expect(quiet.live).toBe(true);
    expect(WAVEFORM_FLOOR).toBeGreaterThan(WAVEFORM_IDLE * 2);

    // 3 — the silhouette, above the floor, and never past full height.
    expect(Math.max(...speech.fractions)).toBeGreaterThan(WAVEFORM_FLOOR);
    expect(Math.max(...speech.fractions)).toBeLessThanOrEqual(1);
    expect(new Set(speech.fractions).size).toBe(WAVEFORM_SILHOUETTE.length);
  });

  test("a louder room is a taller bar, all the way up", () => {
    const tallest = (level: number) => Math.max(...waveformProfile({ live: true, level }).fractions);
    const rising = [0, 0.25, 0.5, 0.75, 1].map(tallest);
    for (let index = 1; index < rising.length; index += 1) {
      expect(rising[index]).toBeGreaterThan(rising[index - 1] as number);
    }
    expect(tallest(1)).toBe(1);
  });

  test("a level outside 0-1 is clamped rather than drawn off the end of the bar", () => {
    expect(Math.max(...waveformProfile({ live: true, level: 9 }).fractions)).toBe(1);
    expect(new Set(waveformProfile({ live: true, level: -4 }).fractions)).toEqual(
      new Set([WAVEFORM_FLOOR]),
    );
  });

  test("NO METER AT ALL IS NOT SILENCE — a phone draws the mark it always drew", () => {
    // `null` is "nothing here can tell you", and reading it as `0` would be the
    // invented fact this repo has shipped twice: a browser and a phone would
    // both claim a silent room they cannot hear.
    expect(waveformProfile({ live: true, level: null }).fractions).toEqual([...WAVEFORM_SILHOUETTE]);
    expect(waveformProfile({ live: true, level: Number.NaN }).fractions).toEqual([
      ...WAVEFORM_SILHOUETTE,
    ]);
  });

  test("a dead input is drawn muted whatever tone the caller asked for", () => {
    const off = mount(createElement(Waveform, { tone: "ok", live: false, testID: "meter" }));
    const on = mount(createElement(Waveform, { tone: "ok", live: true, level: 0, testID: "meter" }));

    expect(new Set(barHeights(off.host)).size).toBe(1);
    expect(new Set(barHeights(on.host)).size).toBe(1);
    // The two flat rows are the pair a person has to tell apart, and they do it
    // on both axes at once: taller, and a different colour.
    expect(Math.max(...barHeights(on.host))).toBeGreaterThan(Math.max(...barHeights(off.host)));
    expect(barColours(on.host)[0]).not.toBe(barColours(off.host)[0]);

    off.unmount();
    on.unmount();
  });
});

describe("the wire carries two channels and the glass draws one", () => {
  test("the meter is the louder of the microphone and the loopback tap", () => {
    expect(loudest({ mic: 0.8, systemAudio: 0.1 })).toBeCloseTo(0.8);
    // The half that matters on a signed build: the far side of a call is
    // talking and you are not, and the meter must not read that as silence.
    expect(loudest({ mic: 0, systemAudio: 0.6 })).toBeCloseTo(0.6);
  });

  test("a reading that is not a number is silence, not a bar of unknown height", () => {
    expect(loudest({ mic: Number.NaN, systemAudio: Number.POSITIVE_INFINITY })).toBe(0);
    expect(loudest({ mic: 4, systemAudio: -2 })).toBe(1);
  });
});

describe("the level reaches the leaf and nothing above it", () => {
  /** A component that reports what the hook answered, without a renderer tree. */
  function Probe({ live, bridgeOf }: { live: boolean; bridgeOf: () => never }) {
    const level = useAudioLevel(live, bridgeOf as never);
    return createElement("span", { "data-testid": "level" }, String(level));
  }

  const read = (host: HTMLElement) =>
    host.querySelector("[data-testid='level']")?.textContent ?? "";

  test("A LEVEL THE SHELL PUSHES BECOMES THE HEIGHT OF THE BAR", () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    const view = mount(createElement(LiveWaveform, { live: true, testID: "meter" }, null));

    // Nothing has been said yet, so the mark says "recording" and declines to
    // claim anything about loudness — the silhouette, not a flat row.
    expect(new Set(barHeights(view.host)).size).toBeGreaterThan(1);

    // The bridge is the real one from the package's fake, reached the way the
    // app reaches it: `getDesktopBridge()` off `window.desktop`.
    (window as unknown as { desktop: unknown }).desktop = shell.bridge;
    view.rerender(createElement(LiveWaveform, { live: false, testID: "meter" }, null));
    view.rerender(createElement(LiveWaveform, { live: true, testID: "meter" }, null));

    act(() => shell.emitLevel({ mic: 0, systemAudio: 0 }));
    const quiet = Math.max(...barHeights(view.host));
    expect(new Set(barHeights(view.host)).size).toBe(1);

    act(() => shell.emitLevel({ mic: 0.9, systemAudio: 0 }));
    const loud = Math.max(...barHeights(view.host));
    expect(loud).toBeGreaterThan(quiet);
    expect(new Set(barHeights(view.host)).size).toBeGreaterThan(1);

    act(() => shell.emitLevel({ mic: 0.05, systemAudio: 0 }));
    expect(Math.max(...barHeights(view.host))).toBeLessThan(loud);

    view.unmount();
    delete (window as unknown as { desktop?: unknown }).desktop;
  });

  test("a meeting that is not recording subscribes to nothing, and says nothing", () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    const bridgeOf = (() => shell.bridge) as unknown as () => never;
    const view = mount(createElement(Probe, { live: false, bridgeOf }));

    expect(read(view.host)).toBe("null");
    expect(shell.listenerCount()).toBe(0);

    view.rerender(createElement(Probe, { live: true, bridgeOf }));
    expect(shell.listenerCount()).toBe(1);
    act(() => shell.emitLevel({ mic: 0.5, systemAudio: 0.25 }));
    expect(read(view.host)).toBe("0.5");

    /*
      And going quiet is not the same as going away: a paused meeting passes
      `live={false}`, which drops the subscription AND the last reading. A hook
      that kept the number would leave a bar standing at whatever the room was
      doing when somebody pressed pause — a meter claiming a closed microphone
      is hearing them, which is the same lie in the other direction.
    */
    view.rerender(createElement(Probe, { live: false, bridgeOf }));
    expect(read(view.host)).toBe("null");
    expect(shell.listenerCount()).toBe(0);

    view.rerender(createElement(Probe, { live: true, bridgeOf }));
    view.unmount();
    expect(shell.listenerCount()).toBe(0);
  });

  test("a surface with no shell behind it reports no meter rather than silence", () => {
    const view = mount(createElement(Probe, { live: true, bridgeOf: (() => null) as never }));
    expect(read(view.host)).toBe("null");
    view.unmount();
  });
});
