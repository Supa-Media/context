#!/usr/bin/env node
/**
 * CI sends its own numbers to a workspace sheet (`docs/decisions/data-and-metrics.md`, "CI sends its own numbers").
 *
 * The Tex test set, the search test set and the capability list each end with counts a person would otherwise copy
 * into a note by hand. This turns them into rows and adds them, with one sheet key, to the one sheet the key was made
 * for (`docs/decisions/app-and-console/sheet-sources.md`): `POST https://context.lc/api/sheets/rows`, the key in the
 * Authorization header, never in the URL. The key is `METRICS_PUSH_KEY`, made in the app on that sheet and pasted into
 * the repository's secrets by a person; no model sees it.
 *
 * Counts only, never a word of a case: the same numbers the run already prints to its log.
 *
 *   node scripts/metric-rows.mjs test-set --verdict <verdict.json> --pr <n> --sha <sha>
 *   node scripts/metric-rows.mjs search   --verdict <verdict.json> --pr <n> --sha <sha>
 *   node scripts/metric-rows.mjs capabilities --sha <sha>
 *   node scripts/metric-rows.mjs bench    --result <result.json> --sha <sha>
 *   node scripts/metric-rows.mjs --self-test
 *
 * Add `--dry-run` to print the rows instead of sending them. With no key set it says so and sends nothing; a refusal
 * or a network failure exits 1, so the step shows red, and the workflow step is `continue-on-error` so a gate never
 * fails for it.
 *
 * The sheet's columns: `date:date,check,part,value:number,of:number,main:number,pr,sha`.
 *   check `test-set`: part `all`, `kind:one`, `kind:group` and `node:<id>`; value right on the change, of the total,
 *     main right on main.
 *   check `search`: part `first` (right note first) and `top5`; value on the change, of the total, main on main.
 *   check `bench:<id>`: a Lab search run on main's code (`.github/workflows/lab-eval-run.yml`), such as
 *     `bench:enterprise-rag-notes`: part `first` and `top5`; value right, of the cases scored, main the same as value
 *     (the run is main's).
 *   check `capabilities`: part `covered` (value capabilities a replay case exercises, of all capabilities) and `cant`
 *     (value the `cant` entries left, the Parity gaps).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENDPOINT = "https://context.lc/api/sheets/rows";
/** The sheet route's own cap is 100 rows a call (`apps/convex/functions/lib/sheetSourceRoute.ts`). */
const BATCH = 100;

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const base = (meta, check, part) => ({ date: meta.date, check, part, pr: meta.pr ?? "", sha: meta.sha ?? "" });
const score = (meta, check, part, s) => ({ ...base(meta, check, part), value: num(s?.right), of: num(s?.total), main: num(s?.main) });

/** A Tex test set verdict (`infra/tex-eval/src/rules.ts` `verdict`) as rows. */
export function testSetRows(verdict, meta) {
  const rows = [score(meta, "test-set", "all", verdict)];
  for (const [kind, s] of Object.entries(verdict?.byKind ?? {}).sort()) rows.push(score(meta, "test-set", `kind:${kind}`, s));
  for (const [node, s] of Object.entries(verdict?.byNode ?? {}).sort()) rows.push(score(meta, "test-set", `node:${node}`, s));
  return rows;
}

/** A search test set verdict (`infra/tex-eval/src/searchRules.ts` `searchVerdict`) as rows. */
export function searchRows(verdict, meta) {
  return [
    { ...base(meta, "search", "first"), value: num(verdict?.first), of: num(verdict?.total), main: num(verdict?.mainFirst) },
    { ...base(meta, "search", "top5"), value: num(verdict?.top5), of: num(verdict?.total), main: num(verdict?.mainTop5) },
  ];
}

