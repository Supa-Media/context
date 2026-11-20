/**
 * The migration of today's Tex bench cases into conversations (`apps/mcp/bench/setsMigrate.mjs`): every migrated
 * conversation passes the contract, each source case comes out once, the mappings hold, and each sits whole inside one
 * of the repo's long conversations. Counts come from the source files, never a number written here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

import { caseToConversation, migrateAll, placesOf, problems } from "../bench/setsMigrate.mjs";
import { loadSets } from "../bench/sets.mjs";
import { parseTest } from "../bench/load.mjs";
import sets from "../../../packages/shared/src/texSets.cjs";
import decide from "../../../packages/shared/src/textDecide.cjs";
import { readTexConfig, withRetiredSteps } from "../../../scripts/lib/texConfigFile.mjs";

const repo = new URL("../../../", import.meta.url);
const repoRoot = new URL("../../..", import.meta.url).pathname;
const config = withRetiredSteps(readTexConfig()); // migrated cases still label the Reply reviewer and the Job check, retired to the shelf 2026-11-20
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
  for (const c of convs) assert.deepEqual(sets.check(c, config, { why: Object.keys(decide.WHY), bench: false }), []);
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

test("a migrated case a conversation names sits whole inside it; one none names is retired, not a problem", async () => {
  const repoConvs = await loadSets();
  // 13: redo-the-draft (2026-11-19, a Training conversation for a draft asked again) joined the twelve.
  assert.ok(repoConvs.length <= 13, `about ten long conversations, not ${repoConvs.length}`);
  assert.deepEqual(placesOf(convs, repoConvs), []);
  // A conversation that names a case holds it whole: built from the case itself, then broken.
  const kase = convs.find((c) => c.msgs.some((m) => m.labels && Object.keys(m.labels).length));
  const home = { ...structuredClone(kase), id: "home", from: [kase.id] };
  assert.deepEqual(placesOf([kase], [home]), []);
  // Sabotage: a label changed inside its conversation is caught.
  const broken = structuredClone(home);
  const labelled = broken.msgs.find((m) => m.labels && Object.keys(m.labels).length);
  const node = Object.keys(labelled.labels)[0];
  labelled.labels[node] = { ...labelled.labels[node], must: ["something else"] };
  assert.ok(placesOf([kase], [broken]).length > 0, "a changed label is found");
  assert.match(placesOf([kase], [home, { ...home, id: "twice" }])[0], /named by 2 conversations/);
  // The Lab writes a conversation back with its keys in its own order (2026-11-16); that is the same label.
  const reordered = structuredClone(home);
  for (const m of reordered.msgs) {
    for (const [n, label] of Object.entries(m.labels ?? {})) m.labels[n] = Object.fromEntries(Object.entries(label).reverse());
  }
  assert.deepEqual(placesOf([kase], [reordered]), []);
});

test("--check reports the cases the repo's conversations name", async () => {
  const script = new URL("apps/mcp/bench/setsMigrate.mjs", repo).pathname;
  const { stdout } = await run(process.execPath, [script, "--check"]);
  assert.match(stdout, /cases are named by the repo's conversations, and each named one is inside its conversation/);
});
