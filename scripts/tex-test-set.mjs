#!/usr/bin/env node
/**
 * The Test Set's side of main's two sealed workflows (docs/decisions/testing/test-set-service.md):
 * `.github/workflows/tex-test-set.yml` (the gate) and `tex-test-set-seed.yml` (the held-out cases moved in).
 *
 * Every call to the eval service carries a GitHub Actions OIDC token for audience `context-tex-eval`, asked for here
 * from the job's own token endpoint; the service checks that it names the workflow on main. Nothing a conversation
 * says is printed: the conversations and the answers are written to files only this job's user can read, and this
 * prints counts.
 *
 *   node scripts/tex-test-set.mjs start  --pr <n> --sha <head> --base <main sha> [--change <patch-id>] --dir <sealed dir>
 *       writes <dir>/conversations.json and <dir>/run; exit 3 when the caps refuse, with their sentence
 *   node scripts/tex-test-set.mjs repeat-needed --dir <sealed dir>
 *       prints `yes` when a node's first answers score below main's (worseNodes), else `no`; nothing else
 *   node scripts/tex-test-set.mjs finish --dir <sealed dir>
 *       sends <dir>/branch.json and <dir>/main.json, or the three attempts (branch.2/3.json, main.2/3.json) when a
 *       second attempt exists; writes <dir>/verdict.json; exit 0 on a pass, 1 on a fail
 *   node scripts/tex-test-set.mjs seed   --held <held-out dir> --out <file>
 *       the held-out cases as Test conversations, sent to the seed door; writes what was kept to <file>
 *   node scripts/tex-test-set.mjs --self-test
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUDIENCE = "context-tex-eval";
const GATEWAY = process.env.TEX_EVAL_ORIGIN || "https://mcp.context.lc";

const arg = (name, argv = process.argv) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : undefined;
};
/** A JSON file in the sealed folder, or [] when it is missing or unreadable. */
const readJson = (dir, name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return [];
  }
};
const sealed = (path, value) => {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** The job's OIDC token for the eval service (needs `permissions: id-token: write`). */
async function oidcToken(env = process.env, get = fetch) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = env;
  if (!url || !bearer) throw new Error("no OIDC token here: the job needs `permissions: id-token: write`");
  const res = await get(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub gave no OIDC token (${res.status})`);
  const { value } = await res.json();
  return value;
}

async function call(path, body, { token, get = fetch } = {}) {
  const res = await get(`${GATEWAY}/tex-eval${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  return { status: res.status, answer };
}

/** Unit tests a list of conversations holds, by node: counts only. */
export function starsByNode(conversations) {
  const byNode = {};
  for (const c of conversations) for (const m of c.msgs ?? []) {
    if (!m || m.tex) continue;
    for (const [node, l] of Object.entries(m.labels ?? {})) if (l?.star === true) byNode[node] = (byNode[node] ?? 0) + 1;
  }
  return byNode;
}

/**
 * The nodes the change answers right fewer times than main, over the unit tests a list of conversations holds.
 * `branch` and `main` are Result[] rows ({chat, msg, node, right}); a test counts for a side when a row for it says right.
 */
export function worseNodes(conversations, branch, main) {
  const tests = [];
  for (const c of Array.isArray(conversations) ? conversations : []) for (const m of c?.msgs ?? []) {
    if (!m || m.tex) continue;
    for (const [node, l] of Object.entries(m.labels ?? {})) if (l?.star === true) tests.push({ chat: c.id, msg: m.id, node });
  }
  const rightBy = (rows) => {
    const passed = new Set((Array.isArray(rows) ? rows : []).filter((r) => r?.right === true).map((r) => JSON.stringify([r.chat, r.msg, r.node])));
    const counts = {};
    for (const t of tests) if (passed.has(JSON.stringify([t.chat, t.msg, t.node]))) counts[t.node] = (counts[t.node] ?? 0) + 1;
    return counts;
  };
  const onChange = rightBy(branch);
  const onMain = rightBy(main);
  return Object.keys(onMain).filter((node) => (onChange[node] ?? 0) < onMain[node]).sort();
}

/** A node is worse when the service says so; an old verdict without the flag compares its counts. */
const isWorse = (s) => s.worse ?? s.right < s.main;

/** The verdict as lines a log may carry: counts by node, never a word. */
export function verdictLines(v) {
  const mean = v.attempts > 1 ? ` (mean of ${v.attempts} attempts)` : "";
  const lines = [`Test Set: ${v.right}/${v.total} right on the change, ${v.main}/${v.total} on main: ${v.pass ? "PASS" : "FAIL"}${mean}`];
  for (const [node, s] of Object.entries(v.byNode ?? {}).sort()) lines.push(`- ${node}: ${s.right}/${s.total} (main ${s.main}/${s.total})${isWorse(s) ? "  <- fewer right than main" : ""}`);
  return lines;
}

/** The status description GitHub shows (140 characters at most). */
export function statusLine(v) {
  if (v.total === 0) return "The Test Set has no unit tests yet: nothing to gate on";
  const worse = Object.entries(v.byNode ?? {}).filter(([, s]) => isWorse(s)).map(([n]) => n);
  const runs = v.attempts > 1 ? ` (${v.attempts} runs)` : "";
  const text = v.pass ? `Test Set${runs} ${v.right}/${v.total} right, main ${v.main}/${v.total}: no step worse` : `Test Set${runs} ${v.right}/${v.total}, main ${v.main}/${v.total}; worse on ${worse.join(", ")}`;
  return text.slice(0, 140);
}

/** A held-out case as a Test conversation, through the Store thread's converter. */
export function heldToConversation(caseToConversation, area, kase) {
  const c = caseToConversation(area, kase);
  const id = `held-${area}-${String(kase.id ?? c.id)}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return { ...c, id, set: "test", title: c.title ?? id };
}

async function main() {
  const sub = process.argv[2];
  if (sub === "start") {
    const dir = arg("dir");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { status, answer } = await call("/v1/runs", { pr: Number(arg("pr")), sha: arg("sha"), base: arg("base"), ...(arg("change") ? { change: arg("change") } : {}) }, { token: await oidcToken() });
    if (status === 429) {
      sealed(join(dir, "refused"), String(answer?.error ?? "capped"));
      console.log(`The Test Set did not run: ${answer?.error ?? "capped"}.`);
      process.exit(3);
    }
    if (status !== 200 || !answer?.run) throw new Error(`the eval service answered ${status}: ${answer?.error ?? "no run"}`);
    sealed(join(dir, "conversations.json"), answer.conversations);
    sealed(join(dir, "run"), answer.run);
    const byNode = starsByNode(answer.conversations);
    console.log(`Test Set handed over: ${answer.conversations.length} conversations, ${Object.values(byNode).reduce((a, n) => a + n, 0)} unit tests (${Object.entries(byNode).map(([n, k]) => `${n} ${k}`).join(", ") || "none"}).`);
    return;
  }
  if (sub === "repeat-needed") {
    const dir = arg("dir");
    const worse = worseNodes(readJson(dir, "conversations.json"), readJson(dir, "branch.json"), readJson(dir, "main.json"));
    console.log(worse.length > 0 ? "yes" : "no");
    return;
  }
  if (sub === "finish") {
    const dir = arg("dir");
    // Attempts 2 and 3 exist only when the workflow repeated the answers; then each tree sends all three, [] when missing.
    const repeated = existsSync(join(dir, "branch.2.json")) || existsSync(join(dir, "main.2.json"));
    const attempts = (tree) => (repeated ? [readJson(dir, `${tree}.json`), readJson(dir, `${tree}.2.json`), readJson(dir, `${tree}.3.json`)] : readJson(dir, `${tree}.json`));
    if (repeated) console.log("Answered 3 times on each tree.");
    const run = readFileSync(join(dir, "run"), "utf8").trim();
    const { status, answer } = await call("/v1/runs/result", { run, branch: attempts("branch"), main: attempts("main") }, { token: await oidcToken() });
    if (status !== 200 || !answer?.verdict) throw new Error(`the eval service answered ${status}: ${answer?.error ?? "no verdict"}`);
    // A service from before attempts would read three lists as no answers on either side and pass: never trust that.
    if (repeated && answer.verdict.attempts !== 3) throw new Error("the eval service did not score the three attempts; no verdict");
    writeFileSync(join(dir, "verdict.json"), JSON.stringify(answer.verdict));
    for (const line of verdictLines(answer.verdict)) console.log(line);
    process.exit(answer.verdict.pass ? 0 : 1);
  }
  if (sub === "seed") {
    const held = arg("held");
    const { caseToConversation } = await import("../apps/mcp/bench/setsMigrate.mjs");
    const conversations = [];
    for (const file of readdirSync(held).filter((f) => f.endsWith(".json"))) {
      const area = file.slice(0, -5);
      const note = JSON.parse(readFileSync(join(held, file), "utf8"));
      const cases = note.cases ?? [];
      // A review case reads its file's `gate`, as the repo's review files carry it.
      for (const kase of cases) conversations.push(heldToConversation(caseToConversation, area, note.gate === undefined ? kase : { gate: note.gate, ...kase }));
      console.log(`${area}: ${cases.length} held-out cases`);
    }
    const { status, answer } = await call("/v1/seed", { conversations }, { token: await oidcToken() });
    if (status !== 200) throw new Error(`the eval service answered ${status}: ${answer?.error ?? ""}`);
    writeFileSync(arg("out"), JSON.stringify({ kept: answer.kept, skipped: answer.skipped.length }));
    console.log(`Seeded: ${answer.kept} kept, ${answer.skipped.length} not (already there or unsound). The Test Set now holds ${answer.counts.chats} conversations, ${answer.counts.stars} unit tests.`);
    return;
  }
  throw new Error("usage: tex-test-set.mjs start|finish|seed (see the header)");
}

function selfTest() {
  let failed = 0;
  const ok = (name, good) => {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  };
  const v = { pass: false, total: 4, right: 2, main: 3, byNode: { decide: { total: 2, right: 2, main: 1 }, fd: { total: 2, right: 0, main: 2 } } };
  ok("the verdict lines carry counts by node and mark the worse one", verdictLines(v).join("\n").includes("- fd: 0/2 (main 2/2)  <- fewer right than main"));
  ok("the status names the step that got worse", statusLine(v) === "Test Set 2/4, main 3/4; worse on fd");
  ok("an empty Test Set says so", /no unit tests yet/.test(statusLine({ pass: true, total: 0, right: 0, main: 0, byNode: {} })));
  const conv = [{ id: "a", msgs: [{ id: "m", who: "Sam", text: "words", labels: { fd: { star: true }, decide: { act: "quiet" } } }, { id: "t", tex: true, labels: { fd: { star: true } } }] }];
  ok("stars are counted per node, never a Tex row or an unstarred label", JSON.stringify(starsByNode(conv)) === '{"fd":1}');
  const made = heldToConversation((area, k) => ({ id: k.id, set: "dev", msgs: [] }), "review", { id: "Tasks/Late Bill #2", cause: "x" });
  ok("a held-out case becomes a Test conversation with a sound id", made.set === "test" && made.id === "held-review-tasks-late-bill-2");
  const wc = [{ id: "c1", msgs: [{ id: "m1", labels: { fd: { star: true }, decide: { star: true } } }, { id: "m2", labels: { fd: { star: true } } }, { id: "t1", tex: true, labels: { fd: { star: true } } }] }];
  const row = (msg, node, right) => ({ chat: "c1", msg, node, right });
  const onMain = [row("m1", "fd", true), row("m1", "decide", false), row("m2", "fd", true)];
  const onChange = [row("m1", "fd", true), row("m1", "decide", true), row("m2", "fd", false)];
  ok("worse nodes are the ones the change answers right fewer times than main", JSON.stringify(worseNodes(wc, onChange, onMain)) === '["fd"]');
  ok("no worse nodes when the two trees answer alike", JSON.stringify(worseNodes(wc, onMain, onMain)) === "[]");
  ok("missing answers count as wrong, and a non-array is no answers", JSON.stringify(worseNodes(wc, null, onMain)) === '["fd"]');
  const pass3 = { pass: true, attempts: 3, total: 8, right: 7, main: 6, byNode: { reviewer: { total: 8, right: 5, main: 6, worse: false } } };
  ok("a node below main that the service does not mark worse neither fails the status nor marks the line", !statusLine(pass3).includes("worse on") && statusLine(pass3).includes("(3 runs)") && !verdictLines(pass3).join("\n").includes("<- fewer") && verdictLines(pass3)[0].includes("(mean of 3 attempts)"));
  const fail3 = { ...pass3, pass: false, byNode: { reviewer: { total: 8, right: 5, main: 6, worse: true } } };
  ok("a node the service marks worse is named and marked even when its mean is shown", statusLine(fail3).includes("worse on reviewer") && verdictLines(fail3).join("\n").includes("<- fewer right than main"));
  if (failed) process.exit(1);
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(2);
  });
}
