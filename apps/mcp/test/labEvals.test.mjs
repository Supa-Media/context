// The Lab's evals (`src/labEvals/`): LongMemEval through real Tex. What is proven here:
//
//  - the scanner finds each question's bytes in a JSON array fed in odd chunks, braces inside strings and escaped
//    quotes included, and a range of those bytes parses back to exactly that question;
//  - the slice is stratified and the same on every run;
//  - a question's history becomes a test chat's start dated as LongMemEval dates it, moved by whole days so the
//    question is asked today, the person's turns as theirs and the assistant's as Tex's;
//  - the judge prompt is LongMemEval's for each type, and only "yes" counts;
//  - a run moves along through `advance`: each question opens its test chat with that seed, gets day summaries, is
//    texted, is graded once Tex's reply is in, and the run ends done with its scores; two drivers never start one
//    question twice; a stopped run starts nothing more;
//  - an eval test chat reads nothing of the developer's own account (`policy.js` `BLANK_READS`), and its seed can
//    only come from the evals: the test-chat route refuses `source: "eval"`.
//
// Sabotage: making `createScanner` ignore `inString` fails the first test; dropping the `claim` room check fails
// "two drivers"; removing `BLANK_READS` from `toolAnswer` fails the blank test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { abilityOf, createScanner, historyOf, indexEntry, judgePrompt, sliceOf, verdictOf, zonedMs, parseDate } from "../src/labEvals/longMemEval.js";
import { buildIndex, fetchItem } from "../src/labEvals/dataset.js";
import { evalsTables, serveEvals, LabEvalsObject } from "../src/labEvals/store.js";
import { advance, scoresOf } from "../src/labEvals/run.js";
import { blankRead, BLANK_READS, toolAnswer } from "../src/labSandbox/policy.js";
import { durableSql } from "./texStoreFixture.mjs";

const DAY = 86_400_000;
/** A made-up AI gateway, so the day summaries and the judge have a road; every call goes to the test's stand-in. */
const GATEWAY = { AI_GATEWAY_ACCOUNT_ID: "0".repeat(32), AI_GATEWAY_ID: "lab-test", AI_GATEWAY_TOKEN: "test-token-not-real-0000000" };

function question(id, type, extra = {}) {
  return {
    question_id: id,
    question_type: type,
    question: `What about ${id}? {braces} "quoted"`,
    answer: `answer ${id}`,
    question_date: "2023/05/30 (Tue) 10:00",
    haystack_session_ids: ["s1", "s2"],
    haystack_dates: ["2023/05/01 (Mon) 09:15", "2023/05/28 (Sun) 18:00"],
    haystack_sessions: [
      [
        { role: "user", content: "I adopted a dog named {Rex} \\ yesterday." },
        { role: "assistant", content: "Congrats on \"Rex\"!" },
      ],
      [
        { role: "user", content: "Rex now weighs 30 pounds." },
        { role: "assistant", content: "Good boy." },
      ],
    ],
    ...extra,
  };
}

const DATASET = [
  question("q1", "single-session-user"),
  question("q2_abs", "single-session-user"),
  question("q3", "multi-session"),
  question("q4", "temporal-reasoning", { answer: "May 28" }),
  question("q5", "knowledge-update"),
  question("q6", "single-session-preference"),
];
const FILE = new TextEncoder().encode(JSON.stringify(DATASET, null, 1));

