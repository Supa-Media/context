/**
 * EVERY GOLD FACT HAS A SOURCE IN THE BENCH (`bench/setsTrace.mjs`; Training of 2026-11-18, running-the-shop m83).
 * Sabotage: make `foundIn` answer true, or drop the world from `placesOf`, and these fail.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { factsOf, findingLine, placesOf, traceConvo, traceTraining } from "../bench/setsTrace.mjs";

/** A tree with the bench's people file, John's workspace and an empty sites folder; `files` written over it. */
async function fixtureTree(files = {}) {
  const tree = await mkdtemp(join(tmpdir(), "tex-trace-test-"));
  const all = {
    "apps/mcp/bench/ai/workspaces/people.md": "# People\n\n| Person | Workspace | Role |\n|---|---|---|\n| John | john (personal) | owner |\n",
    "apps/mcp/bench/ai/workspaces/john/index.md": "# John\n\nWoodshop and a choir.\n",
    "apps/mcp/bench/ai/sites/.keep": "",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await writeFile(join(tree, path), text);
  }
  return tree;
}

/** A Training chat whose labelled row's gold says `gold`. */
const chat = (gold, extra = []) => ({
  id: "fx",
  set: "training",
  kind: "one",
  members: ["John"],
  setting: "John runs a shop. Tex has his Gmail and notes.",
  msgs: [
    ...extra,
    { id: "m1", who: "John", text: "how many open things do we have", labels: { fd: { must: ["list them"] } } },
    { id: "m2", who: "Tex", tex: true, text: gold },
    { id: "m3", who: "John", text: "ok" },
  ],
});

test("a gold that cites a $19 nothing in the bench holds fails, naming the row, the fact and where it looked", async () => {
  const tree = await fixtureTree();
  try {
    const c = chat("Still hanging: a $19 domain charge. Want me to drop it?");
    const findings = traceConvo(c, await placesOf(c, { tree }), {});
    assert.deepEqual(findings.map((f) => [f.row, f.gold, f.kind, f.raw]), [["m1", "m2", "money", "$19"]]);
    const line = findingLine(findings[0]);
    assert.match(line, /fx m1 \(gold m2\): money "\$19"/);
    assert.match(line, /worlds\/fx\//);
    assert.match(line, /bench workspaces john/);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

test("the same chat passes once its world holds the fact, as a record of Tex's open jobs", async () => {
  const tree = await fixtureTree({
    "apps/mcp/bench/sets/worlds/fx/workspaces/john/tex/jobs.md": "- [Domain charge](@john/projects/admin/domain-charge.md)\n",
    "apps/mcp/bench/sets/worlds/fx/workspaces/john/projects/admin/domain-charge.md": "---\nstatus: waiting\n---\n\n# Domain charge\n\nA $19 charge for a domain. Asked John on Oct 28, no answer yet.\n",
  });
  try {
    const c = chat("Still hanging: a $19 domain charge. Want me to drop it?");
    assert.deepEqual(traceConvo(c, await placesOf(c, { tree }), {}), []);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

test("a fact said earlier in the chat, or in its setting, has a source; one said only after the row does not", async () => {
  const tree = await fixtureTree();
  try {
    const before = chat("The Mailbox plan is still open.", [{ id: "m0", who: "Tex", tex: true, text: "Your Mailbox plan renews soon." }]);
    assert.deepEqual(traceConvo(before, await placesOf(before, { tree }), {}), []);
    const after = chat("The Mailbox plan is still open.");
    after.msgs.push({ id: "m4", who: "Tex", tex: true, text: "Your Mailbox plan renews soon." });
    assert.deepEqual(traceConvo(after, await placesOf(after, { tree }), {}).map((f) => f.raw), ["Mailbox"]);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

test("a sum Tex works out passes only from the COMPUTED list, with its reason, and an entry that lets nothing through is stale", async () => {
  const tree = await fixtureTree({ "apps/mcp/bench/sets/worlds/fx/workspaces/john/gear.md": "# Gear\n\n- Q2U mic: about $70 each.\n" });
  try {
    const c = chat("Three Q2Us is $210.");
    const bare = await traceTraining([c], { tree, computed: {}, gaps: {} });
    assert.deepEqual(bare.findings.map((f) => f.raw), ["$210"]);
    const listed = await traceTraining([c], { tree, computed: { fx: { m2: [{ fact: "$210", why: "three at the gear note's $70" }] } }, gaps: {} });
    assert.deepEqual(listed.findings, []);
    assert.deepEqual(listed.stale, []);
    const stale = await traceTraining([c], { tree, computed: { fx: { m2: [{ fact: "$210", why: "three at $70" }, { fact: "$70", why: "not needed: the note has it" }] } }, gaps: {} });
    assert.equal(stale.stale.length, 1);
    assert.match(stale.stale[0], /COMPUTED fx m2 "\$70" lets nothing through/);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

test("a gap stands reported, not silently passed, and only Training chats are traced", async () => {
  const tree = await fixtureTree();
  try {
    const c = chat("From the repo, Sept 21 to Oct 2.");
    const r = await traceTraining([c, { ...chat("A $19 charge."), id: "dv", set: "dev" }], { tree, computed: {}, gaps: { fx: { m2: [{ fact: "Sept 21", why: "no repository in the bench" }] } } });
    assert.deepEqual(r.findings.map((f) => f.raw), ["Oct 2"]);
    assert.deepEqual(r.gaps, ['fx m2 "Sept 21": no repository in the bench']);
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});

test("what counts as a hard fact", () => {
  const facts = (text) => factsOf(text).map((f) => `${f.kind}:${f.raw}`);
  assert.deepEqual(facts("Three Q2Us is $210, three SM7Bs is $1,200."), ["money:$210", "money:$1,200", "name:Q2U", "name:SM7B"]);
  assert.deepEqual(facts("9:30 call, so 8:45 if you want coffee."), ["time:9:30", "time:8:45"]);
  assert.deepEqual(facts("It's in the Sept 16 call, about 14 days."), ["unit:14 days", "date:Sept 16"]);
  assert.deepEqual(facts('Choir at 7pm, and the "What earns week two" section.'), ["time:7pm", 'title:"What earns week two"']);
  assert.deepEqual(facts("Sure. I can do that, OK? Week two, all Wed-Thu."), [], "a sentence's first word, a short shout and day names are not names");
});
