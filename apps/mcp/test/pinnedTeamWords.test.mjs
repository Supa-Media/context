/**
 * WHAT AN AI IS TOLD `team` MEANS IN THE PINNED WORKSPACE (owner, 2026-10-19).
 *
 * `@context-lc` is read by every signed-in Context account through the pin, at `team`
 * (docs/decisions/privacy-and-sharing/all-context-users.md). An agent shown "team notes" there, or a sharing judge
 * shown "make it visible to the team", would read that as the members' alone, which understates who can open it.
 * Every other workspace is described as it was.
 *
 * ## Sabotage record
 *
 *   `accessSentence` returning `reachSentence(entry)` for every name
 *     → "orient says what team reaches in @context-lc" fails
 *   `wideningOf` ignoring `teamIsEveryAccount`
 *     → "the judge is told every account" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { accessSentence, PINNED_TEAM_LINE } from "../src/orient/access.js";
import { wideningOf } from "../src/privacy/widening.js";

const privacy = async () => ({ rules: [{ prefix: "", vis: "private" }], overrides: new Map() });

test("orient says what team reaches in @context-lc", () => {
  const said = accessSentence({ name: "@context-lc", role: "member", tier: "team", canWrite: false, grantWrites: true });
  assert.match(said, /every signed-in Context account, not just its members/);
  assert.ok(said.endsWith(PINNED_TEAM_LINE));
});

test("any other workspace is described as it was", () => {
  const said = accessSentence({ name: "@acme", role: "member", tier: "team", canWrite: true });
  assert.equal(said, "you can read and write team notes there");
});

test("the judge is told every account in @context-lc, and the team elsewhere", async () => {
  const args = { path: "2-areas/plan.md", visibility: "team" };
  const pinned = await wideningOf("set_visibility", args, { privacy, teamIsEveryAccount: true });
  const ordinary = await wideningOf("set_visibility", args, { privacy });
  assert.equal(pinned?.summary, "make 2-areas/plan.md visible to every signed-in Context account");
  assert.equal(ordinary?.summary, "make 2-areas/plan.md visible to the team");
});