function chunks(bytes, size) {
  const out = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

test("the scanner finds every question's bytes, in any chunking, and a range parses back to that question", () => {
  for (const size of [1, 7, 64, 100_000]) {
    const scanner = createScanner();
    for (const chunk of chunks(FILE, size)) scanner.push(chunk);
    const entries = scanner.found.map((found, i) => indexEntry(found, i));
    assert.deepEqual(entries.map((e) => e.id), DATASET.map((q) => q.question_id), `chunks of ${size}`);
    for (const entry of entries) {
      const item = JSON.parse(new TextDecoder().decode(FILE.subarray(entry.start, entry.end + 1)));
      assert.equal(item.question_id, entry.id);
    }
    assert.equal(entries[1].ability, "abstention");
    assert.equal(entries[3].answer, "May 28");
    assert.equal(entries[0].type, "single-session-user");
  }
});

const fileFetch = (body = FILE, { range = true } = {}) => async (url, init = {}) => {
  if (String(url).includes("/api/datasets/")) return Response.json({ sha: "a".repeat(40), siblings: [{ rfilename: "longmemeval_oracle.json" }, { rfilename: "longmemeval_s_cleaned.json" }] });
  const asked = /bytes=(\d+)-(\d+)/.exec(init.headers?.range ?? "");
  if (asked && range) return new Response(body.subarray(Number(asked[1]), Number(asked[2]) + 1), { status: 206 });
  return new Response(new ReadableStream({ start(c) { for (const chunk of chunks(body, 5)) c.enqueue(chunk); c.close(); } }));
};

test("the index is built from a stream, and one question is fetched by its range, or from a server that ignores ranges", async () => {
  const entries = await buildIndex("https://example.invalid/file.json", fileFetch());
  assert.equal(entries.length, 6);
  const one = await fetchItem("https://example.invalid/file.json", entries[2], fileFetch());
  assert.equal(one.question_id, "q3");
  const whole = await fetchItem("https://example.invalid/file.json", entries[4], fileFetch(FILE, { range: false }));
  assert.equal(whole.question_id, "q5");
  await assert.rejects(fetchItem("https://example.invalid/file.json", { ...entries[4], id: "q9" }, fileFetch()), /changed/);
});

test("a slice is stratified by type and the same on every run, and a bigger slice holds a smaller one", () => {
  const index = [];
  for (let i = 0; i < 60; i += 1) index.push({ id: `m${i}`, type: "multi-session", ability: "multi" });
  for (let i = 0; i < 30; i += 1) index.push({ id: `t${i}`, type: "temporal-reasoning", ability: "temporal" });
  for (let i = 0; i < 10; i += 1) index.push({ id: `a${i}_abs`, type: "multi-session", ability: "abstention" });
  const ten = sliceOf(index, 10);
  assert.equal(ten.length, 10);
  assert.equal(ten.filter((e) => e.ability === "multi").length, 6);
  assert.equal(ten.filter((e) => e.ability === "temporal").length, 3);
  assert.equal(ten.filter((e) => e.ability === "abstention").length, 1);
  assert.deepEqual(sliceOf(index, 10).map((e) => e.id), ten.map((e) => e.id));
  const twenty = new Set(sliceOf(index, 20).map((e) => e.id));
  for (const e of ten) assert.ok(twenty.has(e.id), `${e.id} in the bigger slice`);
  assert.equal(sliceOf(index, 1000).length, 100);
});

test("a question's history is a test chat's start: dated as LongMemEval dates it, moved so the question is asked today", () => {
  const now = Date.UTC(2026, 10, 20, 15, 0);
  const built = historyOf(question("q4", "temporal-reasoning"), { now, timeZone: "America/New_York" });
  assert.equal(built.rows.length, 4);
  assert.deepEqual(built.rows.map((r) => r.who), ["You", "Tex", "You", "Tex"]);
  assert.deepEqual(built.history.map((e) => e.from.kind), ["person", "tex", "person", "tex"]);
  assert.ok(built.history.every((e) => e.kind === "text" && e.at < now));
  // Whole days: the first session is still 09:15 in New York, and 27 days before the second.
  const first = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(built.history[0].at));
  assert.equal(first, "09:15");
  assert.equal(Math.round((built.history[2].at - built.history[0].at) / DAY), 27);
  // The question's date lands on today (within a day of now, never after it).
  assert.ok(built.askedAt <= now && now - built.askedAt < DAY);
  assert.equal(built.sessions, 2);
  assert.equal(built.days, 2);
  assert.equal(zonedMs(parseDate("2023/05/01 (Mon) 09:15"), "UTC"), Date.UTC(2023, 4, 1, 9, 15));
});

