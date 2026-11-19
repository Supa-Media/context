/**
 * A node run alone on its unit tests (`bench/setsRun.mjs`; Dev2, 2026-11-15: "unit tests should be marked per message,
 * per node"). Pinned here: how a chat line reads to the judge (Tex as "You"), how a message's case is built from the
 * history before it, how a verdict is scored against a label (each labelled field, "any" skipped), the reviewer's
 * sentBack, that `runSets` runs only starred labels and reports what cannot run without a message's words, batch
 * adapters get grouped units, the CLI writes rows to its file and prints counts only, and that the fake run gets the
 * repo's Dev Set right for decide and reviewer.
 *
 * The fake run is right by construction for decide and reviewer (its fake engine and fake reviewer answer what the
 * label says), so the end-to-end test proves the wiring and the scoring, not the models.
 *
 * Sabotage record (temporary local edits to bench/setsRun.mjs, restored from a byte-identical backup, 2026-11-15):
 *   runSets running unstarred labels too            "runSets runs only starred labels ..." and 6 more fail
 *   decideRight not skipping "any"                  "decideRight scores act, also_react and why, and skips any" fails
 *   lineOf writing Tex's rows as "@tex"             "lineOf reads a line as the judge does ..." and "decideCase ..." fail
 *   countsLine printing each row's why              "countsLine has counts by node ..." fails
 *   a runner's error not caught in runSets          "an adapter that throws is reported on its row ..." fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adaptersFor, countsLine, decideCase, decideRight, lineOf, reviewerCase, reviewerRight, routeCase, routeRight, runSets, setsCommand } from "../bench/setsRun.mjs";

const require = createRequire(import.meta.url);
const REPO = require("../../../packages/shared/src/texSetsRepo.generated.json");
const { unitTests } = require("../../../packages/shared/src/texSets.cjs");
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

const conv = (id, msgs, extra = {}) => ({ id, title: id, set: "dev", kind: "one", members: ["Ann"], msgs, ...extra });

test("lineOf reads a line as the judge does: handles lowercased, Tex as You, and each special kind", () => {
  const c = conv("c", [
    { id: "m1", who: "Jo Smith", text: "is the bin out?" },
    { id: "m2", who: "Tex", tex: true, text: "yes, this morning" },
    { id: "m3", who: "Ann", kind: "react", to: "m2", text: "❤️" },
    { id: "m4", who: "Ann", kind: "reply", to: "m1", text: "I think so" },
    { id: "m5", who: "Ann", kind: "reply", to: "m2", text: "great" },
    { id: "m6", who: "Ann", kind: "edit", to: "m1", text: "is the bin out yet?" },
    { id: "m7", who: "Ann", kind: "delete", to: "m1" },
    { id: "m8", who: "Ann", kind: "react", to: "m1" },
  ]);
  const byId = Object.fromEntries(c.msgs.map((m) => [m.id, m]));
  assert.equal(lineOf(c, byId.m1), "@josmith: is the bin out?");
  assert.equal(lineOf(c, byId.m2), "You: yes, this morning");
  assert.equal(lineOf(c, byId.m3), `@ann: ❤️ on Tex's message "yes, this morning"`);
  assert.equal(lineOf(c, byId.m4), "@ann: (replying to @josmith) I think so");
  assert.equal(lineOf(c, byId.m5), "@ann: (replying to You) great");
  assert.equal(lineOf(c, byId.m6), '@ann: (edited "is the bin out?" to) is the bin out yet?');
  assert.equal(lineOf(c, byId.m7), '@ann: (deleted "is the bin out?")');
  assert.equal(lineOf(c, byId.m8), '@ann: 👍 on the message "is the bin out?"', "a react with no words is a thumbs up");
});

test("lineOf cuts the message it quotes", () => {
  const long = "a".repeat(80);
  const c = conv("c", [{ id: "m1", who: "Jo", text: long }, { id: "m2", who: "Ann", kind: "edit", to: "m1", text: "short" }]);
  const line = lineOf(c, c.msgs[1]);
  assert.equal(line, `@ann: (edited "${"a".repeat(39)}…" to) short`);
});

test("decideCase builds the lines before a message from the history, and names the chat's kind and setting", () => {
  const c = conv("c1", [
    { id: "m1", who: "Ann", text: "hi" },
    { id: "m2", who: "Tex", tex: true, text: "hello" },
    { id: "m3", who: "Jo", text: "thanks" },
  ], { kind: "group", setting: "quiet", members: ["Ann", "Jo"] });
  const item = decideCase(c, 2);
  assert.equal(item.id, "c1/m3");
  assert.equal(item.chat, "group");
  assert.equal(item.setting, "quiet");
  assert.deepEqual(item.lines, ["@ann: hi", "You: hello"]);
  assert.equal(item.text, "@jo: thanks");
  const one = decideCase(conv("c2", [{ id: "m1", who: "Ann", text: "hi" }]), 0);
  assert.equal(one.chat, "one");
  assert.equal("setting" in one, false);
  assert.deepEqual(one.lines, []);
});

test("decideRight scores act, also_react and why, and skips any", () => {
  const answer = { ok: true, act: "answer", why: "asks_tex", movedOn: false };
  assert.deepEqual(decideRight({ act: "respond", also_react: "no", why: "asks_tex", moved_on: "no" }, answer), { right: true, why: "" });
  assert.deepEqual(decideRight({ act: "wait" }, answer), { right: false, why: "act respond, wanted wait" });
  assert.deepEqual(decideRight({ act: "respond", why: "thanks_or_ok" }, answer), { right: false, why: "why asks_tex, wanted thanks_or_ok" });
  assert.deepEqual(decideRight({ act: "respond", also_react: "yes" }, answer), { right: false, why: "also_react no, wanted yes" });
  assert.deepEqual(decideRight({ act: "respond", why: "any", also_react: "any" }, answer), { right: true, why: "" });
  // A react verdict is quiet on the act and yes on also_react.
  assert.deepEqual(decideRight({ act: "quiet", also_react: "yes" }, { ok: true, act: "react" }), { right: true, why: "" });
  // An answer that also reacts (its emoji beside the act) is yes on also_react: reacting is decided on its own.
  assert.deepEqual(decideRight({ act: "respond", also_react: "yes" }, { ...answer, emoji: "😂" }), { right: true, why: "" });
  assert.deepEqual(decideRight({ act: "respond", also_react: "no" }, { ...answer, emoji: "😂" }), { right: false, why: "also_react yes, wanted no" });
  // A verdict with no why is "none" there.
  assert.equal(decideRight({ why: "none" }, { ok: true, act: "silent" }).right, true);
  assert.deepEqual(decideRight({ act: "respond" }, { ok: false }), { right: false, why: "no verdict" });
  assert.deepEqual(decideRight({ act: "respond" }, null), { right: false, why: "no verdict" });
});

test("reviewerRight: 0 lets the draft go, 1 and 2+ send it back, any and no label are skipped", () => {
  assert.deepEqual(reviewerRight({ sentBack: "0" }, { send: true }), { right: true, why: "" });
  assert.deepEqual(reviewerRight({ sentBack: "0" }, { send: false }), { right: false, why: "sent it back, wanted it to go" });
  assert.deepEqual(reviewerRight({ sentBack: "1" }, { send: false }), { right: true, why: "" });
  assert.deepEqual(reviewerRight({ sentBack: "2+" }, { send: false }), { right: true, why: "" });
  assert.deepEqual(reviewerRight({ sentBack: "1" }, { send: true }), { right: false, why: "let it go, wanted it sent back" });
  assert.equal(reviewerRight({ sentBack: "any" }, { send: true }).right, true);
  assert.equal(reviewerRight({}, { send: false }).right, true);
  assert.deepEqual(reviewerRight({ sentBack: "0" }, null), { right: false, why: "no verdict" });
});

test("reviewerCase takes the draft and its did from the front door's recorded run, and the earlier lines without kinds", () => {
  const c = conv("r1", [
    { id: "m1", who: "Ann", text: "Can you check the inbox?" },
    { id: "m2", who: "Tex", tex: true, text: "sure" },
    { id: "m3", who: "Ann", kind: "reply", to: "m1", text: "also" },
    { id: "m4", who: "Ann", text: "thanks", rec: { fd: { draft: "Checking now.", did: ["searched inbox"] } } },
  ]);
  assert.deepEqual(reviewerCase(c, 3), {
    id: "r1/m4",
    q: "thanks",
    earlier: [["person", "Can you check the inbox?"], ["tex", "sure"]],
    did: ["searched inbox"],
    reply: "Checking now.",
  });
  const bare = reviewerCase(c, 0);
  assert.deepEqual([bare.reply, bare.did], ["", []]);
});

// A fixed set of labelled messages, one conversation: three unit tests (decide x2, reviewer x1), one unstarred label.
const fixture = () =>
  conv("c1", [
    { id: "m1", who: "Ann", text: "is it on?", labels: { decide: { act: "respond", star: true }, reviewer: { sentBack: "0", star: true } } },
    { id: "m2", who: "Ann", text: "thanks", labels: { decide: { act: "quiet" } } },
    { id: "m3", who: "Ann", text: "where?", labels: { decide: { act: "respond", star: true } }, rec: { fd: { draft: "x" } } },
  ]);

test("runSets runs only starred labels, each through its node's adapter, and says what each row is", async () => {
  const seen = [];
  const adapters = {
    decide: async () => (c, i, label) => {
      seen.push(["decide", c.msgs[i].id, label.act]);
      return { right: true, ran: true, usd: 0.001 };
    },
    reviewer: async () => (c, i, label) => {
      seen.push(["reviewer", c.msgs[i].id, label.sentBack]);
      return { right: false, ran: true, usd: 0, why: "sent it back, wanted it to go" };
    },
  };
  const rows = await runSets([fixture()], { adapters, tree: "/nowhere" });
  assert.deepEqual(rows.map((r) => [r.chat, r.msg, r.node, r.right, r.ran]), [
    ["c1", "m1", "decide", true, true],
    ["c1", "m1", "reviewer", false, true],
    ["c1", "m3", "decide", true, true],
  ]);
  assert.deepEqual(seen, [["decide", "m1", "respond"], ["reviewer", "m1", "0"], ["decide", "m3", "respond"]]);
  assert.equal(rows.some((r) => r.msg === "m2"), false, "an unstarred label is no unit test");
  assert.equal(rows.length, unitTests(fixture()).length);
});

test("runSets honours node, and reports a node with no adapter as ran: false rather than passing it", async () => {
  const adapters = { decide: async () => () => ({ right: true, ran: true, usd: 0 }) };
  const only = await runSets([fixture()], { adapters, node: "decide", tree: "/nowhere" });
  assert.deepEqual(only.map((r) => r.node), ["decide", "decide"]);
  const all = await runSets([fixture()], { adapters, tree: "/nowhere" });
  const missing = all.find((r) => r.node === "reviewer");
  assert.deepEqual([missing.right, missing.ran], [false, false]);
  assert.equal(missing.why, "reviewer can't run alone yet: it runs in the whole-turn replay");
});

test("an adapter that throws is reported on its row, not thrown, whether at the factory or the run", async () => {
  const factory = await runSets([fixture()], { adapters: { decide: async () => { throw new Error("no key"); } }, tree: "/x" });
  assert.deepEqual(factory.filter((r) => r.node === "decide").map((r) => [r.ran, r.right, r.why]), [[false, false, "could not run: no key"], [false, false, "could not run: no key"]]);
  const run = await runSets([fixture()], { adapters: { decide: async () => () => { throw new Error("bad call"); } }, node: "decide", tree: "/x" });
  assert.deepEqual(run.map((r) => r.why), ["could not run: bad call", "could not run: bad call"]);
});

test("a batch adapter gets the grouped units of its node once, with the conversation, the message and its label", async () => {
  const c = conv("fd1", [
    { id: "m1", who: "Ann", text: "what time is it?", labels: { fd: { must: ["answers the time"], star: true } } },
    { id: "m2", who: "Ann", text: "and tomorrow?", labels: { fd: { never: ["asks again"], star: true } } },
  ]);
  const calls = [];
  const adapters = {
    fd: {
      batch: async (units) => {
        calls.push(units.map((u) => [u.convo.id, u.at, u.label.must ?? u.label.never, u.row.node]));
        return units.map((u) => ({ ...u.row, right: true, ran: true, usd: 0 }));
      },
    },
  };
  const rows = await runSets([c], { adapters, tree: "/x" });
  assert.equal(calls.length, 1, "one batch call for the node");
  assert.deepEqual(calls[0], [["fd1", 0, ["answers the time"], "fd"], ["fd1", 1, ["asks again"], "fd"]]);
  assert.deepEqual(rows.map((r) => [r.msg, r.right]), [["m1", true], ["m2", true]]);
});

test("a batch that throws reports each of its units, not the run", async () => {
  const c = conv("fd2", [{ id: "m1", who: "Ann", text: "hi", labels: { fd: { must: ["x"], star: true } } }]);
  const rows = await runSets([c], { adapters: { fd: { batch: async () => { throw new Error("gateway down"); } } }, tree: "/x" });
  assert.deepEqual(rows.map((r) => [r.node, r.ran, r.why]), [["fd", false, "could not run: gateway down"]]);
});

test("the in-process nodes run beside the batched ones, which get the parallel count, and rows keep their order", { timeout: 5000 }, async () => {
  const c = conv("both", [
    { id: "m1", who: "Ann", text: "hi", labels: { decide: { act: "respond", star: true }, fd: { must: ["x"], star: true } } },
    { id: "m2", who: "Ann", text: "and you?", labels: { decide: { act: "wait", star: true }, fd: { must: ["y"], star: true } } },
  ]);
  let release;
  const fdStarted = new Promise((r) => (release = r));
  const seen = [];
  const adapters = {
    // Decide waits for the Front door's batch to have started: run one after the other, this never resolves.
    decide: async () => async () => (await fdStarted, { right: true, ran: true, usd: 0 }),
    fd: { batch: async (units, opts) => (seen.push(opts.parallel), release(), units.map((u) => ({ ...u.row, right: true, ran: true, usd: 0 }))) },
  };
  const rows = await runSets([c], { adapters, tree: "/x", parallel: 5 });
  assert.deepEqual(seen, [5]);
  assert.deepEqual(rows.map((r) => [r.node, r.msg]), [["decide", "m1"], ["decide", "m2"], ["fd", "m1"], ["fd", "m2"]]);
});

test("countsLine has counts by node, the cost, and never a message's words", () => {
  const rows = [
    { chat: "c", msg: "m1", node: "decide", right: true, ran: true, usd: 0.001, why: "secret words" },
    { chat: "c", msg: "m2", node: "decide", right: false, ran: true, usd: 0, why: "ally" },
    { chat: "c", msg: "m3", node: "fd", right: false, ran: false, usd: 0, why: "the front door runs alone only on a one-ask chat" },
  ];
  const line = countsLine(rows);
  assert.equal(line, "decide 1/2 · fd 0/1 (1 can't run alone) · $0.0010");
  assert.doesNotMatch(line, /secret|ally|front door|zebrafish/);
});

test("setsCommand runs a file of conversations and writes the rows to --out; stdout is counts only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sets-run-test-"));
  try {
    const convs = [
      conv("cli-1", [
        { id: "m1", who: "Ann", text: "zebrafish is on the list" },
        { id: "m2", who: "Tex", tex: true, text: "sure, zebrafish added" },
        { id: "m3", who: "Ann", text: "and the sheep?", labels: { decide: { act: "respond", star: true } } },
        { id: "m4", who: "Ann", text: "check the zebrafish again", labels: { reviewer: { sentBack: "0", star: true } }, rec: { fd: { draft: "Zebrafish checked.", did: [] } } },
      ]),
    ];
    const input = join(dir, "convs.json");
    const out = join(dir, "rows.json");
    await writeFile(input, JSON.stringify(convs));
    const printed = [];
    const rows = await setsCommand("run", { conversations: input, out, tree: REPO_ROOT, fake: true }, { write: (t) => printed.push(t) });
    assert.equal(rows.length, 2);
    const onDisk = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual(onDisk.map((r) => [r.node, r.msg, r.right, r.ran]), [["decide", "m3", true, true], ["reviewer", "m4", true, true]]);
    const stdout = printed.join("");
    assert.equal(stdout, `${countsLine(rows)}\n`);
    assert.doesNotMatch(stdout, /zebrafish|sheep/, "a file handed in may be sealed: no message words on standard output");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setsCommand refuses another subcommand and a file that is not a list", async () => {
  await assert.rejects(setsCommand("ship", {}, { write() {} }), /usage: sets run/);
  const dir = await mkdtemp(join(tmpdir(), "sets-run-test-"));
  try {
    const input = join(dir, "not-a-list.json");
    await writeFile(input, JSON.stringify({ id: "x" }));
    await assert.rejects(setsCommand("run", { conversations: input, tree: REPO_ROOT, fake: true }, { write() {} }), /JSON list of conversations/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the fake run gets the repo's conversations right for decide and reviewer, and runs every one of them", async () => {
  // Training and Dev together: which set holds a node's labels moves with the ratio, the runner's job does not.
  const dev = REPO.sets;
  // One node per run: running every node's fake for every row took ~110 s and hit the file's two-minute limit.
  for (const node of ["decide", "reviewer"]) {
    const mine = await runSets(dev, { tree: REPO_ROOT, fake: true, node });
    assert.ok(mine.every((r) => r.node === node), `only ${node} rows ran`);
    const expected = dev.reduce((n, c) => n + unitTests(c).filter((t) => t.node === node).length, 0);
    // The reviewer's labels left with the old conversations (Dev2, 2026-11-17); Decide's must always be there.
    if (node === "decide") assert.ok(expected > 0, `the repo has ${node} unit tests`);
    assert.equal(mine.length, expected);
    assert.deepEqual(
      mine.filter((r) => !r.right || !r.ran).map((r) => [r.chat, r.msg, r.why]),
      [],
      `every ${node} unit test is right and ran`,
    );
  }
});

test("lineOf tells the judge a picture came with a text", () => {
  const pic = { url: "https://example.invalid/a.png" };
  const c = conv("c", [
    { id: "m1", who: "Jo", text: "look", pics: [pic] },
    { id: "m2", who: "Jo", text: "", pics: [pic, pic] },
  ]);
  assert.equal(lineOf(c, c.msgs[0]), "@jo: look (sent a picture)");
  assert.equal(lineOf(c, c.msgs[1]), "@jo: (sent 2 pictures)");
});

/** Router rows: the message's words are the question, the labelled route is the want. */
const routerChat = () =>
  conv(
    "router-1",
    [
      { id: "m1", who: "Ann", text: "is the bin out?", labels: { router: { route: "quick", star: true } } },
      { id: "m2", who: "Ann", text: "send the invoice to Jo", labels: { router: { route: "act", star: true } } },
      { id: "m3", who: "Ann", text: "what's the wifi code", labels: { router: { route: "read", star: true } } },
    ],
    { set: "training" },
  );

