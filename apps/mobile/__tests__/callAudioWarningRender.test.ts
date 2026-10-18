/**
 * @jest-environment jsdom
 */

/**
 * ONE SIDE OF A CALL, SAID WHERE IT CANNOT BE MISSED, WITH THE FIX BESIDE IT.
 *
 * The console's live card and the phone's meeting screen both draw this band.
 * Before it, a declined share was one truncated chip line on the phone and
 * nothing at all on the console, and people recorded whole calls that held
 * only their own voice.
 *
 * ## Sabotage record
 *
 *  - The band drawn only while `captureError` is set (the old chip's trigger):
 *    "a missing call is a band with a button" fails.
 *  - The button kept on the desktop app: "the desktop app's band has no
 *    button" fails.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

let mockWarning: string | null = null;
let mockLive: unknown = { session: { id: "m1" } };
let mockNeedsPicker = true;
let mockNote: { kind: "skipped" | "room"; message: string } | null = null;
let mockCapture: { audio?: boolean; systemAudio?: boolean } = {};
const mockShares: number[] = [];

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({
    live: mockLive,
    callAudioWarning: mockWarning,
    callAudioNote: mockNote,
    capture: { systemAudioNeedsPicker: mockNeedsPicker, ...mockCapture },
  }),
}));

jest.mock("../features/meetings/controller", () => ({
  meetings: {
    shareCallAudio: () => {
      mockShares.push(1);
      return Promise.resolve(true);
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CallAudioWarning } from "../features/meetings/components/CallAudioWarning";

const MISSING = "Only your voice is being recorded.";
const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  mockWarning = null;
  mockLive = { session: { id: "m1" } };
  mockNeedsPicker = true;
  mockNote = null;
  mockCapture = {};
  mockShares.length = 0;
  setBrowser(REAL_UA, REAL_PLATFORM);
});

const REAL_UA = navigator.userAgent;
const REAL_PLATFORM = navigator.platform;

function setBrowser(userAgent: string, platform: string): void {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

const MAC_EDGE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(CallAudioWarning, { testID: "band" })));
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const find = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("the call-audio band", () => {
  test("a missing call is a band with a button", () => {
    mockWarning = MISSING;
    const container = mount();
    expect(find(container, "band")?.textContent).toContain(MISSING);
    act(() => find(container, "band-share")?.click());
    expect(mockShares).toHaveLength(1);
  });

  test("nothing is drawn when both sides are in the recording", () => {
    const container = mount();
    expect(find(container, "band")).toBeNull();
  });

  test("nothing is drawn once the meeting has ended", () => {
    mockWarning = MISSING;
    mockLive = null;
    const container = mount();
    expect(find(container, "band")).toBeNull();
  });

  test("the desktop app's band has no button, because its fix is a system setting", () => {
    mockWarning = MISSING;
    mockNeedsPicker = false;
    const container = mount();
    expect(find(container, "band")).not.toBeNull();
    expect(find(container, "band-share")).toBeNull();
  });

  test("the fix names the picker's sound switch", () => {
    mockWarning = MISSING;
    setBrowser(MAC_CHROME, "MacIntel");
    const container = mount();
    expect(find(container, "band")?.textContent).toContain("turn on Also share system audio");
    // Chrome on a Mac gets no restart line: the switch is its whole fix.
    expect(find(container, "band-mac")).toBeNull();
  });

  test("a Mac browser that is not Chrome is told to restart it, or where else to record", () => {
    mockWarning = MISSING;
    setBrowser(MAC_EDGE, "MacIntel");
    const container = mount();
    const mac = find(container, "band-mac")?.textContent ?? "";
    expect(mac).toContain("Quit and reopen Edge");
    expect(mac).toContain("Mac app");
  });

  test("a browser that stopped being asked says so quietly, with Try again", () => {
    mockNote = {
      kind: "skipped",
      message: "Recording your voice only. Edge didn't share call audio the last two times.",
    };
    const container = mount();
    expect(find(container, "band-note")?.textContent).toContain("Try again");
    act(() => find(container, "band-share")?.click());
    expect(mockShares).toHaveLength(1);
  });

  test("a room meeting offers to add the call", () => {
    mockNote = { kind: "room", message: "Recording the room." };
    const container = mount();
    expect(find(container, "band-note")?.textContent).toBe("Recording the room. Add call audio");
  });

  test("a computer browser that can never share sound says so, once", () => {
    mockNeedsPicker = false;
    mockCapture = { audio: true, systemAudio: false };
    setBrowser(MAC_SAFARI, "MacIntel");
    const container = mount();
    expect(find(container, "band-cannot")?.textContent).toContain(
      "Safari can't hear the call, only your voice.",
    );
  });

  test("...but not on a phone, where no browser can", () => {
    mockNeedsPicker = false;
    mockCapture = { audio: true, systemAudio: false };
    setBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", "iPhone");
    const container = mount();
    expect(find(container, "band-cannot")).toBeNull();
  });
});
