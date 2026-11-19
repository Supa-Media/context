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

import { normalizeRequest, knownFacts, openWorldStore, readFixtures, runMisses, saveFixtures, worldKey, worldMode } from "../bench/simFixtures.mjs";
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
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(file, null, 1)}\n`, "the file's exact shape");

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
