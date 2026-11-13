/**
 * THE LAB'S REPLAYS (`bench/labReplay.mjs`; Dev2, 2026-11-13: change the Lab's test user to their own and replay old
 * texts, read only).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `buildReplayBench` dropping its inside-the-repository refusal -> "a person's notes and words never go into the
 *     repository" fails;
 *  2. `readReplays` dropping the NOTE_PATH filter on reads -> "a read that leaves the workspace is dropped" fails;
 *  3. `converse` (run.mjs) not posting `earlier` -> "a replay runs end to end ..." fails on the earlier text.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, buildReplayBench, inside, notesToFetch, readReplays, replayReport, replayTest, runReplays } from "../labReplay.mjs";
import { parseTest } from "../load.mjs";

const STAND_IN = fileURLToPath(new URL("../fingerprint/setups", import.meta.url));
const AT = Date.UTC(2026, 10, 12, 15, 4);

const config = (extra = {}) => ({
  texLab: 1,
  version: { name: "My version" },
  replayAs: { handle: "sam-lab", name: "Sam" },
  replays: [
    {
      id: "ev1762959840000000001",
      text: 'remind me "tomorrow"\nabout the shelves',
      at: AT,
      earlier: [
        { from: "person", text: "hey" },
        { from: "tex", text: "Hi Sam." },
      ],
      reads: ["projects/shelves.md", "../../etc/passwd.md", ".context/secret.md", "/abs.md"],
      then: { text: "Done, 9am tomorrow.", version: { code: "abc1234def56", setup: "a1b2c3d4e5f6", deploy: "<script>" } },
    },
  ],
  ...extra,
});

async function benchWithSetup() {
  const dir = await mkdtemp(join(tmpdir(), "lab-replay-bench-"));
  await cp(STAND_IN, join(dir, "setups"), { recursive: true });
  return dir;
}

test("a config's replays are checked: who they run as, each text, and only note paths inside the workspace", () => {
  const { as, replays } = readReplays(config());
  assert.deepEqual(as, { handle: "sam-lab", name: "Sam" });
  assert.equal(replays.length, 1);
  assert.deepEqual(replays[0].reads, ["projects/shelves.md"], "a read that leaves the workspace is dropped");
  assert.deepEqual(replays[0].then.version, { code: "abc1234def56", setup: "a1b2c3d4e5f6" }, "a version part of the wrong shape is dropped");
  assert.deepEqual(readReplays({ texLab: 1 }), { as: null, replays: [] });
  assert.throws(() => readReplays(config({ replayAs: { handle: "../x", name: "Sam" } })), /handle/);
  assert.throws(() => readReplays(config({ replayAs: { handle: "sam", name: "Sam | x" } })), /plain name/);
  assert.throws(() => readReplays(config({ replays: Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, text: "hi", at: AT })) })), /at most 20/);
  assert.throws(() => readReplays(config({ replays: [{ id: "a b", text: "hi", at: AT }] })), /no id/);
  assert.deepEqual(notesToFetch(readReplays(config()).replays), ["projects/shelves.md", "tex/about.md"]);
});

test("a replay's case keeps the text and the chat before it exactly, quotes and line breaks too", () => {
  const { as, replays } = readReplays(config());
  const parsed = parseTest(replayTest(replays[0], as));
  assert.equal(parsed.front.today, "2026-11-12");
  assert.equal(parsed.front.run_as, "Sam");
  const [q] = parsed.questions;
  assert.equal(q.texts, 'remind me "tomorrow"\nabout the shelves');
  assert.deepEqual(q.earlier, [{ from: "person", text: "hey" }, { from: "tex", text: "Hi Sam." }]);
  assert.equal(q.personStarts, null, "nobody plays the person: a replay is one text");
  assert.equal(q.ifAsked.length, 0);
});

test("a person's notes and words never go into the repository", async () => {
  const benchDir = await benchWithSetup();
  const outside = await mkdtemp(join(tmpdir(), "lab-replay-"));
  await assert.rejects(buildReplayBench({ config: config(), notesDir: join(REPO_ROOT, "apps"), scratch: outside, benchDir }), /inside the repository/);
  await assert.rejects(buildReplayBench({ config: config(), notesDir: outside, scratch: join(REPO_ROOT, ".replay-gate"), benchDir }), /inside the repository/);
  assert.equal(inside("/a/b", "/a/b/c"), true);
  assert.equal(inside("/a/b", "/a/bc"), false);
});

test("a replay runs end to end in a throwaway world, as the person, and reports Then beside Now", async () => {
  const benchDir = await benchWithSetup();
  const scratch = await mkdtemp(join(tmpdir(), "lab-replay-"));
  const notes = join(scratch, "notes");
  await mkdir(join(notes, "projects"), { recursive: true });
  await writeFile(join(notes, "projects", "shelves.md"), "# Shelves\n\nBuild the oak shelves on Saturday.\n");
  await mkdir(join(notes, ".hidden"), { recursive: true });
  await writeFile(join(notes, ".hidden", "x.md"), "never copied");
  const built = await buildReplayBench({ config: config(), notesDir: notes, scratch, benchDir });
  assert.deepEqual(built.notes, ["projects/shelves.md"], "only note paths are copied");
  assert.match(await readFile(join(built.root, "workspaces", "people.md"), "utf8"), /\| Sam \| sam-lab \(personal\) \| owner \|/);
  const { report, results } = await runReplays({ config: config(), notesDir: notes, scratch, benchDir, fake: true, write: () => {} });
  assert.equal(results[0].error, undefined, results[0].error);
  assert.ok(results[0].now.length > 0, "the fake model answered");
  assert.match(report, /^## Lab replay: My version/m);
  assert.match(report, /\*\*Then\*\* \(code abc1234, setup a1b2c3d4e5f6\): "Done, 9am tomorrow\."/);
  assert.match(report, /\*\*Now:\*\* "/);
  const ledger = await readFile(join(scratch, "replay-results", "lab-replay-1 ledgers", "production q1 run 1.ledger.md"), "utf8");
  assert.match(ledger, /"text": "Hi Sam\."/, "the chat before the text was in the chat's ledger when the turn read it");
});

test("the report says when a text ran before versions were kept", () => {
  const text = replayReport("v", [{ replay: { id: "e1", text: "hi", then: { text: "Hey.", version: null } }, now: "Hi!" }]);
  assert.match(text, /\*\*Then\*\* \(before versions were kept\): "Hey\."/);
});
