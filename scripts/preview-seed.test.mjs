import test from "node:test";
import assert from "node:assert/strict";

import { cliFailureReason, issuePersonaCode } from "./preview-seed.mjs";

test("a failed CLI run names its cause from stderr", () => {
  const reason = cliFailureReason(
    "noise\n✖ Error: Uncaught Error: staging personas are issued codes only on staging\n",
    1,
  );
  assert.match(reason, /staging personas/);
});

test("digit runs and preview deploy keys never reach the failure reason", () => {
  const reason = cliFailureReason("Error: bad key preview:team|abc123 for code 123456\n", 1);
  assert.doesNotMatch(reason, /123456/);
  assert.doesNotMatch(reason, /abc123/);
  assert.doesNotMatch(reason, /team\|abc123/);
  assert.match(reason, /preview:…/);
});

test("with no stderr the reason falls back to the exit status", () => {
  assert.equal(cliFailureReason("", 2), "exit 2");
});

test("a failed run throws with the redacted reason and never the stdout", () => {
  const run = () => ({
    status: 1,
    error: undefined,
    stdout: '{"code":"493817"}',
    stderr: "Error: Uncaught Error: not found for preview:team|abc123\n",
  });
  assert.throws(
    () => issuePersonaCode("alpha@supa.media", { deployment: "pr1-ctx", deployKey: "preview:team|abc123", run }),
    (error) => {
      assert.match(error.message, /^Issuing a preview code failed: /);
      assert.match(error.message, /not found/);
      assert.doesNotMatch(error.message, /493817/);
      assert.doesNotMatch(error.message, /abc123/);
      return true;
    },
  );
});