test("the judge prompt is LongMemEval's for each type, a moved date is said only when the answer names one, and only yes counts", () => {
  assert.match(judgePrompt({ id: "q", type: "multi-session", question: "Q", answer: "A" }, "R"), /^I will give you a question, a correct answer, and a response from a model\. Please answer yes if the response contains the correct answer\./);
  assert.match(judgePrompt({ id: "q", type: "temporal-reasoning", question: "Q", answer: "18 days" }, "R"), /do not penalize off-by-one errors/);
  assert.match(judgePrompt({ id: "q", type: "knowledge-update", question: "Q", answer: "A" }, "R"), /updated answer is the required answer/);
  assert.match(judgePrompt({ id: "q", type: "single-session-preference", question: "Q", answer: "A" }, "R"), /Rubric: A/);
  assert.match(judgePrompt({ id: "q_abs", type: "multi-session", question: "Q", answer: "A" }, "R"), /correctly identify the question as unanswerable/);
  assert.doesNotMatch(judgePrompt({ id: "q", type: "multi-session", question: "Q", answer: "3 dogs" }, "R", 1000), /moved/);
  assert.match(judgePrompt({ id: "q", type: "temporal-reasoning", question: "Q", answer: "May 28" }, "R", 1000), /moved 1000 days later/);
  assert.equal(verdictOf("Yes."), true);
  assert.equal(verdictOf("no"), false);
  assert.equal(abilityOf("x_abs", "temporal-reasoning"), "abstention");
});

test("an eval's question reads nothing of the developer's account, and keeps its chat history and the web", async () => {
  const gate = { blank: true, record() {}, call: async () => ({ found: null }) };
  for (const name of ["read_note", "search_notes", "search_email", "read_calendar", "orient", "fetch", "search"]) {
    assert.ok(BLANK_READS.has(name), name);
    const answer = await toolAnswer(name, { path: "tex/about.md" }, gate);
    assert.deepEqual(answer, blankRead(name), name);
  }
  for (const name of ["read_day", "read_back", "earlier_texts", "search_web", "open_page"]) assert.equal(await toolAnswer(name, {}, gate), null, name);
  // A test chat that is not an eval's reads for real.
  assert.equal(await toolAnswer("read_note", { path: "x.md" }, { record() {}, call: async () => ({ found: null }) }), null);
});

// ── A run, end to end over stand-ins for the test chats and the models ─────

function evalsStubOver() {
  const object = new LabEvalsObject({ storage: { sql: durableSql() } });
  return { fetch: (request) => object.fetch(request) };
}

function world({ quiet = new Set(), wrong = new Set() } = {}) {
  const chats = new Map();
  const opened = [];
  const sent = [];
  let next = 0;
  const open = async (body) => {
    const sandboxId = (next += 1).toString(16).padStart(16, "0");
    chats.set(sandboxId, { rows: body.seed.rows.map((r) => ({ ...r })), running: null });
    opened.push(body);
    return Response.json({ sandboxId });
  };
  const sandbox = async (body) => {
    const chat = chats.get(body.sandboxId);
    if (!chat) return { ok: false, status: 404, answer: {} };
    if (body.op === "send") {
      const id = `m${chat.rows.length}`;
      chat.rows.push({ id, who: "You", text: body.text, at: 1_000, steps: [{ node: "fd", model: "anthropic/claude-haiku-5-5", tokIn: 10_000, tokOut: 100 }] });
      sent.push(body.text);
      const qid = /What about (\S+)\?/.exec(body.text)?.[1];
      if (!quiet.has(qid)) chat.rows.push({ id: `${id}r`, who: "Tex", text: wrong.has(qid) ? "No idea." : `It's answer ${qid}.`, at: 4_000 });
      return { ok: true, status: 200, answer: { msgId: id } };
    }
    if (body.op === "get") return { ok: true, status: 200, answer: { rows: chat.rows, running: chat.running } };
    return { ok: false, status: 400, answer: {} };
  };
  const calls = [];
  const request = async (call) => {
    calls.push(call);
    if (call.messages[0].text.startsWith("THE DAY")) return { text: "They talked about their dog.", usage: { input: 1000, output: 30 } };
    const said = /Model Response: ([\s\S]*?)\n\n/.exec(call.messages[0].text)?.[1] ?? "";
    return { text: said.includes("No idea") || said === "(no reply)" ? "no" : "yes", usage: { input: 300, output: 2 } };
  };
  return { open, sandbox, request, opened, sent, calls, chats };
}

