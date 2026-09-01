/**
 * A DEFERRED PATCH THAT CANNOT BE APPLIED IS WORSE THAN NO PATCH.
 *
 * `docs/deferred/` holds work that was built, reviewed and deliberately held
 * back, so that whoever picks it up starts from what happened rather than
 * reconstructing it from memory. The README beside it says "apply it as a
 * starting point" — which is the sentence that gets trusted, and which is worth
 * nothing if `git apply` refuses.
 *
 * This is a guard rather than a habit because the habit failed twice, the
 * second time inside the commit that fixed the first:
 *
 * 1. `ac048af` wrote the patch and, in the same commit, rewrote the comments
 *    the patch takes as context. Three of its four files stopped applying.
 * 2. `db340b5` regenerated it — and then edited `apps/mcp/test/test.mjs` again,
 *    further down the same command, breaking it a second time. That version
 *    reached `main`.
 *
 * Both times the claim "regenerated and checked" was made in the commit
 * message. Neither time was it true afterwards. The check has to run after the
 * tree settles, which is what a test does and what a person doing it by hand
 * does not.
 *
 * **What runs this is `gateway-contracts.yml`, not `ci / Test Convex Backend`.**
 * That job is gated on a paths filter over `apps/convex/**`, so it is skipped on
 * exactly the `apps/mcp`-only pull request that broke this patch the second
 * time. `gateway-contracts.yml` has no `paths:` filter and runs the whole convex
 * suite on every pull request, which is what gives this guard its reach — worth
 * knowing before somebody adds a filter there.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const DEFERRED = join(ROOT, "docs", "deferred");

function gitApplyCheck(patch: string): { ok: boolean; message: string } {
  try {
    execFileSync("git", ["apply", "--check", patch], { cwd: ROOT, stdio: "pipe" });
    return { ok: true, message: "" };
  } catch (error) {
    const err = error as { stderr?: Buffer; message?: string };
    return { ok: false, message: err.stderr?.toString() || err.message || "unknown" };
  }
}

describe("every deferred patch still applies", () => {
  const patches = existsSync(DEFERRED)
    ? readdirSync(DEFERRED).filter((name) => name.endsWith(".patch"))
    : [];

  test("there is at least one, so this file is not vacuously green", () => {
    // If the directory is emptied deliberately, delete this file with it.
    expect(patches.length).toBeGreaterThan(0);
  });

  for (const name of patches) {
    test(`${name} applies cleanly to the tree it ships in`, () => {
      const result = gitApplyCheck(join(DEFERRED, name));
      expect(result.ok, `git apply --check failed:\n${result.message}`).toBe(true);
    });
  }

  test("the check can actually see a patch that does not apply", () => {
    // The self-test, and the fixture has to be the real failure. A MISSING file
    // makes git exit 128 ("No such file or directory"); a patch that does not
    // apply exits 1 ("patch does not apply"). `gitApplyCheck` collapses both to
    // `ok: false`, so pointing this at a nonexistent path — which is what it
    // did first — proves only that the catch is wired, not that a broken patch
    // reaches it. That is the same "covers the thing next to what it claims"
    // shape this file exists to stop.
    const real = readFileSync(join(DEFERRED, "folded-twin-refusals.patch"), "utf8");
    const mangled = real.replace(/^ (\S)/m, " ZZ$1");
    expect(mangled, "the mangle must actually change the patch").not.toBe(real);

    const scratch = join(mkdtempSync(join(tmpdir(), "deferred-selftest-")), "broken.patch");
    writeFileSync(scratch, mangled);
    const result = gitApplyCheck(scratch);
    expect(result.ok).toBe(false);
    expect(result.message, "and it must fail for the right reason").toMatch(/does not apply/);

    // …and a missing file is still seen, which is the weaker case.
    expect(gitApplyCheck(join(DEFERRED, "nothing-here.patch")).ok).toBe(false);
  });
});
