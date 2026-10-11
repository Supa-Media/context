/**
 * THE REPLAY'S HISTORY IN ONE ASK PER WORKSPACE, and the way back to the old
 * two asks when the gateway is older than the history parameters. Fake names
 * and paths only.
 */
import { describe, expect, test } from "@jest/globals";
import {
  decodeHistory,
  decodeHistoryDays,
  mergeHistoryDays,
  workspaceHistory,
  workspaceHistoryDays,
  type ReplayHistoryDeps,
} from "../features/console/map/live/replayHistory";

const iso = (ms: number) => new Date(ms).toISOString();

function deps(answer: unknown, calls: { gateway: string[]; listed: number; minted: number }): ReplayHistoryDeps {
  return {
    origin: "https://gateway.test",
    mint: async (id) => {
      calls.minted += 1;
      return { accessToken: `token-${id}` };
    },
    fetchJson: async (url) => {
      calls.gateway.push(url);
      return answer;
    },
    listActivity: async () => {
      calls.listed += 1;
      return [{ at: iso(30), kind: "added", paths: ["1-projects/old.md"], by: "@m", via: null }];
    },
  };
}

describe("replay history", () => {
  test("a current gateway is asked once, and nothing else is", async () => {
    const calls = { gateway: [] as string[], listed: 0, minted: 0 };
    const events = await workspaceHistory(
      deps(
        {
          history: {
            entries: [
              { at: iso(20), kind: "revised", paths: ["1-projects/plan.md"], by: "@m", via: "Claude" },
              { at: iso(10), kind: "added", paths: ["1-projects/ancient.md"], by: null, via: null, agent: true },
            ],
            reads: [{ at: 25, path: "1-projects/plan.md", tool: "read_note", by: "@m", via: "Claude" }],
            complete: true,
          },
        },
        calls,
      ),
      "w1",
      1.5,
      99.7,
    );
    expect(calls.gateway).toEqual([
      "https://gateway.test/agent-activity?history_since=1&history_until=99&reads_since=1&reads_until=99",
    ]);
    expect(calls.listed).toBe(0);
    expect(events.map((e) => e.kind).sort()).toEqual(["create", "edit", "read"]);
    const ancient = events.find((e) => e.kind === "create");
    expect(ancient?.actor.kind).toBe("agent");
  });

  test("an older gateway's answer has no history: the lines come from the control plane, the reads from that answer", async () => {
    const calls = { gateway: [] as string[], listed: 0, minted: 0 };
    const events = await workspaceHistory(
      deps({ reads: [{ at: 40, path: "a.md", tool: "read_note", by: "@m", via: "Claude" }], readsTruncated: false }, calls),
      "w1",
      0,
      100,
    );
    expect(calls.gateway).toHaveLength(1);
    expect(calls.listed).toBe(1);
    expect(events.map((e) => e.kind).sort()).toEqual(["create", "read"]);
  });

  test("a gateway that cannot be reached still leaves the control plane's lines", async () => {
    const calls = { gateway: [] as string[], listed: 0, minted: 0 };
    const failing = { ...deps(null, calls), mint: async () => Promise.reject(new Error("no grant")) };
    const events = await workspaceHistory(failing, "w1", 0, 100);
    expect(calls.listed).toBe(1);
    expect(events).toHaveLength(1);
  });

  test("an answer is re-checked field by field", () => {
    expect(decodeHistory(null)).toBeNull();
    expect(decodeHistory({ history: { entries: "x", reads: [] } })).toBeNull();
    const decoded = decodeHistory({
      history: {
        entries: [{ at: "x", kind: "added", paths: [] }, { at: iso(1), kind: "moved", paths: ["b.md", 4], moves: [["a.md", "b.md"], ["bad"]] }],
        reads: [{ at: "soon", path: "c.md" }],
        complete: false,
      },
    });
    expect(decoded).toEqual({
      entries: [{ at: iso(1), kind: "moved", paths: ["b.md"], by: null, via: null, moves: [["a.md", "b.md"]] }],
      reads: [],
      complete: false,
    });
  });
});

describe("history days", () => {
  test("a day's summary lands on local midnights, summed across workspaces, from the earliest start", async () => {
    const asked: string[] = [];
    const one = await workspaceHistoryDays(
      {
        origin: "https://gateway.test",
        mint: async (id) => ({ accessToken: `token-${id}` }),
        fetchJson: async (url) => {
          asked.push(url);
          return { historyDays: [{ day: "2026-10-01", count: 2 }, { day: "nope", count: 1 }, { day: "2026-10-02", count: 0 }], historyStartsAt: 50 };
        },
      },
      "w1",
      120,
    );
    expect(asked).toEqual(["https://gateway.test/agent-activity?history_days=1&tz_offset_min=120"]);
    expect(one).toEqual({ days: [{ at: new Date(2026, 9, 1).getTime(), count: 2 }], startsAt: 50 });
    const merged = mergeHistoryDays([one, null, { days: [{ at: new Date(2026, 9, 1).getTime(), count: 3 }], startsAt: 10 }]);
    expect(merged).toEqual({ days: [{ at: new Date(2026, 9, 1).getTime(), count: 5 }], startsAt: 10 });
  });

  test("a gateway without the summary is an empty strip", async () => {
    expect(decodeHistoryDays({ agents: [] })).toBeNull();
    const none = await workspaceHistoryDays(
      { origin: "https://gateway.test", mint: async () => ({ accessToken: "t" }), fetchJson: async () => ({ agents: [] }) },
      "w1",
    );
    expect(none).toBeNull();
    expect(mergeHistoryDays([none])).toEqual({ days: [], startsAt: null });
  });
});