async function startRun(stub, bench, n) {
  const tables = evalsTables(durableSql());
  void tables;
  const fetchImpl = fileFetch();
  const { handleLabEvals } = await import("../src/labEvals/route.js");
  void handleLabEvals;
  // The index and run as `route.js` `start` writes them.
  const entries = await buildIndex("https://example.invalid/f.json", fetchImpl);
  const call = (op, fields) => stub.fetch(new Request(`https://lab-evals.internal/${op}`, { method: "POST", body: JSON.stringify(fields) })).then((r) => r.json());
  await call("source.put", { bench, source: { url: "https://example.invalid/f.json", sha: "a".repeat(40) }, entries });
  const picked = sliceOf(entries, n);
  await call("run.put", { run: { id: "evtest0000001", bench, versionId: "main", n: picked.length, status: "running", by: "Lab", at: 1, concurrency: 3 } });
  await call("items.put", { run: "evtest0000001", items: picked.map((e, i) => ({ qid: e.id, n: i, type: e.type, ability: e.ability, question: e.question, gold: e.answer, start: e.start, end: e.end, state: "waiting" })) });
  return { call, fetchImpl };
}

test("a run moves along: each question opens with its seed, gets day summaries, is texted, graded, and the run ends done", async () => {
  const stub = evalsStubOver();
  const { call, fetchImpl } = await startRun(stub, "longmemeval-s", 6);
  const w = world({ wrong: new Set(["q3"]) });
  let clock = Date.UTC(2026, 10, 20, 15, 0);
  const deps = { env: { ...GATEWAY, LAB_SANDBOX: { idFromName: (n) => n, get: () => ({ fetch: async (req) => {
    const op = new URL(req.url).pathname.slice(1);
    // The summaries' ledger over the stand-in test chat: its texts, and nothing kept.
    if (op === "ledger.read") {
      const body = await req.json();
      const kinds = body.options?.kinds ?? [];
      const rows = [...w.chats.values()].at(-1).rows.filter((r) => r.eid);
      const entries = kinds.includes("day") ? [] : rows.map((r) => ({ at: r.at, kind: "text", from: { kind: r.who === "Tex" ? "tex" : "person" }, text: r.text }));
      return Response.json({ entries: entries.reverse() });
    }
    return Response.json({ added: 1 });
  } }) } }, stub, who: { userId: "u1", timeZone: "UTC" }, open: w.open, sandbox: w.sandbox, request: w.request, fetchImpl, now: () => clock };
  let moved;
  for (let round = 0; round < 10; round += 1) {
    moved = await advance(deps, "evtest0000001");
    clock += 5_000;
    if (moved.run.status === "done") break;
  }
  assert.equal(moved.run.status, "done");
  assert.equal(w.opened.length, 6);
  assert.ok(w.opened.every((body) => body.source === "eval" && body.seed.rows.length === 4 && body.seed.history.length === 4));
  assert.equal(w.sent.length, 6);
  const { items } = await call("run", { id: "evtest0000001" });
  assert.ok(items.every((item) => item.state === "graded"), JSON.stringify(items.map((i) => [i.qid, i.state, i.error])));
  assert.equal(items.find((i) => i.qid === "q3").correct, false);
  assert.equal(items.filter((i) => i.correct).length, 5);
  assert.ok(items.every((i) => i.summaries === 2 && i.shiftDays > 1000));
  const scores = scoresOf(items);
  assert.equal(scores.pct, 83.3);
  assert.equal(scores.byAbility.multi.right, 0);
  assert.ok(scores.usd > 0);
  // Every judge call is LongMemEval's prompt, on the judge model.
  const judged = w.calls.filter((c) => c.model === "anthropic/claude-sonnet-5-5");
  assert.equal(judged.length, 6);
});

