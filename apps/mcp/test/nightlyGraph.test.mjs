/**
 * Tex's nightly work runs as config nodes (Dev2, 2026-11-14: "the connections between nodes come from the config
 * graph, nodes are code"). The wires `nightly` -> `dream` -> `daysum` and `nightly` -> `housekeep` are read from
 * `texConfig.json` by the shared runner (`packages/shared/src/texGraph.cjs`); these tests run the real config with
 * stub nodes, and the real `nodes/nightly.js`.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `nightly` sends "housekeeping" as "dream"                   "a housekeeping night runs housekeep, not dream" fails
 *   the dream stub's `when` ignored (wire always fires)         "a dream with nothing to summarize skips the summaries" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import nightly from "../src/agent/graph/nodes/nightly.js";

const { createGraph } = graphLib;

/** The shared runner over the real config, with stub nodes that record what they were given. */
function nightGraph({ dreamWhen = ["summarize"] } = {}) {
  const seen = [];
  const graph = createGraph(
    TEX_CONFIG,
    {
      nightly: (input) => ({ to: input.run, timeZone: input.timeZone, ...(input.since !== undefined ? { since: input.since } : {}) }),
      dream: async (input) => {
        seen.push(["dream", input]);
        return { outcome: "dreamed", status: 200, body: { outcome: "dreamed" }, when: dreamWhen, timeZone: input.timeZone, now: 1 };
      },
      daysum: async (input) => {
        seen.push(["daysum", input]);
        return { outcome: "done" };
      },
      housekeep: async (input) => {
        seen.push(["housekeep", input]);
        return { outcome: "unchanged", status: 200 };
      },
    },
    { log: () => {} },
  );
  return { graph, seen };
}

test("a dream night runs the dream and then the day summaries, in the config's order", async () => {
  const { graph, seen } = nightGraph();
  const { ran, outputs } = await graph.run("nightly", { run: "dream", timeZone: "Europe/London", since: 42 }, {});
  assert.deepEqual(ran, ["nightly", "dream", "daysum"]);
  assert.equal(outputs.dream.status, 200);
  assert.deepEqual(seen[0], ["dream", { to: "dream", timeZone: "Europe/London", since: 42 }]);
  assert.deepEqual(seen[1][0], "daysum");
});

test("a dream that summed nothing up (when: []) does not run the day summaries", async () => {
  const { graph } = nightGraph({ dreamWhen: [] });
  const { ran } = await graph.run("nightly", { run: "dream", timeZone: "UTC" }, {});
  assert.deepEqual(ran, ["nightly", "dream"]);
});

test("a housekeeping night runs housekeep, never the dream", async () => {
  const { graph, seen } = nightGraph();
  const { ran, outputs } = await graph.run("nightly", { run: "housekeeping", timeZone: "UTC" }, {});
  assert.deepEqual(ran, ["nightly", "housekeep"]);
  assert.equal(outputs.housekeep.status, 200);
  assert.deepEqual(seen, [["housekeep", { to: "housekeeping", timeZone: "UTC" }]]);
});

test("the real nightly node starts each night and passes `since` only when given", async () => {
  assert.deepEqual(await nightly({ run: "dream", timeZone: "UTC", since: 7 }), { to: "dream", timeZone: "UTC", since: 7 });
  assert.deepEqual(await nightly({ run: "dream", timeZone: "UTC" }), { to: "dream", timeZone: "UTC" });
  assert.deepEqual(await nightly({ run: "housekeeping", timeZone: "UTC" }), { to: "housekeeping", timeZone: "UTC" });
});

test("the real nightly node refuses a run it does not know", async () => {
  await assert.rejects(nightly({ run: "nap", timeZone: "UTC" }), TypeError);
});
