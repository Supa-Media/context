import { describe, expect, test } from "@jest/globals";
import { blendDeviceAnswers, deviceSearchPageNotice } from "../features/console/search/deviceSearch";
import { DEVICE_SEARCH_UNAVAILABLE } from "../features/offline/mirrorCopy";
import type { DeviceSearchAnswer } from "../features/offline/mirrorSearch";
import type { MirrorStatus } from "../features/offline/mirrorStatus";

/**
 * The search page with no connection: every context in scope searched from
 * its copy on the device, blended the way the control plane blends — by rank,
 * never by score — and labelled as the device's.
 *
 * Fixtures are invented.
 */

const ALICE = { workspaceId: "ws_alice", slug: "alice", displayName: "Alice" };
const TEAM = { workspaceId: "ws_team", slug: "team", displayName: "Team" };

function answer(paths: string[], over: Partial<DeviceSearchAnswer> = {}): DeviceSearchAnswer {
  return {
    hits: paths.map((path) => ({ path, title: path.replace(/\.md$/, ""), snippets: [`in ${path}`] })),
    matchCount: paths.length,
    searched: 10,
    encryptedSkipped: 0,
    mirrored: true,
    ...over,
  };
}

const SYNCED: MirrorStatus = { state: "synced", notes: 10, bytes: 1, lastSyncedAt: 1 };

describe("blending the device's answers", () => {
  test("interleaves by rank, so no context sweeps the page", () => {
    const blended = blendDeviceAnswers([
      { context: ALICE, answer: answer(["a1.md", "a2.md", "a3.md"]), status: SYNCED },
      { context: TEAM, answer: answer(["t1.md"]), status: SYNCED },
    ]);
    expect(blended.results.map((row) => `${row.slug}:${row.path}`)).toEqual([
      "alice:a1.md",
      "team:t1.md",
      "alice:a2.md",
      "alice:a3.md",
    ]);
    expect(blended.results[0]).toEqual({
      ...ALICE,
      path: "a1.md",
      title: "a1",
      snippet: "in a1.md",
    });
    expect(blended.cursor).toBeNull();
    expect(blended.searchableCount).toBe(2);
    expect(blended.matchCount).toBe(4);
    expect(blended.matchCountIsFloor).toBe(false);
  });

  test("a partial copy or a capped list makes the count a floor", () => {
    const partial: MirrorStatus = { ...SYNCED, state: "partial", remaining: 3, total: 13 };
    expect(
      blendDeviceAnswers([{ context: ALICE, answer: answer(["a.md"]), status: partial }])
        .matchCountIsFloor,
    ).toBe(true);
    expect(
      blendDeviceAnswers([
        { context: ALICE, answer: answer(["a.md"], { matchCount: 80 }), status: SYNCED },
      ]).matchCountIsFloor,
    ).toBe(true);
  });

  test("a context with nothing on the device is not a source that answered 'nothing'", () => {
    const blended = blendDeviceAnswers([
      { context: ALICE, answer: answer(["a.md"]), status: SYNCED },
      { context: TEAM, answer: answer([], { mirrored: false, searched: 0 }), status: undefined },
    ]);
    expect(blended.sources.map((source) => source.slug)).toEqual(["alice"]);
    expect(blended.matchCountIsFloor).toBe(true);
  });
});

describe("what the page says about it", () => {
  test("offline, a whole copy is one sentence", () => {
    expect(
      deviceSearchPageNotice("offline", [{ context: ALICE, answer: answer([]), status: SYNCED }]),
    ).toBe("Searched the copies on this device.");
  });

  test("names each context that is not all here, and what was skipped", () => {
    const text = deviceSearchPageNotice("unreachable", [
      {
        context: ALICE,
        answer: answer([], { encryptedSkipped: 1 }),
        status: { state: "partial", notes: 340, bytes: 1, lastSyncedAt: 1, remaining: 864, total: 1_204 },
      },
      { context: TEAM, answer: answer([], { mirrored: false }), status: undefined },
    ]);
    expect(text).toBe(
      "Search could not reach your contexts, so this searched the copies on this device. " +
        "@alice: only 340 of 1,204 notes are on this device yet. " +
        "@team: nothing is on this device yet. " +
        "1 encrypted note was not searched.",
    );
  });

  test("a browser with no copy at all says search needs a connection", () => {
    expect(
      deviceSearchPageNotice("offline", [
        { context: ALICE, answer: null, status: undefined },
        { context: TEAM, answer: null, status: undefined },
      ]),
    ).toBe(DEVICE_SEARCH_UNAVAILABLE);
  });
});
