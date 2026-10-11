/**
 * THE REPLAY'S READS: what AI clients read, as the gateway keeps it, turned
 * into replay events that draw the same face as the same tool's edits. Fake
 * names and paths only.
 */
import { describe, expect, test } from "@jest/globals";
import { eventsFromHistory } from "../features/console/map/live/convert";
import { actorsAt } from "../features/console/map/live/engine/timeline";
import { decodeStoredReads, eventsFromStoredReads } from "../features/console/map/live/storedReads";

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
});