/** A benchmark id as the Lab names it (`packages/bench/benchmarks.generated.json`); anything else sends nothing. */
const BENCH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A Lab search run's result (`apps/mcp/bench/evals/searchCli.mjs`, run on main) as rows; [] when it isn't one. */
export function benchRows(result, meta) {
  const id = typeof result?.bench === "string" ? result.bench : "";
  const s = result?.search;
  if (!BENCH_ID.test(id) || !s || !(num(s.n) > 0)) return [];
  const check = `bench:${id}`;
  return [
    { ...base(meta, check, "first"), value: num(s.first), of: num(s.n), main: num(s.first) },
    { ...base(meta, check, "top5"), value: num(s.top5), of: num(s.n), main: num(s.top5) },
  ];
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a replay case exercises one of a capability's actions: it names `<tool>.<action>`, `<tool> action
 * <action>`, `ACTIONS.<tool>.<action>` or `action: "<action>"`. A capability with no actions of its own (a way of
 * talking, a surface) is covered only when a case names it in `capabilities: [...]`.
 */
export function coveredBy(capability, caseText) {
  if (new RegExp(`capabilities:\\s*\\[[^\\]]*["']${escape(capability.name)}["']`).test(caseText)) return true;
  return (capability.actions ?? []).some((full) => {
    const [tool, action] = full.split(".");
    if (!tool || !action) return false;
    const a = escape(action);
    return new RegExp(`\\b${tool}\\.${a}\\b|\\b${tool} action ${a}\\b|ACTIONS\\.${tool}\\.${a}\\b|action: ["']${a}["']`).test(caseText);
  });
}

/** Capability coverage and the Parity gaps, from the capability list and the replay cases. */
export function capabilityRows(capabilities, caseText, meta) {
  const covered = capabilities.filter((c) => coveredBy(c, caseText)).length;
  const cant = capabilities.reduce((n, c) => n + (Array.isArray(c.cant) ? c.cant.length : 0), 0);
  return [
    { ...base(meta, "capabilities", "covered"), value: covered, of: capabilities.length, main: "" },
    { ...base(meta, "capabilities", "cant"), value: cant, of: "", main: "" },
  ];
}

async function readCapabilities() {
  const { CAPABILITIES } = await import(pathToFileURL(join(ROOT, "packages/tex/gateway/agent/capabilities.js")).href);
  const dir = join(ROOT, "apps/mcp/test/replay/cases");
  const caseText = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  return { capabilities: CAPABILITIES, caseText };
}

/** Sends rows with the key; → `{ sent, said }`. Never prints the key. */
export async function send(rows, { key, fetchImpl = fetch, endpoint = ENDPOINT }) {
  if (!key) return { sent: 0, said: "METRICS_PUSH_KEY is not set, so no rows were sent. Make a key on the sheet in the app and add it to the repository's secrets." };
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ rows: rows.slice(i, i + BATCH) }),
    });
    if (!res.ok) return { sent, said: `The sheet refused the rows (HTTP ${res.status}).`, failed: true };
    sent += Math.min(BATCH, rows.length - i);
  }
  return { sent, said: `Sent ${sent} rows.` };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  const sub = argv[0];
  const meta = { date: new Date().toISOString(), pr: arg(argv, "pr") ?? "", sha: arg(argv, "sha") ?? "" };
  let rows;
  if (sub === "test-set" || sub === "search") {
    const verdict = JSON.parse(readFileSync(arg(argv, "verdict"), "utf8"));
    rows = sub === "test-set" ? testSetRows(verdict, meta) : searchRows(verdict, meta);
  } else if (sub === "bench") {
    rows = benchRows(JSON.parse(readFileSync(arg(argv, "result"), "utf8")), meta);
    if (rows.length === 0) {
      console.log("Not a search run with scored cases, so no rows were sent.");
      return 0;
    }
  } else if (sub === "capabilities") {
    const { capabilities, caseText } = await readCapabilities();
    rows = capabilityRows(capabilities, caseText, meta);
  } else {
    throw new Error("usage: metric-rows.mjs test-set|search --verdict <file> --pr <n> --sha <sha> | bench --result <file> --sha <sha> | capabilities --sha <sha> [--dry-run]");
  }
  if (argv.includes("--dry-run")) {
    for (const row of rows) console.log(JSON.stringify(row));
    return 0;
  }
  const out = await send(rows, { key: process.env.METRICS_PUSH_KEY });
  console.log(out.said);
  return out.failed ? 1 : 0;
}