test("routeCase takes the message's words, the chat's kind, and a check-in or routine as its trigger, else a text", () => {
  const c = conv(
    "c",
    [
      { id: "m1", who: "Ann", text: "hi" },
      { id: "m2", who: "Check-in", via: "checkin", text: "Gmail: a permit came in" },
      { id: "m3", who: "Routine", via: "routine", text: "weekly tidy" },
      { id: "m4", who: "Background job", via: "job", state: "done", text: "done" },
    ],
    { kind: "group" },
  );
  assert.deepEqual(routeCase(c, 0), { question: "hi", group: true, trigger: "text", recent: [] });
  assert.deepEqual(routeCase(c, 1), { question: "Gmail: a permit came in", group: true, trigger: "checkin", recent: [{ who: "Them", text: "hi" }] });
  assert.deepEqual(routeCase(c, 2), { question: "weekly tidy", group: true, trigger: "routine", recent: [{ who: "Them", text: "hi" }, { who: "Tex", text: "Gmail: a permit came in" }] });
  assert.deepEqual(routeCase(c, 3).trigger, "text", "a job's own report is a text, not a trigger");
  assert.equal(routeCase(conv("one", [{ id: "m1", who: "Ann", text: "hi" }]), 0).group, false);
});

test("routeCase gives the router the chat's last 8 texts before the message, as the live router reads them", () => {
  const msgs = [
    ...Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, who: "Ann", text: `t${i}` })),
    { id: "r1", who: "Ann", kind: "react", to: "m8", text: "👍" },
    { id: "d1", who: "Ann", kind: "delete", to: "m7" },
    { id: "x1", who: "Tex", tex: true, text: "Here's the draft." },
    { id: "j1", who: "Background job", via: "job", text: "Still looking." },
    { id: "q", who: "Ann", text: "send" },
  ];
  const { recent } = routeCase(conv("c", msgs), msgs.length - 1);
  assert.deepEqual(recent.map((l) => l.text), ["t3", "t4", "t5", "t6", "t7", "t8", "Here's the draft.", "Still looking."], "no reactions or deletes, only the last 8");
  assert.deepEqual(recent.slice(-2).map((l) => l.who), ["Tex", "Tex"], "Tex's own and its job's lines are Tex's");
  assert.equal(recent[0].who, "Them");
});

