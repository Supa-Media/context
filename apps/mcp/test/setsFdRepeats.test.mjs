/**
 * Each repeat of a Front door test is its own bench test (`setsFd.mjs` prepareConvo), so a run's repeats go in parallel
 * lanes. Until 2026-11-26 the three repeats shared one test, whose cases run one after another, and a Dev set run took
 * 16 minutes at 24 lanes. Sabotage: drop the repeat from the test's key and the first test here fails.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { CASES_PER_TEST, runFd } from "../bench/setsFd.mjs";
import { parseTest } from "../bench/load.mjs";

const TREE = new URL("../../..", import.meta.url).pathname;
const chat = {
  id: "c1",
  set: "dev",
  kind: "one",
  members: ["Maya"],
  world: "maya",
  msgs: [
    { id: "m1", who: "Maya", text: "morning" },
    { id: "m2", who: "Tex", tex: true, text: "Morning!" },
    { id: "m3", who: "Maya", text: "and the plumber?" },
    { id: "m4", who: "Tex", tex: true, text: "Friday at 10." },
    { id: "m5", who: "Maya", text: "When's my dentist appointment?", labels: { fd: { must: ["say Tuesday, October 13 at 3 pm"], star: true } } },
  ],
};
const unit = (c, at) => ({ convo: c, at, label: c.msgs[at].labels.fd, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });

test("each repeat of a Front door test is a test of its own, so repeats go in parallel lanes, not one after another", async () => {
  const seen = [];
  const runTests = async (_tree, tests, { dir }) => {
    const raw = await readFile(join(dir, "tests", `${tests[0]}.md`), "utf8");
    seen.push([tests[0], parseTest(raw).questions.length]);
    return { rows: [{ id: `${tests[0]}/q1`, right: true }], usd: 0, bars: {}, missing: [] };
  };
  const again = (rep) => ({ ...unit(chat, 4), row: { ...unit(chat, 4).row, rep } });
  const rows = await runFd([again(0), again(1), again(2)], { tree: TREE, fake: true, runTests, parallel: 3 });
  assert.deepEqual(seen.map(([, n]) => n), [1, 1, 1], "one case a test, never three in one");
  assert.equal(new Set(seen.map(([name]) => name)).size, 3);
  assert.deepEqual(rows.map((r) => [r.rep, r.ran, r.right]), [[0, true, true], [1, true, true], [2, true, true]]);
});

test("a person-day with many cases is cut into tests of at most CASES_PER_TEST, each its own lane", async () => {
  const day = { ...chat, id: "c2", msgs: [] };
  for (let k = 0; k < 5; k += 1) {
    day.msgs.push({ id: `a${k}`, who: "Maya", text: `ask ${k}`, labels: { fd: { must: ["answer it"], star: true } } });
    day.msgs.push({ id: `r${k}`, who: "Tex", tex: true, text: "ok" });
  }
  const sizes = [];
  const runTests = async (_tree, tests, { dir }) => {
    const n = parseTest(await readFile(join(dir, "tests", `${tests[0]}.md`), "utf8")).questions.length;
    sizes.push(n);
    return { rows: Array.from({ length: n }, (_, q) => ({ id: `${tests[0]}/q${q + 1}`, right: true })), usd: 0, bars: {}, missing: [] };
  };
  const rows = await runFd([0, 2, 4, 6, 8].map((at) => unit(day, at)), { tree: TREE, fake: true, runTests, parallel: 3 });
  assert.equal(CASES_PER_TEST, 2);
  assert.deepEqual(sizes.sort(), [1, 2, 2], "five cases of one day: three tests, none over two");
  assert.deepEqual(rows.map((r) => [r.msg, r.ran, r.right]), [["a0", true, true], ["a1", true, true], ["a2", true, true], ["a3", true, true], ["a4", true, true]]);
});
