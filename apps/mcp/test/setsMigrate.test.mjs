/**
 * The migration of today's Tex bench cases into conversations (`apps/mcp/bench/setsMigrate.mjs`): every migrated
 * conversation passes the contract, each source case comes out once, the mappings hold, and the Training:Dev split
 * is near 3:1. Counts come from the source files, never a number written here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

import { caseToConversation, migrateAll, problems, setFiles } from "../bench/setsMigrate.mjs";
import { parseTest } from "../bench/load.mjs";
import sets from "../../../packages/shared/src/texSets.cjs";
import decide from "../../../packages/shared/src/textDecide.cjs";

const repo = new URL("../../../", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url).pathname;
const config = JSON.parse(readFileSync(new URL("packages/shared/src/texConfig.json", repo), "utf8"));
const bench = new URL("apps/mcp/bench/", repo);
const run = promisify(execFile);

const convs = await migrateAll(repoRoot);

/** Source counts, read from the files the cases come from. */
function sourceCounts() {
  const respond = JSON.parse(readFileSync(new URL("respond/cases.json", bench), "utf8")).cases.length;
  let review = 0;
  for (const f of readdirSync(new URL("review/", bench)).filter((x) => x.endsWith(".json"))) {
    review += JSON.parse(readFileSync(new URL(`review/${f}`, bench), "utf8")).cases.length;
  }
  const jobcheck = JSON.parse(readFileSync(new URL("advisor/job-check.json", bench), "utf8")).cases.length;
  const core = ["core", "simple-asks"].reduce(
    (n, t) => n + parseTest(readFileSync(new URL(`ai/tests/${t}.md`, bench), "utf8")).questions.length,
    0,
  );
  return { respond, review, jobcheck, core };
}

const countFrom = (prefix) => convs.filter((c) => c.from.startsWith(prefix)).length;

test("every migrated conversation passes the contract", () => {
  assert.deepEqual(problems(convs, config), []);
  for (const c of convs) assert.deepEqual(sets.check(c, config, { why: Object.keys(decide.WHY) }), []);
});

test("ids are unique and every conversation has a set", () => {
  const ids = convs.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of convs) assert.ok(["training", "dev"].includes(c.set), c.id);
});

test("each source case appears exactly once, counted from the source files", () => {
  const n = sourceCounts();
  assert.equal(countFrom("respond/"), n.respond);
  assert.equal(countFrom("review/"), n.review);
  assert.equal(countFrom("advisor/job-check/"), n.jobcheck);
  assert.equal(countFrom("core/"), n.core);
  const froms = convs.map((c) => c.from);
  assert.equal(new Set(froms).size, froms.length);
  assert.equal(convs.length, n.respond + n.review + n.jobcheck + n.core);
});

test("respond reply maps to respond and hush to quiet", () => {
  const reply = caseToConversation("respond", { id: "a", chat: "one", lines: [], text: "@jo: hi there", want: "reply" });
  const hush = caseToConversation("respond", { id: "b", chat: "one", lines: [], text: "@jo: haha", want: "hush" });
  assert.equal(reply.msgs.at(-1).labels.decide.act, "respond");
  assert.equal(hush.msgs.at(-1).labels.decide.act, "quiet");
  assert.equal(hush.msgs.at(-1).labels.decide.also_react, "any");
});

test("a review fault maps to sentBack 1, and a clean review keeps Tex's reply", () => {
  const base = { id: "c", q: "is it done?", earlier: [], did: [], reply: "Yes, it's done." };
  const faulty = caseToConversation("review", { ...base, gate: "chat", fault: true });
  const clean = caseToConversation("review", { ...base, gate: "chat", fault: false });
  const labelled = (c) => c.msgs.find((m) => m.labels?.reviewer);
  assert.equal(labelled(faulty).labels.reviewer.sentBack, "1");
  assert.equal(faulty.msgs.some((m) => m.tex), false);
  assert.equal(labelled(clean).labels.reviewer.sentBack, "0");
  assert.equal(clean.msgs.at(-1).tex, true);
});

test("caseToConversation ignores a cause field", () => {
  const kase = { id: "d", chat: "group", lines: ["@ana: hi"], text: "@ana: Tex?", want: "reply" };
  const plain = caseToConversation("respond", kase);
  const caused = caseToConversation("respond", { ...kase, cause: "a question that names Tex is for Tex", fixed: "x" });
  assert.deepEqual(caused, plain);
});

test("the Training:Dev star split is near 3:1", () => {
  const stars = { training: 0, dev: 0 };
  for (const c of convs) stars[c.set] += sets.unitTests(c).length;
  const total = stars.training + stars.dev;
  const devShare = (stars.dev * 100) / total;
  assert.ok(devShare >= 15 && devShare <= 35, `dev share ${devShare}`);
  assert.ok(Math.abs(devShare - 25) <= 10, `dev share ${devShare} is more than ten points from 25`);
});

test("--check agrees with the files that --write produces", async () => {
  const files = setFiles(repoRoot, convs);
  for (const [path, text] of files) assert.equal(readFileSync(path, "utf8"), text, path);
  const script = new URL("apps/mcp/bench/setsMigrate.mjs", repo).pathname;
  const { stdout } = await run(process.execPath, [script, "--check"]);
  assert.match(stdout, /up to date/);
});