async function selfTest() {
  let failed = 0;
  const ok = (name, good) => {
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
    if (!good) failed += 1;
  };
  const meta = { date: "2026-11-25T06:00:00.000Z", pr: "12", sha: "abc" };
  const v = { pass: true, total: 4, right: 3, main: 2, byNode: { fd: { total: 1, right: 1, main: 0 }, decide: { total: 3, right: 2, main: 2 } }, byKind: { group: { total: 1, right: 0, main: 1 }, one: { total: 3, right: 3, main: 1 } } };
  const t = testSetRows(v, meta);
  ok("a test set run is one all row, then kinds, then nodes, sorted", t.map((r) => r.part).join(" ") === "all kind:group kind:one node:decide node:fd");
  ok("the all row carries right, total and main", t[0].value === 3 && t[0].of === 4 && t[0].main === 2 && t[0].check === "test-set");
  ok("a verdict from before kinds were counted still gives its all and node rows", testSetRows({ total: 1, right: 1, main: 1, byNode: { fd: { total: 1, right: 1, main: 1 } } }, meta).length === 2);
  ok("rows hold counts only: no field but the sheet's columns", t.every((r) => Object.keys(r).sort().join() === "check,date,main,of,part,pr,sha,value"));
  const s = searchRows({ pass: true, total: 10, first: 7, mainFirst: 6, top5: 9, mainTop5: 9 }, meta);
  ok("a search run is a first row and a top5 row against main", s[0].value === 7 && s[0].main === 6 && s[1].part === "top5" && s[1].value === 9);
  const b = benchRows({ bench: "enterprise-rag-notes", search: { n: 50, first: 29, top5: 41, firstPct: 58 }, rows: [{ query: "a case's words" }] }, meta);
  ok("a Lab search run is a first and a top5 row under bench:<id>", b.length === 2 && b[0].check === "bench:enterprise-rag-notes" && b[0].value === 29 && b[0].of === 50 && b[1].part === "top5" && b[1].value === 41);
  ok("a bench row carries counts only, never a case", !JSON.stringify(b).includes("words") && b.every((r) => Object.keys(r).sort().join() === "check,date,main,of,part,pr,sha,value"));
  ok("a memory run, an odd bench id or a run with nothing scored sends nothing", benchRows({ bench: "longmemeval-s", scores: { n: 10 } }, meta).length === 0 && benchRows({ bench: "Bad/../id", search: { n: 5, first: 1 } }, meta).length === 0 && benchRows({ bench: "x", search: { n: 0 } }, meta).length === 0);
  const caps = [
    { name: "Areas", actions: ["manage.area"] },
    { name: "Polls", actions: [] },
    { name: "Email", actions: ["send.email"], cant: [{ what: "x" }, { what: "y" }] },
    { name: "Notes", actions: ["write.save"] },
  ];
  const text = 'assert.equal(ACTIONS.manage.area?.tool, "set_area");\nexport default { capabilities: ["Polls"] };\n// sends an emailing note';
  const c = capabilityRows(caps, text, meta);
  ok("a capability counts when a case reaches one of its actions or names it", c[0].value === 2 && c[0].of === 4);
  ok("a word inside another word is not an action", !coveredBy(caps[2], "sendemail send.emails"));
  ok("the Parity gaps are the cant entries left", c[1].part === "cant" && c[1].value === 2);
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const none = await send(t, { key: "", fetchImpl: fake });
  ok("with no key nothing is sent, and it says how to fix it", none.sent === 0 && calls.length === 0 && /METRICS_PUSH_KEY/.test(none.said));
  const many = Array.from({ length: 150 }, () => t[0]);
  const sent = await send(many, { key: "ctxs_test", fetchImpl: fake });
  ok("rows go in batches of at most 100", sent.sent === 150 && calls.length === 2 && JSON.parse(calls[1].init.body).rows.length === 50);
  ok("the key goes in the Authorization header, never the URL", calls.every((x) => x.url === ENDPOINT && x.init.headers.authorization === "Bearer ctxs_test"));
  const refused = await send(t, { key: "ctxs_test", fetchImpl: async () => ({ ok: false, status: 401 }) });
  ok("a refusal fails the step and does not echo the key", refused.failed === true && !refused.said.includes("ctxs_test"));
  const real = await readCapabilities();
  const live = capabilityRows(real.capabilities, real.caseText, meta);
  ok("the real capability list and cases give a share between 0 and all", live[0].of > 0 && live[0].value >= 0 && live[0].value <= live[0].of);
  console.log(failed ? `\nself-test: ${failed} failed.` : "\nself-test: all cases behave as stated.");
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  (argv.includes("--self-test") ? selfTest() : main(argv)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
