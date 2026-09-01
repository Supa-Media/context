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
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

  test("the check can actually see a broken patch", () => {
    // The self-test: a guard nobody has checked is not a guard.
    const nonsense = join(__dirname, "deferredPatches.nonexistent.patch");
    expect(gitApplyCheck(nonsense).ok).toBe(false);
  });
});
