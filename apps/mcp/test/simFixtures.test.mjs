/**
 * The simulated world's answers kept per conversation (`bench/simFixtures.mjs`; Dev set, 2026-11-19: the same flight
 * cost $689, $742 and $489 across runs). A fixture answers without the model, a miss is claimed for the run's other
 * processes, and a record or refresh writes the file a person reviews.
 *
 * Sabotage: keying on the system prompt, dropping the first-claim rule, letting refresh read fixtures, or writing a
 * fake answer fails these.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixtureText, nearestFixture, requestLikeness, normalizeRequest, knownFacts, openWorldStore, readFixtures, runMisses, saveFixtures, saveRunFixtures, worldKey, worldMode } from "../bench/simFixtures.mjs";
import { createSimWorld, simMemo } from "../bench/simWorld.mjs";

/** A model that answers each call kind with `answers[kind]` (or with `answerFor(kind, request)`), counting what it was asked. */
function scriptedSend(answers, answerFor = null) {
  const asked = [];
  const send = async (body) => {
    const request = JSON.parse(body);
    asked.push(request);
    const kind = /^Call: (.+)$/m.exec(request.messages[0].content)[1];
    const requested = JSON.parse(/^Request: (.+)$/m.exec(request.messages[0].content)[1]);
    const answer = answerFor ? answerFor(kind, requested) : answers[kind] ?? {};
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  };
  return { send, asked };
}

const FLIGHT = { results: [{ title: "Harbor Air", url: "https://harborair.example/fare", description: "Nonstop $689 round trip" }] };

test("case, spacing and key order do not change a call's key; a different argument does", () => {
  const original = { query: "  Chicago   Low ", days: 2, filter: { lang: "en", region: undefined, safe: null } };
  assert.equal(worldKey("web search", { query: "chicago low", days: 2, filter: { lang: "EN" } }), worldKey("web search", original));
  assert.equal(worldKey("web search", { query: "x", a: 1, b: 2 }), worldKey("web search", { b: 2, a: 1, query: "X" }));
  assert.equal(worldKey("google calendar days", { date: "2026-07-03" }), worldKey("google calendar days", { date: "2026-07-03", days: undefined }));
  assert.notEqual(worldKey("web search", { query: "chicago low" }), worldKey("web search", { query: "chicago high" }));
  assert.notEqual(worldKey("web search", { query: "x" }), worldKey("gmail search", { query: "x" }), "the kind is part of the key");
  assert.notEqual(worldKey("x", { n: 1 }), worldKey("x", { n: "1" }), "numbers are not strings");
  assert.equal(JSON.stringify(normalizeRequest(original)), '{"days":2,"filter":{"lang":"en"},"query":"chicago low"}');
  assert.equal(original.query, "  Chicago   Low ", "the input is not changed");
});

test("a fixture answers the call without the model: replayed, counted, and marked in the events", async () => {
  const { send, asked } = scriptedSend({ "web search": { results: [{ title: "Wrong", url: "https://wrong.example", description: "" }] } });
  const fixtures = new Map([[worldKey("web search", { query: "chicago low" }), { key: worldKey("web search", { query: "chicago low" }), kind: "web search", request: { query: "chicago low" }, answer: FLIGHT }]]);
  const store = openWorldStore({ fixtures, mode: "replay" });
  const memo = simMemo();
  const world = createSimWorld({ send, setting: "Chicago", memo, store });
  const results = await world.search("  Chicago   LOW ");
  assert.equal(results[0].url, "https://harborair.example/fare");
  assert.equal(asked.length, 0, "the model was not asked");
  assert.equal(memo.hits, 1);
  assert.deepEqual(memo.misses, []);
  assert.match(world.events()[0], /^world web search \(replayed\) /);
});

