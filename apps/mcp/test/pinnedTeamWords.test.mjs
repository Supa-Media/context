/**
 * WHAT AN AI IS TOLD `team` MEANS IN THE PINNED WORKSPACE (owner, 2026-10-19).
 *
 * `team` in `@context-lc` is its real members, as in every workspace; opening a note to every signed-in Context
 * account is the separate All Context users grant (docs/decisions/privacy-and-sharing/all-context-users.md). orient
 * says both beside the workspace's row, and the sharing judge is told "the team" there as anywhere.
 *
 * ## Sabotage record
 *
 *   `accessSentence` returning `reachSentence(entry)` for every name
 *     → "orient says what team means in @context-lc" fails
 *   `PINNED_TEAM_LINE` saying team notes reach every account again
 *     → "orient says what team means in @context-lc" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { accessSentence, PINNED_TEAM_LINE } from "../src/orient/access.js";
import { wideningOf } from "../src/privacy/widening.js";

const privacy = async () => ({ rules: [{ prefix: "", vis: "private" }], overrides: new Map() });

test("orient says what team means in @context-lc", () => {
  const said = accessSentence({ name: "@context-lc", role: "member", tier: "team", canWrite: false, grantWrites: true });
  assert.match(said, /team notes are its members' alone/);
  assert.match(said, /All Context users/);
  assert.doesNotMatch(said, /team notes are open to every/);
  assert.ok(said.endsWith(PINNED_TEAM_LINE));
});

test("any other workspace is described as it was", () => {
  const said = accessSentence({ name: "@acme", role: "member", tier: "team", canWrite: true });
  assert.equal(said, "you can read and write team notes there");
});

test("the judge is told the team, in @context-lc as anywhere", async () => {
  const args = { path: "2-areas/plan.md", visibility: "team" };
  const said = await wideningOf("set_visibility", args, { privacy });
  assert.equal(said?.summary, "make 2-areas/plan.md visible to the team");
});
