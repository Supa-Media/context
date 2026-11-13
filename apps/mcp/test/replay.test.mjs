/**
 * THE REPLAY GATE, PLUMBING HALF (Dev2, 2026-11-13; docs/decisions/testing/replay-gate.md).
 *
 * Every case in test/replay/cases/ is a chat that once went wrong, rewritten
 * with invented people, run through the real `/agent` pipeline with a scripted
 * model. It runs on every pull request with the gateway's tests, costs
 * nothing, and a failing case blocks the merge like any other test.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  - `warmCopy.js` `events` reading the copy's day instead of the ledger
 *    fails "sees-own-reply" and "after-deploy";
 *  - a new group's first turn with `startOnLedger` skipped did NOT fail an
 *    end-to-end case (a chat home needs a world this fixture lacks), so that
 *    case was dropped rather than kept as a check that cannot fail;
 *    `groupPageCopy.test.mjs` covers it.
 *  - `checkItMayRun` passing `moment: false` (a routine back on its own short
 *    list of last texts) fails "routine-sees-chat".
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "replay/cases");
const files = readdirSync(DIR).filter((name) => name.endsWith(".mjs")).sort();

test("the replay set has cases, each named for its file, with the incident and cause it guards", async () => {
  assert.ok(files.length >= 3, "the replay set is never empty");
  for (const file of files) {
    const { default: replay } = await import(pathToFileURL(join(DIR, file)));
    assert.equal(`${replay.id}.mjs`, file, `${file}: its id names its file`);
    for (const field of ["incident", "cause", "path"]) assert.ok(typeof replay[field] === "string" && replay[field].length > 3, `${file}: says its ${field}`);
    assert.equal(typeof replay.run, "function", `${file}: has a run`);
  }
});

for (const file of files) {
  test(`replay: ${file.replace(/\.mjs$/, "")}`, async () => {
    const { default: replay } = await import(pathToFileURL(join(DIR, file)));
    await replay.run();
  });
}
