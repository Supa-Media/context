import assert from "node:assert/strict";
import test from "node:test";

import workerPolicy from "../apps/mobile/e2e/webkit/ci-workers.cjs";

test("CI uses four browser workers", () => {
  assert.equal(workerPolicy.workersFor({ CI: "true" }), 4);
});

test("local runs retain Playwright's machine-dependent default", () => {
  assert.equal(workerPolicy.workersFor({}), undefined);
});