test("routeRight is right only when the pick is the labelled route; no pick is wrong and says so", () => {
  assert.deepEqual(routeRight({ route: "read" }, "read"), { right: true, why: "" });
  assert.equal(routeRight({ route: "read" }, "act").right, false);
  assert.equal(routeRight({ route: "read" }, "act").why, "routed act, wanted read");
  assert.equal(routeRight({ route: "read" }, null).right, false);
  assert.equal(routeRight({ route: "read" }, null).why, "no route, wanted read");
});

test("the router runs alone with a fake engine: right, wrong and none rows, each with its pick and sure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-stub-"));
  try {
    // A tree whose router module answers the way the contract says: the question is the state, the reader takes route.
    await mkdir(join(dir, "apps/mcp/src/agent"), { recursive: true });
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(dir, "apps/mcp/src/agent/specialistRoute.js"),
      [
        "export function routeRequest({ question }) { return { state: question, questions: [{ name: \"route\" }] }; }",
        "export function readRoute(answers) { return answers && typeof answers.route === \"string\" ? { route: answers.route, sure: 0.9 } : null; }",
        "",
      ].join("\n"),
    );
    const said = { "is the bin out?": "quick", "send the invoice to Jo": "quick", "what's the wifi code": null };
    const seen = [];
    const routeEngine = async (state) => {
      seen.push(state);
      return said[state] ? { route: said[state] } : null;
    };
    const rows = await runSets([routerChat()], { adapters: await adaptersFor(dir, { routeEngine }), node: "router" });
    assert.deepEqual(seen, ["is the bin out?", "send the invoice to Jo", "what's the wifi code"]);
    assert.deepEqual(
      rows.map((r) => [r.msg, r.node, r.right, r.ran, r.got, r.want, r.usd, r.route]),
      [
        ["m1", "router", true, true, "quick", "quick", 0, { pick: "quick", sure: 0.9 }],
        ["m2", "router", false, true, "quick", "act", 0, { pick: "quick", sure: 0.9 }],
        ["m3", "router", false, true, null, "read", 0, { pick: null, sure: null }],
      ],
    );
    assert.equal(rows[1].why, "routed quick, wanted act");
    assert.equal(rows[2].why, "no route, wanted read");
    assert.equal(rows[0].chat, "router-1");
    assert.equal(rows[0].at, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the router's real module, with a fake engine: every row runs, none is right by accident", { skip: !existsSync(join(REPO_ROOT, "apps/mcp/src/agent/specialistRoute.js")) && "specialistRoute.js is not in this tree yet" }, async () => {
  const routeEngine = async () => null;
  const rows = await runSets([routerChat()], { adapters: await adaptersFor(REPO_ROOT, { routeEngine }), node: "router" });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.node === "router" && r.ran === true && r.right === false && r.got === null), "no answer is no route");
});

test("the router without Clef credentials says so on each row, rather than scoring every row wrong", { skip: !existsSync(join(REPO_ROOT, "apps/mcp/src/agent/specialistRoute.js")) && "specialistRoute.js is not in this tree yet" }, async () => {
  const rows = await runSets([routerChat()], { adapters: await adaptersFor(REPO_ROOT, { env: {} }), node: "router" });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.ran === false && r.right === false && /CLOUDFLARE_ACCOUNT_ID/.test(r.why)));
});

test("a tree without the router module says so on each row instead of passing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-absent-"));
  try {
    const rows = await runSets([routerChat()], { adapters: await adaptersFor(dir, {}), node: "router" });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.ran === false && r.right === false && /can't run alone yet/.test(r.why)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
