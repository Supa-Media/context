/**
 * THE REPLAY'S READS: what AI clients read, as the gateway keeps it, turned
 * into replay events that draw the same face as the same tool's edits. Fake
 * names and paths only.
 */
import { describe, expect, test } from "@jest/globals";
import { eventsFromHistory } from "../features/console/map/live/convert";
import { actorsAt } from "../features/console/map/live/engine/timeline";
import { decodeStoredReads, eventsFromStoredReads, fetchStoredReads } from "../features/console/map/live/storedReads";

describe("stored reads", () => {
  test("an answer is re-checked field by field, and anything else is no reads", () => {
    expect(decodeStoredReads(null)).toEqual([]);
    expect(decodeStoredReads({ reads: "x" })).toEqual([]);
    const reads = decodeStoredReads({
      reads: [
        { at: 10, path: "a.md", tool: "fetch", by: "@m", via: "Claude" },
        { at: "soon", path: "b.md" },
        { at: 11, path: "" },
        { at: 12, path: "c.md", by: 4 },
      ],
    });
    expect(reads).toEqual([
      { at: 10, path: "a.md", tool: "fetch", by: "@m", via: "Claude" },
      { at: 12, path: "c.md", tool: "read_note", by: null, via: null },
    ]);
  });

  test("a read is the same face as the same tool's edit in the activity feed", () => {
    const reads = eventsFromStoredReads(
      [
        { at: 10, path: "1-projects/plan.md", tool: "read_note", by: "@m", via: "Claude" },
        { at: 11, path: "1-projects/diagram.png", tool: "fetch", by: "@m", via: "Claude" },
      ],
      "w",
    );
    const edits = eventsFromHistory(
      [{ at: new Date(20).toISOString(), kind: "revised", paths: ["1-projects/plan.md"], by: "@m", via: "Claude" }],
      "w",
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ kind: "read", path: "1-projects/plan.md", workspaceId: "w" });
    expect(reads[0].actor).toEqual(edits[0].actor);
    expect(reads[0].actor.kind).toBe("agent");
  });

  test("the replay lists what an AI read, in order, up to the playhead", () => {
    const events = eventsFromStoredReads(
      [
        { at: 1_000, path: "a.md", tool: "read_note", by: "@m", via: "Claude" },
        { at: 2_000, path: "b.md", tool: "read_note", by: "@m", via: "Claude" },
        { at: 9_000, path: "c.md", tool: "read_note", by: "@m", via: "Claude" },
      ],
      "w",
    );
    const [actor] = actorsAt(events, 5_000, 60_000);
    expect(actor.doing).toBe("read");
    expect(actor.path).toBe("b.md");
    expect(actor.reads).toEqual(["a.md", "b.md"]);
  });

  test("it asks the workspace's gateway with that workspace's grant, and a failure is no reads", async () => {
    const asked: Array<{ url: string; token: string }> = [];
    const events = await fetchStoredReads(
      {
        origin: "https://gateway.test",
        mint: async (id) => ({ accessToken: `token-${id}` }),
        fetchJson: async (url, token) => {
          asked.push({ url, token });
          return { reads: [{ at: 5, path: "a.md", tool: "read_note", by: "@m", via: "Claude" }] };
        },
      },
      "w1",
      1.5,
      9.7,
    );
    expect(asked).toEqual([{ url: "https://gateway.test/agent-activity?reads_since=1&reads_until=9", token: "token-w1" }]);
    expect(events).toHaveLength(1);
    const failed = await fetchStoredReads(
      {
        origin: "https://gateway.test",
        mint: async () => {
          throw new Error("no grant");
        },
        fetchJson: async () => null,
      },
      "w1",
      0,
      1,
    );
    expect(failed).toEqual([]);
  });
});