test("a call the fixtures do not have is asked once, is a miss, and is not asked again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simfix-run-"));
  try {
    const { send, asked } = scriptedSend({ "web search": FLIGHT });
    const store = openWorldStore({ fixtures: new Map(), runDir: join(dir, "world"), test: "flights" });
    const world = createSimWorld({ send, setting: "Chicago", memo: simMemo(), store });
    await world.search("chicago low");
    assert.equal(asked.length, 1, "asked once");
    assert.deepEqual(store.misses(), [{ kind: "web search", request: { query: "chicago low" }, test: "flights" }]);
    assert.deepEqual(runMisses(join(dir, "world")).map((e) => [e.kind, e.request, e.test]), [["web search", { query: "chicago low" }, "flights"]]);

    // The same call again, in other case and spacing, in the same world and in a new one: no new ask.
    await world.search("  Chicago LOW");
    await createSimWorld({ send, setting: "Chicago", memo: simMemo(), store }).search("CHICAGO   low");
    assert.equal(asked.length, 1, "the same call is not asked again");
    assert.equal(store.misses().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two test processes of one run agree: a claimed answer is replayed to the other, and the first claim wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simfix-procs-"));
  try {
    const runDir = join(dir, "world");
    const first = scriptedSend({ "web search": FLIGHT });
    const storeA = openWorldStore({ runDir, test: "one" });
    await createSimWorld({ send: first.send, setting: "Chicago", chat: [{ who: "John", text: "book it" }], memo: simMemo(), store: storeA }).search("nonstop chicago");
    assert.equal(first.asked.length, 1);

    // Another process: a different chat, a model that would answer differently. It gets the first world's answer.
    const second = scriptedSend({ "web search": { results: [{ title: "Other", url: "https://other.example", description: "$742" }] } });
    const storeB = openWorldStore({ runDir, test: "two" });
    const got = await createSimWorld({ send: second.send, setting: "Chicago", chat: [{ who: "Priya", text: "hi" }], memo: simMemo(), store: storeB }).search("Nonstop  Chicago");
    assert.equal(got[0].url, "https://harborair.example/fare", "the first world's answer");
    assert.equal(second.asked.length, 0, "the second process did not ask the model");

    // Two processes that missed at once: both claims return the first answer.
    const key = worldKey("gmail search", { query: "dinner" });
    const claimA = openWorldStore({ runDir }).claim(key, "gmail search", { query: "dinner" }, { results: ["first"] });
    const claimB = openWorldStore({ runDir }).claim(key, "gmail search", { query: "dinner" }, { results: ["second"] });
    assert.deepEqual(claimA, { results: ["first"] });
    assert.deepEqual(claimB, { results: ["first"] }, "the first claim wins");
    assert.equal(runMisses(runDir).length, 2, "one file per key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the world's next miss is told what the earlier answers showed, under the already-shown paragraph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simfix-known-"));
  try {
    const { send, asked } = scriptedSend({}, (kind, request) => (request.query === "flights" ? FLIGHT : { results: [] }));
    const store = openWorldStore({ runDir: join(dir, "world") });
    const world = createSimWorld({ send, setting: "Chicago", memo: simMemo(), store });
    await world.search("flights");
    assert.doesNotMatch(asked[0].system, /already shown/, "nothing shown before the first miss");
    await world.search("hotels in chicago");
    assert.match(asked[1].system, /What the world has already shown in this conversation/);
    assert.match(asked[1].system, /\$689/, "the first answer's details are shown again");
    assert.match(asked[1].system, /Setting: Chicago/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh asks the model even where a fixture exists; record and refresh write sorted, merged files; fakes are never written; replay writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simfix-save-"));
  try {
    const path = join(dir, "sets", "sim", "conv-1.json");
    const k1 = worldKey("web search", { query: "chicago low" });
    const k2 = worldKey("web search", { query: "dentist" });
    const k3 = worldKey("web search", { query: "fake one" });
    mkdirSync(join(dir, "sets", "sim"), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ conversation: "conv-1", answers: [{ key: k1, kind: "web search", request: { query: "chicago low" }, answer: "OLD" }] }, null, 1)}\n`);

    // Refresh: the fixture is not read, so the model is asked, and the file becomes the run's answers.
    const { send, asked } = scriptedSend({ "web search": { results: [] } }, () => ({ results: [{ title: "NEW", url: "https://new.example", description: "" }] }));
    const refresh = openWorldStore({ fixtures: readFixtures(path), runDir: join(dir, "world"), mode: "refresh" });
    assert.equal(refresh.get(k1), null, "refresh does not read fixtures");
    const fresh = await createSimWorld({ send, setting: "x", memo: simMemo(), store: refresh }).search("chicago low");
    assert.equal(fresh[0].title, "NEW");
    assert.equal(asked.length, 1, "the model was asked despite the fixture");
    assert.equal(saveFixtures(path, "conv-1", [{ key: k1, kind: "web search", request: { query: "chicago low" }, answer: "NEW" }], "refresh"), 1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).answers.map((a) => a.answer), ["NEW"]);

    // Record: the recorded answer stays, the new one is added, the fake one is not written; sorted by key.
    writeFileSync(path, `${JSON.stringify({ conversation: "conv-1", answers: [{ key: k1, kind: "web search", request: { query: "chicago low" }, answer: "OLD" }] }, null, 1)}\n`);
    const written = saveFixtures(path, "conv-1", [
      { key: k2, kind: "web search", request: { query: "dentist" }, answer: "D" },
      { key: k1, kind: "web search", request: { query: "chicago low" }, answer: "NEW" },
      { key: k3, kind: "web search", request: { query: "fake one" }, answer: "FAKE", fake: true },
    ], "record");
    assert.equal(written, 1, "only the new, real answer");
    const file = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(file.conversation, "conv-1");
    assert.deepEqual(file.answers.map((a) => a.key), [k2, k1].sort(), "sorted by key");
    assert.equal(file.answers.find((a) => a.key === k1).answer, "OLD", "the recorded answer is kept");
    assert.equal(file.answers.some((a) => a.key === k3), false, "a fake answer is never written");
    const text = readFileSync(path, "utf8");
    assert.equal(text, fixtureText("conv-1", file.answers), "the file's exact shape");
    assert.equal(text.split("\n").length, file.answers.length + 3, "one answer a line");

    // Refresh with only a fake: nothing real is written.
    assert.equal(saveFixtures(path, "conv-1", [{ key: k3, kind: "web search", request: { query: "fake one" }, answer: "FAKE", fake: true }], "refresh"), 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).answers.length, 0);

    // Replay writes nothing, and a missing file is not created by it.
    const untouched = join(dir, "never", "conv-2.json");
    assert.equal(saveFixtures(untouched, "conv-2", [{ key: k2, kind: "web search", request: { query: "dentist" }, answer: "D" }], "replay"), 0);
    assert.equal(existsSync(untouched), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fake run answers with its fallback, claims it as fake, and shows it to the next miss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "simfix-fake-"));
  try {
    const runDir = join(dir, "world");
    const world = createSimWorld({ send: null, setting: "x", memo: simMemo(), store: openWorldStore({ runDir }) });
    assert.deepEqual(await world.search("anything"), []);
    const [entry] = runMisses(runDir);
    assert.equal(entry.fake, true);
    assert.equal(entry.kind, "web search");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knownFacts keeps the last answers that fit, oldest first to go, one line each", () => {
  assert.equal(knownFacts([]), "");
  const entries = Array.from({ length: 5 }, (_, i) => ({ kind: "web search", request: { query: `q${i}` }, answer: { n: i } }));
  const line = (i) => `- web search ${JSON.stringify({ query: `q${i}` })} -> ${JSON.stringify({ n: i })}`;
  assert.equal(knownFacts(entries), entries.map((_, i) => line(i)).join("\n"));
  const two = line(3).length + 1 + line(4).length;
  assert.equal(knownFacts(entries, two), `${line(3)}\n${line(4)}`, "the newest two, in order");
  assert.equal(knownFacts(entries, 10), "", "nothing fits");
  const long = [{ kind: "web search", request: {}, answer: "x".repeat(2000) }];
  assert.equal(knownFacts(long).length, "- web search {} -> ".length + 600, "an answer is cut to 600 characters");
});

test("a mail search drops the rows dated after today, and their reads are not found", async () => {
  const { send } = scriptedSend({
    "gmail search": {
      results: [
        { id: "m1", date: "2026-06-30T09:00:00Z", from: "Priya", to: "john@example.invalid", subject: "Friday?", snippet: "7?" },
        { id: "m2", date: "2026-07-02T09:00:00Z", from: "Priya", to: "john@example.invalid", subject: "Later", snippet: "x" },
      ],
    },
  });
  const world = createSimWorld({ send, setting: "Tex has Gmail", today: "2026-07-01", memo: simMemo() });
  assert.deepEqual((await world.mailSearch("dinner")).map((row) => row.id), ["m1"]);
  assert.equal(await world.mailRead({ id: "m2" }), null, "a mail not yet arrived cannot be read");
});

test("a store's world mode is one of the three, and anything else is replay", () => {
  assert.equal(worldMode("record"), "record");
  assert.equal(worldMode(" refresh "), "refresh");
  assert.equal(worldMode("bogus"), "replay");
  assert.equal(worldMode(undefined), "replay");
});

test("benchSafe: a real-looking address moves onto an example domain, in the request and the answer, and the key follows", async () => {
  const { benchSafe } = await import("../bench/simFixtures.mjs");
  assert.equal(benchSafe("from john.keller@gmail.com and bookings@flytap.com"), "from john.keller@gmail.example and bookings@flytap.example");
  assert.equal(benchSafe("john@gmail.example, a@b.test, c@example.com, d@mail.example.org"), "john@gmail.example, a@b.test, c@example.com, d@mail.example.org");
  assert.deepEqual(benchSafe({ q: ["x@y.co.uk"], n: 3 }), { q: ["x@y.co.example"], n: 3 });
  const dir = mkdtempSync(join(tmpdir(), "bench-safe-"));
  const path = join(dir, "c.json");
  saveFixtures(path, "c", [{ kind: "gmail search", request: { query: "from:paulo@gmail.com" }, answer: { messages: [{ from: "paulo@gmail.com" }] } }], "record");
  const saved = JSON.parse(readFileSync(path, "utf8")).answers[0];
  assert.deepEqual(saved.request, { query: "from:paulo@gmail.example" });
  assert.equal(saved.key, worldKey("gmail search", { query: "from:paulo@gmail.example" }));
  assert.doesNotMatch(JSON.stringify(saved), /gmail\.com/);
});

test("a replay heals: a reworded call gets the nearest answer, a new one is asked once and saved, and the next run asks nothing", async () => {
  // Training replays of one commit, 2026-11-19: 26 and 47 calls unrecorded, because Tex words a search differently each run.
  const hotels = { results: [{ title: "Casa Alfama", url: "https://casaalfama.example", description: "Rooms from $140" }] };
  const { send, asked } = scriptedSend({}, (kind, request) => (/hotel/i.test(request.query) ? hotels : { results: [] }));
  const request = { query: "nonstop flights chicago lisbon june" };
  const tree = mkdtempSync(join(tmpdir(), "sim-heal-"));
  try {
    const path = join(tree, "apps/mcp/bench/sets/sim/wedding.json");
    mkdirSync(join(tree, "apps/mcp/bench/sets/sim"), { recursive: true });
    mkdirSync(join(tree, "apps/mcp/bench/sets/dev"), { recursive: true });
    writeFileSync(join(tree, "apps/mcp/bench/sets/dev/wedding.json"), "{}");
    saveFixtures(path, "wedding", [{ kind: "web search", request, answer: FLIGHT }], "record");
    const runOnce = async (runDir) => {
      const store = openWorldStore({ fixtures: readFixtures(path), runDir, mode: "replay", test: "trip" });
      const world = createSimWorld({ send, setting: "Lisbon", memo: simMemo(), store });
      const flights = await world.search("Chicago to Lisbon nonstop flights in June");
      const first = await world.search("hotels in alfama lisbon");
      const reworded = await world.search("Alfama hotels, Lisbon");
      return { world, store, flights, first, reworded };
    };
    const one = await runOnce(join(tree, "run1"));
    assert.equal(one.flights[0].url, "https://harborair.example/fare", "the reworded search is answered from the recording");
    assert.equal(one.first[0].url, "https://casaalfama.example");
    assert.deepEqual(one.reworded, one.first, "a rewording of this run's new answer gets the same answer");
    assert.equal(asked.length, 1, "only the call nothing was near asked the model");
    assert.equal(one.store.misses().length, 1);

    // The run saves what it asked, for a Training or Dev conversation only.
    saveRunFixtures([{ id: "elsewhere", set: "test", runDir: join(tree, "run1") }, { id: "handed-in", set: "dev", runDir: join(tree, "run1") }], tree, "replay", () => {});
    for (const id of ["elsewhere", "handed-in"]) assert.equal(existsSync(join(tree, `apps/mcp/bench/sets/sim/${id}.json`)), false, "never a conversation outside the repo's sets");
    saveRunFixtures([{ id: "wedding", set: "dev", runDir: join(tree, "run1") }], tree, "replay", () => {});
    assert.equal(readFixtures(path).size, 2);

    const two = await runOnce(join(tree, "run2"));
    assert.equal(asked.length, 1, "the healed world asked the model nothing");
    assert.deepEqual(two.store.misses(), []);
    assert.deepEqual(two.reworded, one.reworded);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("record and refresh ask the model for every wording: nothing is near outside a replay", async () => {
  const { send, asked } = scriptedSend({ "web search": FLIGHT });
  const request = { query: "chicago lisbon flights" };
  const fixtures = new Map([[worldKey("web search", request), { key: worldKey("web search", request), kind: "web search", request, answer: FLIGHT }]]);
  for (const mode of ["record", "refresh"]) {
    const store = openWorldStore({ fixtures, mode });
    assert.equal(store.near("web search", { query: "flights chicago lisbon" }), null);
    await createSimWorld({ send, setting: "x", memo: simMemo(), store }).search("flights chicago lisbon");
  }
  assert.equal(asked.length, 2);
});

test("nearestFixture: same kind only, at least half alike, ties to the first key, never the request's own stop words", () => {
  const entry = (kind, query, answer) => [worldKey(kind, { query }), { key: worldKey(kind, { query }), kind, request: { query }, answer }];
  const fixtures = new Map([entry("web search", "alfama hotels", 1), entry("web search", "hotels alfama lisbon", 2), entry("gmail search", "alfama hotels booking", 3)]);
  assert.equal(nearestFixture(fixtures, "web search", { query: "Hotels in Alfama" }).answer, 1);
  assert.equal(nearestFixture(fixtures, "gmail search", { query: "alfama hotels" }).answer, 3, "the kind must match");
  assert.equal(nearestFixture(fixtures, "web search", { query: "restaurants in alfama" }), null, "a third alike is not near");
  assert.equal(requestLikeness({ query: "the of and" }, { query: "the of and" }), 0, "stop words alone match nothing");
  assert.equal(nearestFixture(null, "web search", { query: "x" }), null);
});

test("worldHeal: a run's files merge into the fixtures, a committed answer stands, and only the repo's Training or Dev conversations are written", async () => {
  const { healWorld } = await import("../bench/worldHeal.mjs");
  const tree = mkdtempSync(join(tmpdir(), "sim-heal-tree-"));
  const from = mkdtempSync(join(tmpdir(), "sim-heal-from-"));
  try {
    for (const [set, id] of [["training", "loose-ends"], ["dev", "wedding"]]) {
      mkdirSync(join(tree, "apps/mcp/bench/sets", set), { recursive: true });
      writeFileSync(join(tree, "apps/mcp/bench/sets", set, `${id}.json`), "{}");
    }
    mkdirSync(join(tree, "apps/mcp/bench/sets/sim"), { recursive: true });
    const committed = join(tree, "apps/mcp/bench/sets/sim/loose-ends.json");
    saveFixtures(committed, "loose-ends", [{ kind: "web search", request: { query: "a" }, answer: { results: [1] } }], "record");
    const file = (id, answers) => writeFileSync(join(from, `${id}.json`), fixtureText(id, answers.map((a) => ({ key: worldKey(a.kind, a.request), ...a }))));
    file("loose-ends", [{ kind: "web search", request: { query: "a" }, answer: { results: ["older run"] } }, { kind: "web search", request: { query: "b" }, answer: { results: [2] } }]);
    file("wedding", [{ kind: "gmail search", request: { query: "rsvp" }, answer: { results: [] } }]);
    file("sealed-one", [{ kind: "web search", request: { query: "x" }, answer: { results: [] } }]);
    assert.deepEqual(healWorld(from, tree), { "loose-ends": 1, wedding: 1 });
    const kept = readFixtures(committed);
    assert.deepEqual(kept.get(worldKey("web search", { query: "a" })).answer, { results: [1] }, "the committed answer stands");
    assert.equal(kept.size, 2);
    assert.equal(existsSync(join(tree, "apps/mcp/bench/sets/sim/sealed-one.json")), false, "never a conversation outside the repo's sets");
    assert.deepEqual(healWorld(from, tree), {}, "a second merge adds nothing");
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(from, { recursive: true, force: true });
  }
});
