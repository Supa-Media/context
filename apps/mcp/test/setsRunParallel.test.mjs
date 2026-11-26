/**
 * `runSets` runs the in-process nodes' tests (Decide, the job check, the reviewer) `parallel` at a time, so a Lab run
 * stays under 10 minutes (Dev2, 2026-11-22). Sabotage: hand runPool 1 lane in `alone` and the first test fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runSets } from "../bench/setsRun.mjs";

const conv = (id, msgs) => ({ id, title: id, set: "dev", kind: "one", members: ["Ann"], msgs });
const fixture = () =>
  conv("c1", [
    { id: "m1", who: "Ann", text: "is it on?", labels: { decide: { act: "respond", star: true }, reviewer: { sentBack: "0", star: true } } },
    { id: "m2", who: "Ann", text: "thanks", labels: { decide: { act: "quiet" } } },
    { id: "m3", who: "Ann", text: "where?", labels: { decide: { act: "respond", star: true } }, rec: { fd: { draft: "x" } } },
  ]);

test("in-process nodes run `parallel` at a time, set up once, with rows in the tests' order", async () => {
  let made = 0;
  let going = 0;
  let most = 0;
  const slow = (ms) => async () => {
    made += 1;
    return async (c, i) => {
      going += 1;
      most = Math.max(most, going);
      await new Promise((r) => setTimeout(r, c.msgs[i].id === "m1" ? ms * 3 : ms));
      going -= 1;
      return { right: true, ran: true, usd: 0 };
    };
  };
  const rows = await runSets([fixture()], { adapters: { decide: slow(10), reviewer: slow(10) }, tree: "/x", parallel: 4 });
  assert.deepEqual(rows.map((r) => [r.msg, r.node]), [["m1", "decide"], ["m1", "reviewer"], ["m3", "decide"]], "rows keep the tests' order though m1 finishes last");
  assert.equal(made, 2, "each node is set up once, not once a lane");
  assert.equal(most, 3, "all three tests went at once");
  most = 0;
  await runSets([fixture()], { adapters: { decide: slow(5), reviewer: slow(5) }, tree: "/x" });
  assert.equal(most, 1, "parallel 1 still runs them one after another");
});
