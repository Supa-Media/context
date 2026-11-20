#!/usr/bin/env node
// Tex's test conversations, checked in CI (contract: packages/tex/src/texSets.cjs; plan: tex-sets/plan.md).
//
//   node scripts/tex-sets-check.mjs              problems in the repo's conversations, then the 60/20/20 ratio
//   node scripts/tex-sets-check.mjs --self-test  a tiny built-in check of the checker itself
//
// Exits 1 on any problem. The ratio is only reported: 60/20/20 is a target, never a gate (Dev2, 2026-11-17: "no need to
// enforce the 60 20 20, thats just the target"). With TEX_EVAL_COUNTS_URL set, the Test Set's star count
// comes from that URL (JSON { stars: n }); while it is 0 (nobody has written the Test Set yet) or cannot be read, the ratio falls back to Training against Dev and
// CI is not failed for an unreachable eval service. Prints counts and ids only, never message text.
// The split is one pooled ratio over every scope; per scope there is only a warning, never a failure, when a scope has
// Training or Dev unit tests and none in the Test Set (Dev2, 2026-11-17), from the service's public byNode count.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { loadSets, loadContract, problemsOf, ratioCheck } = await import(
  pathToFileURL(path.join(ROOT, "apps/mcp/bench/sets.mjs")).href
);
const { missingTest } = createRequire(import.meta.url)(path.join(ROOT, "packages/tex/src/texSets.cjs"));


const TIMEOUT_MS = 10_000;

async function fetchCounts(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.stars !== "number" || !Number.isFinite(body.stars) || body.stars < 0) {
    throw new Error("no stars count in the reply");
  }
  const byNode = body.byNode && typeof body.byNode === "object" ? body.byNode : null;
  return { stars: body.stars, byNode };
}

function selfTest() {
  const conv = (id, set, stars) => ({
    id, set, kind: "one", members: ["A"],
    msgs: Array.from({ length: stars }, (_, i) => ({ id: `m${i + 1}`, who: "A", text: "hi", labels: { fd: { must: ["x"], star: true } } })),
  });
  const fails = [];
  if (ratioCheck([conv("a", "training", 6), conv("b", "dev", 2)]).holds !== true) fails.push("6/2 should hold");
  if (ratioCheck([conv("a", "training", 2), conv("b", "dev", 6)]).holds !== false) fails.push("2/6 should fail");
  if (ratioCheck([conv("a", "training", 6), conv("b", "dev", 2)], 2).holds !== true) fails.push("6/2/2 should hold");
  if (problemsOf([conv("a", "test", 1)], { config: { nodes: [] }, why: [] }).length === 0) fails.push("a test set should be flagged");
  if (missingTest([conv("a", "training", 1)], {}).length !== 1) fails.push("a scope with no Test cases should be named");
  if (missingTest([conv("a", "training", 1)], null).length !== 0) fails.push("unknown Test counts should name nothing");
  if (fails.length) {
    console.error(`self-test failed: ${fails.join("; ")}`);
    process.exit(1);
  }
  console.log("self-test ok");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  let convs;
  try {
    convs = await loadSets();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { config, why } = loadContract();
  const problems = problemsOf(convs, { config, why });
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`${problems.length} problem(s) in ${convs.length} conversation(s)`);
    process.exit(1);
  }
  console.log(`${convs.length} conversations are sound`);

  let testStars = null;
  let testByNode = null;
  const url = process.env.TEX_EVAL_COUNTS_URL;
  if (url) {
    try {
      const counts = await fetchCounts(url);
      testStars = counts.stars;
      testByNode = counts.byNode;
      if (testStars === 0) {
        console.warn("the Test Set has no unit tests yet");
        testStars = null;
      }
    } catch (e) {
      console.warn(`warning: the Test Set's counts could not be read (${e.message}); checking Training against Dev only`);
    }
  }
  const r = ratioCheck(convs, testStars);
  console.log(r.line);
  // The ratio is a target, reported and never enforced (Dev2, 2026-11-17).
  if (!r.holds) console.warn("note: the 60/20/20 target is not met; it is reported, never a CI failure");
  // Per scope, a warning only (Dev2, 2026-11-17): GitHub shows it on the run, and the exit code never changes for it.
  for (const s of missingTest(convs, testByNode)) {
    const line = `scope ${s.scope} has ${s.training + s.dev} unit test(s) (Training ${s.training}, Dev ${s.dev}) and none in the Test Set`;
    console.warn(process.env.GITHUB_ACTIONS ? `::warning title=Tex test sets::${line} (a warning, never a failure)` : `warning: ${line} (a warning, never a failure)`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
