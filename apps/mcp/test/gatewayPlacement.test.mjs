// The gateway runs beside its workspace objects (placed `enam`), not at the caller's edge (decided by the owner,
// 2026-11-04; docs/decisions/gateway-protocol/gateway-placement.md). Every read makes several dependent object trips,
// 25 to 60 ms each from the edge. Dropping the block would put all of them back without failing anything else.
// Sabotage: the `[placement]` block removed from wrangler.toml → this test fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TOML = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

test("the gateway is placed in the eastern US region its workspace objects live in, before any environment", () => {
  const top = TOML.split(/^\[env\./m)[0];
  const block = top.match(/^\[placement\]\n((?:[^[\n].*\n|\n)*)/m);
  assert.ok(block, "no top-level [placement] block in wrangler.toml");
  assert.match(block[1], /^region = "aws:us-east-1"$/m);
  assert.doesNotMatch(TOML.split(/^\[env\./m).slice(1).join(""), /placement/, "an environment overrides the placement");
});
