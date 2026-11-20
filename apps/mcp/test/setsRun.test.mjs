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
import { adaptersFor, countsLine, decideCase, decideRight, lineOf, reviewerCase, reviewerRight, routeCase, routeRight, routeTraining, runSets, scoreByRepeat, setsCommand } from "../bench/setsRun.mjs";
import { runFd } from "../bench/setsFd.mjs";
import { openWorldStore, worldKey } from "../bench/simFixtures.mjs";
import { strictWorld, worldLine, worldMisses, worldModeRefusal, worldStrict, WORLD_STRICT } from "../bench/setsRun.mjs";

const require = createRequire(import.meta.url);
const REPO = require("../../../packages/lab/src/texSetsRepo.generated.json");
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

test("countsLine adds the live door count from the front door's route records; the router count is its own rows", () => {
  const rows = [
    { chat: "c", msg: "m1", node: "fd", right: true, ran: true, usd: 0, route: { door: "quick", pick: "quick" } },
    { chat: "c", msg: "m2", node: "fd", right: false, ran: true, usd: 0, route: { door: "fd", pick: "none" } },
    { chat: "c", msg: "m3", node: "fd", right: false, ran: true, usd: 0, route: { door: "read", pick: "read", fellBack: "x" } },
    { chat: "c", msg: "m4", node: "router", right: true, ran: true, usd: 0, route: { pick: "read" } },
  ];
  assert.equal(countsLine(rows), "fd 1/3 · router 1/1 · doors 2/3 specialist (1 fell back) · $0.0000");
  assert.equal(countsLine(rows.slice(0, 1).concat(rows.slice(3))), "fd 1/1 · router 1/1 · doors 1/1 specialist (0 fell back) · $0.0000");
  assert.doesNotMatch(countsLine(rows.slice(3)), /doors/, "no fd rows with a route: no doors part");
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
  assert.deepEqual(routeCase(c, 0), { question: "hi", group: true, trigger: "text", context: { ctx: [], training: null, history: "", facts: [], today: "" } });
  assert.equal(routeCase(c, 1).trigger, "checkin");
  assert.equal(routeCase(c, 2).trigger, "routine");
  assert.deepEqual(routeCase(c, 3).trigger, "text", "a job's own report is a text, not a trigger");
  assert.equal(routeCase(conv("one", [{ id: "m1", who: "Ann", text: "hi" }]), 0).group, false);
});

test("routeCase reads the router's config context from the conversation, as the bench reads Decide's chat", () => {
  const msgs = [
    { id: "m1", who: "Ann", text: "draft an email to the landlord", at: "Mon 9:00" },
    { id: "x1", who: "Tex", tex: true, text: "Here's the draft." },
    { id: "r1", who: "Ann", kind: "react", to: "x1", text: "👍" },
    { id: "q", who: "Ann", text: "send", at: "Mon 9:02" },
  ];
  const c = conv("c", msgs);
  const ctx = ["train:router", "chat:7:130000", "date"];
  const training = { nodes: {} };
  const { context } = routeCase(c, 3, { ctx, training });
  assert.deepEqual(context.ctx, ctx, "the config's entries, as they are");
  assert.equal(context.training, training);
  assert.equal(context.history, msgs.slice(0, 3).map((m) => lineOf(c, m)).join("\n"), "everything before the message, each line as Decide's bench reads it");
  assert.doesNotMatch(context.history, /send/, "never the message itself or after it");
  assert.equal(context.today, "Mon 9:02");
  assert.deepEqual(context.facts, [], "no ledger in the bench, so no facts of the moment");
});

