/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  SEARCH_TIMEOUT_MS,
  useContextSearch,
  type ContextSearch,
  type DeviceSearch,
} from "../features/console/files/useContextSearch";
import type { SearchAnswer } from "../features/console/files/browser";
import type { DeviceSearchAnswer } from "../features/offline/mirrorSearch";
import { DEVICE_SEARCH_UNAVAILABLE } from "../features/offline/mirrorCopy";
import type { MirrorStatus } from "../features/offline/mirrorStatus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * When the palette answers from the copy on the device, and what it says when
 * it does.
 *
 * The rule, from the owner's brief: offline, the device answers **at once** —
 * the bucket is not asked, so there is no ten-second wait for an answer that
 * cannot come. Online, the bucket answers as it always has, and only when it
 * fails or times out does the device step in, **saying so**. Results from the
 * device are never passed off as the bucket's, and a partial copy never as a
 * whole one.
 *
 * Sabotage: asking the server first while offline reddens "offline never
 * waits on the bucket"; dropping the fallback reddens both "a bucket that…"
 * tests; dropping the notice reddens every assertion on `notice`.
 */

function mount(
  search: ((query: string) => Promise<SearchAnswer>) | null,
  device: DeviceSearch | null,
) {
  const seen: { current: ContextSearch | null } = { current: null };
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    seen.current = useContextSearch(search, device);
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    get value() {
      return seen.current!;
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

const DEBOUNCE_MS = 250;
async function type(probe: { value: ContextSearch }, query: string) {
  act(() => probe.value.onQuery(query));
  await act(async () => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
}

const serverAnswer: SearchAnswer = {
  hits: [{ path: "1-projects/server.md", title: "From the bucket", snippets: ["a line"] }],
  indexMissing: false,
  indexIncomplete: false,
  reducedRecall: false,
  reducedRecallNotes: [],
};

function deviceAnswer(over: Partial<DeviceSearchAnswer> = {}): DeviceSearchAnswer {
  return {
    hits: [
      { path: "2-areas/people/layomi.md", title: "Layomi", snippets: ["met at the review"] },
    ],
    matchCount: 1,
    searched: 40,
    encryptedSkipped: 0,
    mirrored: true,
    ...over,
  };
}

function device(
  over: Partial<DeviceSearch> & { answer?: DeviceSearchAnswer | null } = {},
): DeviceSearch & { search: jest.Mock<(query: string) => Promise<DeviceSearchAnswer | null>> } {
  const answer = over.answer === undefined ? deviceAnswer() : over.answer;
  return {
    reachability: over.reachability ?? "offline",
    status: over.status,
    search: jest.fn(async () => answer),
  };
}

const SYNCED: MirrorStatus = { state: "synced", notes: 40, bytes: 1, lastSyncedAt: 1 };

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("offline, the device answers", () => {
  test("offline never waits on the bucket", async () => {
    const server = jest.fn(() => new Promise<SearchAnswer>(() => {}));
    const local = device({ status: SYNCED });
    const probe = mount(server, local);
    await type(probe, "layomi");
    // One debounce and no more: not the ten-second deadline, not any of it.
    expect(server).not.toHaveBeenCalled();
    expect(local.search).toHaveBeenCalledWith("layomi");
    expect(probe.value.state).toBe("ready");
    expect(probe.value.items.map((item) => item.id)).toEqual(["2-areas/people/layomi.md"]);
    expect(probe.value.source).toBe("device");
    expect(probe.value.heading).toBe("On this device");
    expect(probe.value.notice).toBe("Searched the copy on this device.");
    probe.unmount();
  });

  test("a partial copy says how much of it there is, and what was skipped", async () => {
    const probe = mount(
      jest.fn(async () => serverAnswer),
      device({
        status: {
          state: "partial",
          notes: 340,
          bytes: 1,
          lastSyncedAt: 1,
          remaining: 864,
          total: 1_204,
          truncatedReason: "interrupted",
        },
        answer: deviceAnswer({ encryptedSkipped: 2 }),
      }),
    );
    await type(probe, "layomi");
    expect(probe.value.notice).toBe(
      "Searched the copy on this device. Only 340 of 1,204 notes are on this device yet. 2 encrypted notes were not searched.",
    );
    probe.unmount();
  });

  test("a browser with no copy says search needs a connection, at once", async () => {
    const server = jest.fn(() => new Promise<SearchAnswer>(() => {}));
    const probe = mount(server, device({ answer: null }));
    await type(probe, "layomi");
    expect(server).not.toHaveBeenCalled();
    expect(probe.value.state).toBe("failed");
    expect(probe.value.notice).toBe(DEVICE_SEARCH_UNAVAILABLE);
    probe.unmount();
  });

  test("a context with nothing on the device is not 'no matches'", async () => {
    const probe = mount(
      jest.fn(async () => serverAnswer),
      device({ answer: deviceAnswer({ hits: [], matchCount: 0, mirrored: false }) }),
    );
    await type(probe, "layomi");
    expect(probe.value.items).toEqual([]);
    expect(probe.value.notice).toMatch(/Nothing from this context is on this device yet/);
    expect(probe.value.emptyMessage).toMatch(/nothing .*to search/i);
    probe.unmount();
  });
});

describe("online, the bucket answers, and the device only steps in", () => {
  test("a working bucket is what answers, and nothing is said about the device", async () => {
    const local = device({ reachability: "online" });
    const probe = mount(jest.fn(async () => serverAnswer), local);
    await type(probe, "layomi");
    expect(local.search).not.toHaveBeenCalled();
    expect(probe.value.items.map((item) => item.id)).toEqual(["1-projects/server.md"]);
    expect(probe.value.source).toBe("server");
    expect(probe.value.notice).toBeNull();
    expect(probe.value.heading).toBeUndefined();
    probe.unmount();
  });

  test("a bucket that refuses falls back to the device, and says so", async () => {
    const probe = mount(
      jest.fn(async () => {
        throw new Error("network");
      }),
      device({ reachability: "online", status: SYNCED }),
    );
    await type(probe, "layomi");
    expect(probe.value.state).toBe("ready");
    expect(probe.value.items.map((item) => item.id)).toEqual(["2-areas/people/layomi.md"]);
    expect(probe.value.notice).toBe(
      "Your bucket did not answer, so this searched the copy on this device.",
    );
    probe.unmount();
  });

  test("a bucket that never answers falls back when the deadline passes", async () => {
    const probe = mount(
      jest.fn(() => new Promise<SearchAnswer>(() => {})),
      device({ reachability: "unknown", status: SYNCED }),
    );
    await type(probe, "layomi");
    expect(probe.value.state).toBe("searching");
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_TIMEOUT_MS);
    });
    expect(probe.value.state).toBe("ready");
    expect(probe.value.source).toBe("device");
    probe.unmount();
  });

  test("with no copy to fall back on, a failure is still a failure", async () => {
    const probe = mount(
      jest.fn(async () => {
        throw new Error("network");
      }),
      device({ reachability: "online", answer: null }),
    );
    await type(probe, "layomi");
    expect(probe.value.state).toBe("failed");
    expect(probe.value.items).toEqual([]);
    probe.unmount();
  });
});
