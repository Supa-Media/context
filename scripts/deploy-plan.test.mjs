import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { baseCommits, buildGraph, isInert, selectComponents, TARGETS } from "./deploy-plan.mjs";

const graph = buildGraph();
const plan = (...files) => selectComponents(files, graph).selected;
const on = (selected) => Object.keys(selected).filter((name) => selected[name]).sort();
const ALL = Object.keys(TARGETS.staging.components).sort();

test("a CI-only merge deploys nothing (the PR #1057 reference case)", () => {
  assert.deepEqual(on(plan(".github/workflows/ci.yml", "scripts/check-ci-path-gates.mjs", "docs/testing.md")), []);
});

test("a router-only change deploys the router and not the app", () => {
  assert.deepEqual(on(plan("infra/router/src/route.ts")), ["router"]);
});

test("a mobile change deploys the app and its staging assets Worker", () => {
  assert.deepEqual(on(plan("apps/mobile/features/console/NoteEditor.tsx")), ["app", "router"]);
});

test("a shared package fans out to every consumer", () => {
  assert.deepEqual(on(plan("packages/shared/src/storageLayout.cjs")), ["app", "convex", "email", "mcp", "router"]);
  assert.deepEqual(on(plan("packages/collaboration/src/index.js")), ["app", "convex", "mcp", "router"]);
});

test("a gateway file the app and Convex import by relative path deploys them too", () => {
  assert.deepEqual(on(plan("apps/mcp/src/lists.js")), ["app", "convex", "mcp", "router"]);
});

test("a gateway file nobody else imports deploys only the gateway", () => {
  const onlyGateway = [...graph.mcp.files].find(
    (file) => file.startsWith("apps/mcp/src/") && !graph.convex.files.has(file) && !graph.app.files.has(file) && !graph.email.files.has(file),
  );
  assert.ok(onlyGateway, "expected at least one gateway-only source file");
  assert.deepEqual(on(plan(onlyGateway)), ["mcp"]);
});

test("the texting assistant deploys only itself, and only to staging", () => {
  assert.deepEqual(on(plan("apps/agent/src/index.ts")), ["agent"]);
  assert.deepEqual(on(plan("apps/agent/wrangler.jsonc")), ["agent"]);
  assert.deepEqual(on(plan("apps/agent/src/worker.test.ts")), []);
  assert.deepEqual(promote("apps/agent/src/index.ts"), []);
});

test("tests and READMEs inside a package do not deploy it", () => {
  assert.deepEqual(on(plan("apps/mcp/test/test.mjs", "apps/mobile/__tests__/formBlock.test.ts", "infra/router/README.md")), []);
  assert.deepEqual(on(plan("apps/mobile/e2e/webkit/panels.spec.ts")), []);
  assert.equal(isInert("apps/mobile/features/e2e/fixture.tsx"), false, "the app's runtime E2E route is bundled");
});

test("dependencies, the workflow and this planner deploy everything", () => {
  for (const file of ["pnpm-lock.yaml", "package.json", "patches/x.patch", ".github/workflows/deploy-staging.yml", "scripts/deploy-plan.mjs"]) {
    assert.deepEqual(on(plan(file)), ALL, file);
  }
});

test("an unrecognised file deploys everything", () => {
  assert.deepEqual(on(plan("supa.config.ts")), ALL);
  assert.deepEqual(on(plan("some-new-dir/thing.js")), ALL);
});

test("a full request deploys everything with no changes", () => {
  assert.deepEqual(on(selectComponents([], graph, { full: true }).selected), ALL);
});

test("files Convex bundles out of the gateway select Convex", () => {
  // Named by check-convex-deploy-paths.mjs as trees an old hand-kept list missed.
  for (const file of ["apps/mcp/src/forms.js", "apps/mcp/src/storageLayout.js"]) {
    assert.ok(plan(file).convex, file);
  }
});

test("every Worker the staging workflow deploys is a component", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
  for (const [name, component] of Object.entries(TARGETS.staging.components)) {
    if (!component.worker) continue;
    if (name === "router") {
      assert.match(workflow, /router:\n    name: Deploy router with web assets/);
      assert.ok(workflow.includes("needs.plan.outputs.app == 'true' || needs.plan.outputs.router == 'true'"));
    } else {
      assert.ok(workflow.includes(`${name})`), `deploy-staging.yml has no case for ${name}`);
    }
  }
});

test("the base is the newest success plus every run after it", () => {
  const run = (id, sha, conclusion, status = "completed") => ({ id, head_sha: sha, status, conclusion });
  assert.deepEqual(baseCommits([run(9, "c", null, "in_progress"), run(8, "b", "failure"), run(7, "a", "success"), run(6, "z", "success")], 9), ["b", "a"]);
  assert.deepEqual(baseCommits([run(9, "c", null, "in_progress"), run(7, "a", "success")], 9), ["a"]);
  assert.equal(baseCommits([run(9, "c", null, "in_progress"), run(8, "b", "failure")], 9), null, "no success means a full deploy");
  assert.equal(baseCommits([run(10, "d", "success"), run(9, "c", null, "in_progress")], 9), null, "a rerun of an old run deploys everything");
  assert.equal(baseCommits([run(9, "c", null, "in_progress"), run(8, "b", null, "queued"), run(7, "a", "success")], 9), null);
});

const production = buildGraph("production");
const promote = (...files) => on(selectComponents(files, production, { target: "production" }).selected);

test("production selects the same way, per reusable workflow", () => {
  assert.deepEqual(promote("docs/staging.md", ".github/workflows/ci.yml"), []);
  assert.deepEqual(promote("infra/router/src/route.ts"), ["router", "web"]);
  assert.deepEqual(promote("apps/mobile/features/console/NoteEditor.tsx"), ["ota", "router", "web"]);
  assert.deepEqual(promote("infra/sentry-worker/src/index.js"), ["sentry"]);
  assert.deepEqual(promote("apps/mcp/src/lists.js"), ["convex", "gateway", "ota", "router", "web"]);
});

test("a production component's own workflow redeploys it", () => {
  assert.deepEqual(promote(".github/workflows/deploy-mcp.yml"), ["gateway"]);
  assert.deepEqual(promote(".github/workflows/deploy-mobile-update.yml"), ["ota"]);
  assert.deepEqual(promote(".github/workflows/build-web.yml"), ["router", "web"]);
  assert.deepEqual(promote(".github/workflows/deploy-router.yml"), ["router", "web"]);
  const all = Object.keys(TARGETS.production.components).sort();
  assert.deepEqual(promote(".github/workflows/deploy-production.yml"), all);
  assert.deepEqual(promote("pnpm-lock.yaml"), all);
});

test("every component the production workflow calls is gated by its plan output", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
  for (const name of Object.keys(TARGETS.production.components)) {
    assert.ok(workflow.includes(`needs.validate.outputs.${name} == 'true'`), `deploy-production.yml does not gate ${name}`);
  }
});