test("routeTraining: a Training conversation is held out whole, or cut at the message; others read every example", () => {
  const { withoutChat, cutAt } = createRequire(import.meta.url)("../../../packages/shared/src/texTraining.cjs");
  const generated = {
    nodes: { router: [{ chat: "c", at: 0, kind: "one", before: [], newest: "@ann: hi", label: { route: "quick" } }, { chat: "c", at: 2, kind: "one", before: [], newest: "@ann: send", label: { route: "act" } }, { chat: "o", at: 0, kind: "one", before: [], newest: "@bo: yo", label: { route: "quick" } }] },
    chats: {},
  };
  const own = conv("c", [{ id: "m1", who: "Ann", text: "hi" }, { id: "m2", who: "Ann", text: "x" }, { id: "m3", who: "Ann", text: "send" }], { set: "training" });
  const held = routeTraining(own, 2, generated, { holdOut: true, withoutChat, cutAt });
  assert.deepEqual(held.nodes.router.map((m) => m.chat), ["o"], "held out: none of its own");
  const cut = routeTraining(own, 1, generated, { holdOut: false, withoutChat, cutAt });
  assert.deepEqual(cut.nodes.router.map((m) => `${m.chat}${m.at}`), ["c0", "o0"], "in context: never its own label on the message or after it");
  assert.equal(routeTraining(conv("d", [{ id: "m1", who: "Ann", text: "hi" }], { set: "dev" }), 0, generated, { holdOut: true, withoutChat, cutAt }), generated);
  assert.equal(routeTraining(own, 1, generated, { holdOut: true }), null, "a tree without the cut reads no examples");
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

test("the router's bench reads its config context: Training examples and the chat before, within what Clef reads", { skip: !existsSync(join(REPO_ROOT, "apps/mcp/src/agent/routerContext.js")) && "routerContext.js is not in this tree yet" }, async () => {
  const seen = [];
  const routeEngine = async (state) => {
    seen.push(state);
    return null;
  };
  const c = conv("router-ctx", [{ id: "m1", who: "Ann", text: "draft a note to Jo about the leak" }, { id: "x1", who: "Tex", tex: true, text: "Here's a draft for Jo." }, { id: "m2", who: "Ann", text: "send it", labels: { router: { route: "act", star: true } } }], { set: "dev" });
  await runSets([c], { adapters: await adaptersFor(REPO_ROOT, { routeEngine }), node: "router" });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<examples>[\s\S]*<route>(quick|read|act|job)<\/route>/, "train:router's labelled examples");
  assert.match(seen[0], /<chat-history>\n@ann: draft a note to Jo about the leak\nYou: Here's a draft for Jo\.\n<\/chat-history>/, "the chat before it, newest last");
  assert.ok(seen[0].indexOf("<chat-history>") < seen[0].indexOf("<text>\nsend it"), "the text last");
  const { MAX_DECISION_STATE_CHARS } = await import("../src/agent/decide.js");
  assert.ok(seen[0].length <= MAX_DECISION_STATE_CHARS, `within what Clef reads (${seen[0].length})`);
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

test("runSets sends each Front door test `repeats` times, each copy its own object with its rep, and runs the other nodes once (Dev2, 2026-11-19)", async () => {
  const c = conv("rep1", [
    { id: "m1", who: "Ann", text: "what time is it?", labels: { fd: { must: ["answers the time"], star: true } } },
    { id: "m2", who: "Ann", text: "and tomorrow?", labels: { fd: { never: ["asks again"], star: true }, decide: { act: "respond", star: true } } },
  ]);
  const units = [];
  const decided = [];
  const adapters = {
    fd: {
      batch: async (list) => {
        units.push(...list);
        return list.map((u) => ({ ...u.row, right: true, ran: true, usd: 0.01 }));
      },
    },
    decide: async () => (cc, i) => {
      decided.push(cc.msgs[i].id);
      return { right: true, ran: true, usd: 0.001 };
    },
  };
  const rows = await runSets([c], { adapters, tree: "/x", repeats: 3 });
  assert.equal(units.length, 6, "two Front door tests, three repeats each");
  assert.deepEqual(units.map((u) => [u.at, u.row.rep]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.equal(new Set(units.map((u) => u.row)).size, 6, "each copy's row is its own object");
  assert.deepEqual(rows.filter((r) => r.node === "fd").map((r) => r.rep), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(decided, ["m2"], "decide runs once, whatever the repeats");
  assert.equal("rep" in rows.find((r) => r.node === "decide"), false, "a node that runs once carries no rep");
});

test("scoreByRepeat reads repeated rows as per-repeat pass counts: a repeat that did not run falls back to the test's rate, and a test that never ran is left out", () => {
  const rows = [
    // A: 2 of 3 repeats right; B: 0 of 3; D: a decide test right once, which counts at every repeat.
    { chat: "a", at: 1, node: "fd", rep: 0, right: true, ran: true },
    { chat: "a", at: 1, node: "fd", rep: 1, right: false, ran: true },
    { chat: "a", at: 1, node: "fd", rep: 2, right: true, ran: true },
    { chat: "b", at: 2, node: "fd", rep: 0, right: false, ran: true },
    { chat: "b", at: 2, node: "fd", rep: 1, right: false, ran: true },
    { chat: "b", at: 2, node: "fd", rep: 2, right: false, ran: true },
    { chat: "a", at: 3, node: "decide", right: true, ran: true },
  ];
  const s = scoreByRepeat(rows);
  assert.equal(s.repeats, 3);
  assert.deepEqual(s.perRepeat, [2, 1, 2], "rep 0: A and D right; rep 1: D only; rep 2: A and D");
  assert.deepEqual([s.score.mean, s.score.min, s.score.max, s.score.total, s.score.repeats], [1.67, 1, 2, 3, 3]);
  assert.deepEqual(s.tests.map((t) => [t.node, t.runs, t.passes]), [["fd", 3, 2], ["fd", 3, 0], ["decide", 1, 1]]);
  assert.deepEqual(scoreByRepeat(rows.filter((r) => r.node === "fd")).score.total, 2, "a node's band is read on its own rows");

  // E ran at repeats 0 and 2 only (rate 0.5); F never ran, so it is no test at all.
  const more = [
    { chat: "e", at: 0, node: "fd", rep: 0, right: true, ran: true },
    { chat: "e", at: 0, node: "fd", rep: 1, right: false, ran: false },
    { chat: "e", at: 0, node: "fd", rep: 2, right: false, ran: true },
    { chat: "f", at: 0, node: "fd", rep: 0, right: false, ran: false },
    { chat: "f", at: 0, node: "fd", rep: 1, right: false, ran: false },
    { chat: "f", at: 0, node: "fd", rep: 2, right: false, ran: false },
  ];
  const e = scoreByRepeat(more);
  assert.deepEqual(e.perRepeat, [1, 0.5, 0], "repeat 1 did not run: E counts its rate, 1 of 2");
  assert.deepEqual([e.score.mean, e.score.min, e.score.max, e.score.total], [0.5, 0, 1, 1]);
  assert.deepEqual(e.tests.map((t) => t.chat), ["e"]);
});

test("countsLine shows a repeated node's band over its repeats beside its count, and the cost is still every row's", () => {
  const rows = [0, 1, 2].flatMap((rep) => [0, 1, 2].map((u) => ({ chat: "c", at: u, node: "fd", rep, right: rep === 0 || (rep === 2 && u < 2), ran: true, usd: 0.01 })));
  // Per repeat the passes are 3, 0 and 2 of 3 tests: a band of 0 to 3, the count 5 of 9.
  assert.equal(countsLine(rows), "fd 5/9 (0–3 over 3 repeats) · $0.0900");
  assert.equal(countsLine(rows.filter((r) => r.rep === 0)), "fd 3/3 · $0.0300", "one repeat has no band");
});

test("setsCommand refuses a repeat count that is not 1 to 5, a bare --repeat, and a bad TEX_SETS_REPEAT, before it reads a file", async () => {
  const usage = /usage: sets run .*--repeat takes a whole number from 1 to 5 \(default 3\)/s;
  await assert.rejects(setsCommand("run", { repeat: "6", conversations: "/nope.json" }, { write() {} }), usage);
  await assert.rejects(setsCommand("run", { repeat: "0", conversations: "/nope.json" }, { write() {} }), /got "0"/);
  await assert.rejects(setsCommand("run", { repeat: "2.5", conversations: "/nope.json" }, { write() {} }), usage);
  await assert.rejects(setsCommand("run", { repeat: true, conversations: "/nope.json" }, { write() {} }), usage, "a bare --repeat is not 1");
  await assert.rejects(setsCommand("run", { repeat: undefined, conversations: "/nope.json" }, { write() {} }), usage, "a flag with no value is not the default");
  const was = process.env.TEX_SETS_REPEAT;
  process.env.TEX_SETS_REPEAT = "9";
  try {
    await assert.rejects(setsCommand("run", { conversations: "/nope.json" }, { write() {} }), usage, "the environment's value is checked too");
  } finally {
    if (was === undefined) delete process.env.TEX_SETS_REPEAT;
    else process.env.TEX_SETS_REPEAT = was;
  }
});

test("a fake run never says it ran on Claude Code, even with a model socket set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sets-run-test-"));
  const was = process.env.BENCH_MODEL_SOCKET;
  try {
    const input = join(dir, "convs.json");
    await writeFile(input, JSON.stringify([conv("fk", [{ id: "m1", who: "Ann", text: "hi", labels: { decide: { act: "respond", star: true } } }])]));
    process.env.BENCH_MODEL_SOCKET = dir;
    const printed = [];
    await setsCommand("run", { conversations: input, tree: REPO_ROOT, fake: true }, { write: (t) => printed.push(t) });
    assert.doesNotMatch(printed.join(""), /Models: Claude Code/);
  } finally {
    if (was === undefined) delete process.env.BENCH_MODEL_SOCKET;
    else process.env.BENCH_MODEL_SOCKET = was;
    await rm(dir, { recursive: true, force: true });
  }
});

test("worldLine counts the calls the world had no fixture for, deduped, by kind; never a call's text", () => {
  const miss = (chat, kind, call) => ({ kind, call });
  const rows = [
    // Two units of one test share its calls: each counts once.
    { chat: "c", msg: "m1", node: "fd", world: { misses: 2, calls: [miss("c", "web search", "{\"query\":\"secret flight\"}"), miss("c", "gmail search", "{\"q\":\"secret\"}")] } },
    { chat: "c", msg: "m2", node: "fd", world: { misses: 2, calls: [miss("c", "web search", "{\"query\":\"secret flight\"}"), miss("c", "gmail search", "{\"q\":\"secret\"}")] } },
    { chat: "d", msg: "m3", node: "fd", world: { misses: 1, calls: [miss("d", "web search", "{\"query\":\"other\"}")] } },
    { chat: "c", msg: "m4", node: "decide", right: true, ran: true, usd: 0 },
  ];
  assert.deepEqual(worldMisses(rows), [
    { chat: "c", kind: "web search", call: "{\"query\":\"secret flight\"}" },
    { chat: "c", kind: "gmail search", call: "{\"q\":\"secret\"}" },
    { chat: "d", kind: "web search", call: "{\"query\":\"other\"}" },
  ]);
  const line = worldLine(rows);
  assert.equal(line, "world: 3 simulated call(s) not in fixtures (web search 2, gmail search 1)");
  assert.doesNotMatch(line, /secret|other|query/);
  assert.equal(worldLine([{ chat: "c", msg: "m1", node: "fd", world: { misses: 0, calls: [] } }]), "world: every simulated call replayed from fixtures");
  assert.equal(worldLine([{ chat: "c", msg: "m4", node: "decide", right: true }]), "", "no row has a world: nothing to say");
  assert.deepEqual(worldMisses([{ chat: "c", msg: "m4", node: "decide" }]), []);
});

test("setsCommand refuses --world record or refresh with --conversations: the repo's fixtures only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sets-run-test-"));
  try {
    const input = join(dir, "convs.json");
    await writeFile(input, JSON.stringify([]));
    for (const world of ["record", "refresh"]) {
      await assert.rejects(setsCommand("run", { conversations: input, world, tree: REPO_ROOT, fake: true }, { write() {} }), /repo's sets only/);
    }
    // Replay is the default and reads a handed-in file as before.
    const rows = await setsCommand("run", { conversations: input, world: "replay", tree: REPO_ROOT, fake: true }, { write() {} });
    assert.deepEqual(rows, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runFd records each test's world misses on its rows, from the fixture's run folder the test was given", { timeout: 60000 }, async () => {
  const c = { ...conv("world-1", [{ id: "m1", who: "Maya", text: "what does the flight cost?", labels: { fd: { must: ["answer"], star: true } } }]), members: ["Maya"], world: "maya" };
  const seenFronts = [];
  const runTests = async (_tree, tests, opts) => {
    const name = tests[0];
    const md = await readFile(join(opts.dir, "tests", `${name}.md`), "utf8");
    const runDir = /^world_run: (.+)$/m.exec(md)?.[1];
    seenFronts.push(/^world_mode: (.+)$/m.exec(md)?.[1]);
    // What simWorld does on a miss: claim the answer in the conversation's run folder, under this test's name.
    const store = openWorldStore({ runDir, mode: "replay", test: /^world_test: (.+)$/m.exec(md)?.[1] });
    store.claim(worldKey("web search", { query: "flight" }), "web search", { query: "flight" }, { answer: "$689" });
    return { rows: [{ id: `${name}/q1`, right: true, bench: [] }], usd: 0.002, bars: {}, missing: [] };
  };
  const rows = await runFd([{ convo: c, at: 0, label: c.msgs[0].labels.fd, row: { chat: c.id, msg: "m1", at: 0, node: "fd" } }], { tree: REPO_ROOT, runTests, env: {} });
  assert.deepEqual(seenFronts, ["replay"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].right, true);
  assert.deepEqual(rows[0].world, { misses: 1, calls: [{ kind: "web search", call: JSON.stringify({ query: "flight" }) }] });
  assert.equal(worldLine(rows), "world: 1 simulated call(s) not in fixtures (web search 1)");
});

/* ---------------------- the simulated world's strict check and its mode's refusal ---------------------- */

const rowsWithMisses = (n) => [{ chat: "c1", world: { misses: n, calls: Array.from({ length: n }, (_, i) => ({ kind: "web search", call: `{"query":"q${i}"}` })) } }];

test("worldStrict reads off, warn and fail, and any other value is off", () => {
  assert.deepEqual(WORLD_STRICT, ["off", "warn", "fail"]);
  assert.equal(worldStrict("warn"), "warn");
  assert.equal(worldStrict(" fail "), "fail");
  assert.equal(worldStrict("FAIL"), "off", "case is not read");
  assert.equal(worldStrict("loud"), "off");
  assert.equal(worldStrict(undefined), "off");
  assert.equal(worldStrict(true), "off", "a bare flag is off");
});

test("strictWorld: off says nothing; warn writes a warning annotation and does not fail; fail writes an error and fails", () => {
  const rows = rowsWithMisses(2);
  const off = strictWorld(rows, "off");
  assert.deepEqual(off, { misses: 2, line: "", fail: false });
  const warn = strictWorld(rows, "warn", { set: "dev" });
  assert.equal(warn.misses, 2);
  assert.equal(warn.fail, false);
  assert.equal(warn.line, "::warning::world: 2 simulated call(s) not in fixtures; the model answered them once and the run saved them, so the next run replays them");
  const fail = strictWorld(rows, "fail", { set: "training" });
  assert.equal(fail.fail, true);
  assert.match(fail.line, /^::error::world: 2 simulated call\(s\) not in fixtures; the model answered them once and the run saved them, so the next run replays them$/);
});

test("strictWorld: zero misses say nothing and never fail, and record or refresh never warn or fail even with misses", () => {
  assert.deepEqual(strictWorld(rowsWithMisses(0), "fail"), { misses: 0, line: "", fail: false });
  assert.deepEqual(strictWorld([{ chat: "c1" }], "fail"), { misses: 0, line: "", fail: false }, "a row with no world says nothing");
  for (const world of ["record", "refresh"]) {
    assert.deepEqual(strictWorld(rowsWithMisses(3), "fail", { world }), { misses: 3, line: "", fail: false }, world);
    assert.deepEqual(strictWorld(rowsWithMisses(3), "warn", { world }), { misses: 3, line: "", fail: false }, world);
  }
});

test("worldModeRefusal: replay is never refused; record and refresh run only on the repo's Training or Dev set", () => {
  assert.equal(worldModeRefusal({ world: "replay", set: "test", conversations: true }), null, "replay reads anything the set says");
  for (const world of ["record", "refresh"]) {
    assert.equal(worldModeRefusal({ world, set: "dev" }), null, `${world} on dev`);
    assert.equal(worldModeRefusal({ world, set: "training", convs: [{ set: "training" }, { set: "dev" }] }), null, `${world} on training`);
    assert.match(worldModeRefusal({ world, set: "test" }), /never the sealed Test set/, `${world} on the Test set`);
    assert.match(worldModeRefusal({ world, set: "dev", convs: [{ set: "dev" }, { set: "test" }] }), /never the sealed Test set/, "a loaded conversation of the Test set");
    assert.match(worldModeRefusal({ world, set: "dev", convs: [{ set: undefined }] }), /never the sealed Test set/, "a conversation with no set");
    assert.match(worldModeRefusal({ world, set: true }), /never the sealed Test set/, "a bare --set");
    assert.match(worldModeRefusal({ world, set: "dev", conversations: true }), /never a handed-in or sealed file/, "a handed-in file");
  }
});
