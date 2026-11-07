import { describe, expect, test } from "vitest";
import { replayChat } from "../functions/texThreadsBackfill";

/**
 * The sweep that replays every chat's history into its conversations
 * (`functions/texThreadsBackfill.ts`). The replay itself is the gateway's
 * (`apps/mcp/test/threadsBackfill.test.mjs`); this holds the sweep to calling
 * a chat part after part until it is finished, and to stopping when its time is up.
 *
 * Sabotage record (2026-11-07): `replayChat` calling one part only → "a long
 * chat is called part after part until it is finished" fails.
 */

const part = (state: string) => ({ state, turns: 40, written: 45, failed: 1, left: 0 });

describe("each chat is replayed to the end", () => {
  test("a long chat is called part after part until it is finished", async () => {
    const states = ["partly", "partly", "finished"];
    let calls = 0;
    const replayed = await replayChat(async () => part(states[calls++]), () => true);
    expect(calls).toBe(3);
    expect(replayed.last?.state).toBe("finished");
    expect(replayed).toMatchObject({ turns: 120, written: 135, unsorted: 3 });
  });

  test("a chat already replayed costs one call", async () => {
    let calls = 0;
    const replayed = await replayChat(async () => (calls++, { state: "done", turns: 0, written: 0, failed: 0, left: 0 }), () => true);
    expect(calls).toBe(1);
    expect(replayed.last?.state).toBe("done");
  });

  test("when the time is up it stops, partly, for the next run", async () => {
    let calls = 0;
    const replayed = await replayChat(async () => part("partly"), () => calls++ < 2);
    expect(replayed.last?.state).toBe("partly");
  });
});
