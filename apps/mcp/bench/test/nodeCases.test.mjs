/**
 * A STEP'S OWN CASES (`bench/nodeCases.mjs`; Dev2, 2026-11-15: "a lot of nodes don't even have test cases listed here.
 * And there's not a way to add them"). The Lab writes `bench/nodes/<step>.json`; `pnpm ai nodes` runs each case
 * through the step's code alone.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `loadNodeCases` without the 20-case cap -> "a step keeps at most 20 cases" fails;
 *  2. `isWanted` comparing yes/no as words -> "an exact want reads yes/no, choices and numbers" fails;
 *  3. `runCase` passing a judge want with no judge -> "a judge want with no gateway is a miss" fails.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inputOf, isWanted, loadNodeCases, nodesCommand, runCase } from "../nodeCases.mjs";
import { UNIT_LIMIT } from "../gateSample.mjs";

async function dirWith(files) {
  const dir = await mkdtemp(join(tmpdir(), "node-cases-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(body));
  return dir;
}

const CASE = { id: "asked-to-email", given: { words: "email Sam the notes", action: "send_email" }, want: { allow: { is: "Yes" } } };

test("a missing folder is no cases, and a file names the step it is for", async () => {
  assert.deepEqual(await loadNodeCases(join(tmpdir(), "no-such-node-cases")), []);
  const ok = await dirWith({ "egress.json": { node: "egress", cases: [CASE] } });
  assert.equal((await loadNodeCases(ok))[0].cases.length, 1);
  const wrong = await dirWith({ "egress.json": { node: "card", cases: [CASE] } });
  await assert.rejects(loadNodeCases(wrong), /named for/);
  const bad = await dirWith({ "egress.json": { node: "egress", cases: [{ id: "x y", given: {}, want: {} }] } });
  await assert.rejects(loadNodeCases(bad), /not an id/);
});

test("a step keeps at most UNIT_LIMIT cases", async () => {
  const cases = Array.from({ length: UNIT_LIMIT + 1 }, (_, i) => ({ ...CASE, id: `c${i}` }));
  await assert.rejects(loadNodeCases(await dirWith({ "egress.json": { node: "egress", cases } })), new RegExp(`at most ${UNIT_LIMIT} cases`));
  const full = await dirWith({ "egress.json": { node: "egress", cases: cases.slice(0, UNIT_LIMIT) } });
  assert.equal((await loadNodeCases(full))[0].cases.length, UNIT_LIMIT);
});

test("given boxes are typed by the step's input shape", () => {
  const input = inputOf(
    { given: { words: "hi", urgent: "yes", n: "3", tags: '["a","b"]', loose: "a, b", empty: "" } },
    [
      { name: "urgent", type: "yesno" },
      { name: "n", type: "number" },
      { name: "tags", type: "list" },
      { name: "loose", type: "list" },
    ],
  );
  assert.deepEqual(input, { words: "hi", urgent: true, n: 3, tags: ["a", "b"], loose: ["a", "b"] });
});

test("an exact want reads yes/no, choices and numbers", () => {
  assert.equal(isWanted(true, "Yes"), true);
  assert.equal(isWanted(false, "Yes"), false);
  assert.equal(isWanted(false, "no"), true);
  assert.equal(isWanted("Reply", "reply"), true);
  assert.equal(isWanted(3, "3"), true);
  assert.equal(isWanted(undefined, "none"), true);
  assert.equal(isWanted("Hush", "Reply"), false);
});

test("a case runs the step's code alone and checks each want", async () => {
  const fn = async (input) => ({ allow: input.action === "send_email", reason: "they asked" });
  assert.equal((await runCase(fn, CASE)).right, true);
  const miss = await runCase(fn, { ...CASE, want: { allow: { is: "No" } } });
  assert.equal(miss.right, false);
  assert.match(miss.why, /allow is true, wanted No/);
});

test("a step that needs its turn says so instead of passing", async () => {
  const fn = async (_input, io) => io.use.readNotes({});
  const row = await runCase(fn, CASE);
  assert.equal(row.right, false);
  assert.equal(row.ran, false);
  assert.match(row.why, /needs its helper "readNotes"/);
});

test("a judge want with no gateway is a miss, and with one asks the judge", async () => {
  const fn = async () => ({ reason: "they asked for it" });
  const c = { id: "j", given: {}, want: { reason: { judge: "mentions they asked" } } };
  const none = await runCase(fn, c);
  assert.equal(none.right, false);
  assert.match(none.why, /no judge/);
  const asked = [];
  const judge = async (field, value, words) => (asked.push([field, value, words]), { right: true, why: "" });
  assert.equal((await runCase(fn, c, { judge })).right, true);
  assert.deepEqual(asked, [["reason", "they asked for it", "mentions they asked"]]);
});

test("`pnpm ai nodes` runs every step's cases, one line a case, and names a step the gateway has not got", async () => {
  const dir = await dirWith({ "egress.json": { node: "egress", cases: [CASE] }, "ghost.json": { node: "ghost", cases: [{ ...CASE, id: "x" }] } });
  let out = "";
  const rows = await nodesCommand(
    { dir, fake: true },
    { write: (t) => (out += t), nodes: { egress: async () => ({ allow: true }) }, config: { nodes: [{ id: "egress", inSchema: [] }] } },
  );
  assert.deepEqual(
    rows.map((r) => [r.id, r.right]),
    [
      ["egress/asked-to-email", true],
      ["ghost/x", false],
    ],
  );
  assert.match(out, /^ok +egress\/asked-to-email/);
  assert.match(out, /MISS ghost\/x: no step "ghost"/);
  assert.match(out, /1\/2 right; 1 could not run alone/);
});
