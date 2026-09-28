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
const mockShares: number[] = [];

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({
    live: mockLive,
    callAudioWarning: mockWarning,
    capture: { systemAudioNeedsPicker: mockNeedsPicker },
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

const MISSING = "Only your side of this call is being recorded.";
const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  mockWarning = null;
  mockLive = { session: { id: "m1" } };
  mockNeedsPicker = true;
  mockShares.length = 0;
});

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
});