test("two drivers never start one question twice, a quiet Tex is graded after its grace, and a stopped run starts nothing", async () => {
  const stub = evalsStubOver();
  const { call, fetchImpl } = await startRun(stub, "longmemeval-s", 6);
  const w = world({ quiet: new Set(["q1", "q2_abs", "q3", "q4", "q5", "q6"]) });
  let clock = 1_000_000;
  const env = { ...GATEWAY, LAB_SANDBOX: { idFromName: (n) => n, get: () => ({ fetch: async () => Response.json({ entries: [] }) }) } };
  const deps = { env, stub, who: { userId: "u1" }, open: w.open, sandbox: w.sandbox, request: w.request, fetchImpl, now: () => clock };
  await Promise.all([advance(deps, "evtest0000001"), advance(deps, "evtest0000001")]);
  assert.equal(new Set(w.sent).size, w.sent.length, "no question texted twice");
  let { items } = await call("run", { id: "evtest0000001" });
  assert.ok(items.filter((i) => i.state === "asked").length <= 3, "at most the run's concurrency at once");
  // Quiet: not graded inside the grace, graded wrong after it.
  await advance(deps, "evtest0000001");
  ({ items } = await call("run", { id: "evtest0000001" }));
  assert.equal(items.filter((i) => i.state === "graded").length, 0);
  clock += 120_000;
  await advance(deps, "evtest0000001");
  ({ items } = await call("run", { id: "evtest0000001" }));
  const graded = items.filter((i) => i.state === "graded");
  assert.ok(graded.length > 0 && graded.every((i) => i.correct === false && i.note === "Tex sent no reply"));
  // Stopped: nothing more starts.
  await call("run.put", { run: { id: "evtest0000001", status: "stopped" } });
  const before = w.opened.length;
  clock += 120_000;
  await advance(deps, "evtest0000001");
  assert.equal(w.opened.length, before);
});

test("the test-chat route refuses an eval's seed from outside the evals", async () => {
  const { handleLabSandbox } = await import("../src/labSandbox/route.js");
  const env = { LAB_SANDBOX: {}, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const request = new Request("https://gw.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ op: "open", source: "eval", seed: { rows: [], history: [] } }) });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ userId: "u1", status: "ok" });
  try {
    const response = await handleLabSandbox(request, env, null, {});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /opened by the Lab's evals/);
  } finally {
    globalThis.fetch = original;
  }
});

test("the evals object keeps runs and items, merges an item's changes, and claims within the run's room", () => {
  const tables = evalsTables(durableSql());
  serveEvals(tables, "run.put", { run: { id: "r1", at: 1, status: "running" } });
  serveEvals(tables, "items.put", { run: "r1", items: [1, 2, 3, 4].map((n) => ({ qid: `q${n}`, n, state: "waiting" })) });
  assert.equal(serveEvals(tables, "claim", { run: "r1", max: 3, take: 2, now: 10, staleMs: 100 }).items.length, 2);
  assert.equal(serveEvals(tables, "claim", { run: "r1", max: 3, take: 2, now: 11, staleMs: 100 }).items.length, 1);
  assert.equal(serveEvals(tables, "claim", { run: "r1", max: 3, take: 2, now: 12, staleMs: 100 }).items.length, 0);
  // An opening gone stale is failed and frees its room.
  const after = serveEvals(tables, "claim", { run: "r1", max: 3, take: 2, now: 500, staleMs: 100 });
  assert.equal(after.items.length, 1);
  const { items } = serveEvals(tables, "run", { id: "r1" });
  assert.equal(items.filter((i) => i.state === "failed").length, 3);
  serveEvals(tables, "items.put", { run: "r1", items: [{ qid: "q4", state: "asked" }] });
  assert.equal(serveEvals(tables, "run", { id: "r1" }).items.find((i) => i.qid === "q4").n, 4, "a change keeps what it did not name");
  assert.equal(serveEvals(tables, "runs", {}).runs.length, 1);
});
