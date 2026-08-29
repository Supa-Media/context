#!/usr/bin/env node
/**
 * Which control-plane tests are really tests OF THE GATEWAY.
 *
 * Several files under `apps/convex/__tests__` read `apps/mcp/src/index.js` as
 * their source of truth — `gatewayFormat.helpers.ts` evaluates the gateway's
 * real module and hands back its private helpers, and one test scrapes a
 * constant straight out of the text. They are the only checks anywhere that
 * the gateway's privacy engine still agrees with the control plane's.
 *
 * They live in the control plane's package, and the control plane's CI job is
 * filtered on `apps/convex/**`. So on a pull request that changes only
 * `apps/mcp`, every one of them is skipped — **the cross-package guards on the
 * gateway are silent on exactly the pull requests that change the gateway.**
 * Measured: adding a named export to `apps/mcp/src/index.js` leaves the
 * gateway's own suite ALL PASS and makes six control-plane files fail to
 * collect at all, and that job did not run on either of the two pull requests
 * that most recently modified that file.
 *
 * `mcp.yml`'s header records the same shape one layer down: the gateway's own
 * suite never ran, for the same reason, until it was moved out of the
 * framework's filtered pipeline. This is the half of that lesson that was not
 * carried across.
 *
 * **What this script is for, and what it is NOT for.** It answers "does the
 * cross-package contract still exist" and names the files carrying it. It is
 * deliberately **not** how the workflow chooses what to run: that job runs the
 * whole control-plane suite. A detector picking the files could miss a seventh
 * one somebody adds next month — the same false negative this job exists to
 * remove, reintroduced one level up. The full suite takes about ten seconds; a
 * narrower list is not worth being wrong about.
 *
 * The list is derived rather than typed for the same reason a hand-written set
 * went stale in the Dropbox guards. A file qualifies if it reads the gateway's
 * source directly or imports the helper that does.
 *
 * Usage:
 *   node scripts/gateway-contract-tests.mjs            # print the files
 *   node scripts/gateway-contract-tests.mjs --self-test # prove the detector works
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const TESTS_DIR = "apps/convex/__tests__";

/**
 * A path under the gateway's `src/`, in a position that READS it.
 *
 * Two versions of this were wrong in opposite directions, and the second was
 * worse. The first matched only `mcp/src/index.js` plus one hardcoded helper,
 * and missed `addressing.test.ts` and `writeImage.test.ts`, which import from
 * `mcp/src/store/`. Widening it to any quoted path under `mcp/src` — backticks
 * included, because a template literal is a quote — then counted **prose**:
 * this repository documents in JSDoc with backticked paths, so
 * `controlPlane.test.ts`, `noteCount.test.ts` and `structure.test.ts` all
 * qualified on comments that read a file they never touch. Eleven, of which
 * three were documentation.
 *
 * The fix that suggests itself — require the path to follow `from`, `import`,
 * `readFileSync` — does not work either, in both directions. **English uses
 * the word "from":** `structure.test.ts` says *"Nine from
 * `apps/mcp/src/controlPlane.js`"* in a doc comment and matches. And a real
 * read can nest the path out of reach: `ingestionGateway.test.ts` writes
 * `readFileSync(resolvePath(__dirname, "../../mcp/src/index.js"))`, where no
 * keyword sits adjacent to the quote.
 *
 * Nor does the quote character, which was the third attempt: match a straight-
 * quoted path and let backticked prose through. It survived by coincidence.
 * `[^"'\n]*` treats a possessive apostrophe as a closing quote, so **the house
 * voice defeats it** — one JSDoc line reading *"The gateway's
 * `apps/mcp/src/index.js` is what the control plane's copy mirrors"* in
 * `fixtures.helpers.ts`, which nearly everything imports, takes this listing
 * from 8 to **33 of 40**. So does quoting an error message that contains a
 * path. Measured both.
 *
 * What separates them without depending on prose style: **a relative path is a
 * code artifact.** An import writes `../../mcp/src/...`; prose writes the
 * repo-absolute `apps/mcp/src/...`, every time, because that is what a reader
 * needs. So the pattern requires a leading `./` or `../`. It matches the
 * template-literal import and the nested `readFileSync`, and is immune to all
 * three amplification probes above.
 *
 * It still matches text rather than resolving it, so a path built at runtime
 * or aliased slips through. Stated rather than papered over: the workflow runs
 * the whole suite, so a miss here costs a name in a listing, not coverage.
 */
export function readsGatewaySource(source) {
  if (typeof source !== "string") return false;
  return /\.\.?\/[^"'`\n]*mcp\/src\//.test(source);
}

/**
 * A test qualifies if it reads the gateway's source, or imports a helper that
 * does — and **which helpers those are is derived too.**
 *
 * The obvious alternative, qualifying on any `*.helpers` import, matched 34 of
 * 40 files: nearly every test here imports some local helper. Deriving the
 * list keeps it to helpers that themselves read the gateway, which today is
 * exactly one — and note that the derivation is only as sound as
 * `readsGatewaySource`. When that accepted prose, a single backticked path in
 * `fixtures.helpers.ts` — which nearly everything imports — took this listing
 * to 35 of 40. Measured, not imagined.
 */
export function importsGatewayHelper(source, helpers) {
  if (typeof source !== "string") return false;
  return helpers.some((name) =>
    new RegExp(`["'\`][^"'\`]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(source)
  );
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

export function gatewayContractTests(dir = TESTS_DIR) {
  const all = walk(dir);
  const helpers = all
    .filter((file) => file.endsWith(".helpers.ts"))
    .filter((file) => readsGatewaySource(readFileSync(file, "utf8")))
    .map((file) => basename(file, ".ts"));

  return all
    .filter((file) => !file.endsWith(".helpers.ts"))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return readsGatewaySource(source) || importsGatewayHelper(source, helpers);
    })
    .map((file) => relative("apps/convex", file))
    .sort();
}

function selfTest() {
  const cases = [
    ['const g = readFileSync(resolvePath(__dirname, "../../mcp/src/index.js"), "utf8");', true],
    // Real files the first version of this detector missed.
    ['import { S3Store } from "../../mcp/src/store/s3.js";', true],
    ['import { WRITABLE_CONTENT_TYPES } from "../../mcp/src/store/index.js";', true],
    // A real read with the path nested out of reach of any keyword —
    // ingestionGateway.test.ts's actual shape.
    ['readFileSync(resolvePath(__dirname, "../../mcp/src/index.js"), "utf8")', true],
    // A multi-line import, writeImage.test.ts's actual shape.
    ['import {\n  IMAGE_PREFIX,\n} from "../../mcp/src/store/index.js";', true],
    // PROSE IS NOT A READ, and every one of these was counted as one by a
    // previous version. The house style documents paths in backticks, and
    // English uses the word "from", so a read-context rule matched the third.
    ["// the gateway refuses both already (apps/mcp/src/index.js, move_note)", false],
    [" * See `apps/mcp/src/index.js` for the gateway side.", false],
    [" * Nine from `apps/mcp/src/controlPlane.js` (the MCP gateway) and three", false],
    // The two shapes that defeated the straight-quote rule, in the house voice:
    // a possessive apostrophe closes a quote class, and so does a quoted error
    // message. Each took the listing from 8 to 33 of 40 when planted in a
    // widely imported helper. Pinned here so the rule cannot regress to one
    // that reads prose.
    [" * The gateway's `apps/mcp/src/index.js` is what the control plane's copy mirrors.", false],
    [' * The message says "apps/mcp/src/index.js has an export this extraction".', false],
    ['import { api } from "../convex/_generated/api";', false],
    // A helper import is not a gateway read on its own — nearly every test
    // here imports one, and qualifying on that matched 34 of 40 files.
    ["import { seed } from './fixtures.helpers';", false],
    ["", false],
    [null, false],
  ];
  let failed = false;
  for (const [source, expected] of cases) {
    const actual = readsGatewaySource(source);
    if (actual !== expected) {
      console.error(`FAIL detector: expected ${expected} for ${JSON.stringify(source)}`);
      failed = true;
    }
  }

  // The helper hop, with the helper list supplied rather than scanned.
  const helperCases = [
    ["import { gatewayInternals } from './gatewayFormat.helpers';", true],
    ['import { gatewayInternals } from "./gatewayFormat.helpers";', true],
    ["import { seed } from './fixtures.helpers';", false],
    ['import { api } from "../convex/_generated/api";', false],
  ];
  for (const [source, expected] of helperCases) {
    if (importsGatewayHelper(source, ["gatewayFormat.helpers"]) !== expected) {
      console.error(`FAIL helper hop: expected ${expected} for ${JSON.stringify(source)}`);
      failed = true;
    }
  }

  // THE WIRING, not just the two functions. Removing the helper derivation
  // (`helpers = []`) left both function-level blocks above passing while the
  // listing silently dropped from 8 to 6, losing exactly the files that
  // qualify only through the hop. Two proven functions with an unproven join
  // is a guard nobody has checked, one level up.
  const listed = gatewayContractTests();
  // Stated as a property as well as by name, so a renamed test file produces a
  // useful failure rather than a puzzling one: each of the two routes in must
  // still be carrying at least one file.
  const direct = listed.filter((f) => readsGatewaySource(readFileSync(join("apps/convex", f), "utf8")));
  if (direct.length === 0 || direct.length === listed.length) {
    console.error(
      `FAIL wiring: ${direct.length} of ${listed.length} qualify by direct read — ` +
        "one route is carrying everything, so the other is not being exercised"
    );
    failed = true;
  }
  for (const required of [
    "__tests__/onboarding.test.ts", // helper hop only
    "__tests__/addressing.test.ts", // direct read only
  ]) {
    if (!listed.includes(required)) {
      console.error(`FAIL wiring: ${required} is not in the derived list`);
      failed = true;
    }
  }
  // And the prose files must stay out of it.
  for (const excluded of ["__tests__/structure.test.ts", "__tests__/noteCount.test.ts"]) {
    if (listed.includes(excluded)) {
      console.error(`FAIL wiring: ${excluded} mentions a path in prose and is not a read`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log(`ok   detector self-test passed (${listed.length} contract tests)`);
}

// Only when run as a command. The functions above are exported so a test can
// drive them, and a module that prints and can `process.exit(1)` merely
// because it was imported is a module nobody can safely reuse.
//
// `realpathSync` is load-bearing and was missing: the ESM loader resolves
// symlinks in `import.meta.url`, while `process.argv[1]` is only made
// absolute. So invoking this through ANY symlink in its path — an npm or pnpm
// bin shim, a mounted checkout — made both comparisons false and the whole
// script a no-op that exits 0. Measured: `node /tmp/link-to-this.mjs` printed
// nothing, and `--self-test` through the same link reported nothing and
// succeeded. **A check that is green because it did not execute, inside the
// job written to stop checks being green because they did not execute.**
// The `try` is not decoration: `realpathSync` throws ENOENT on a path that no
// longer exists, and at module top level that would make merely *importing*
// this file throw — contradicting the paragraph above it.
let invokedAs = null;
try {
  invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  invokedAs = null;
}
if (invokedAs && import.meta.url === pathToFileURL(invokedAs).href) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    process.exit(0);
  }

  const files = gatewayContractTests();
  if (files.length === 0) {
    console.error(
      "No control-plane test reads anything under apps/mcp/src.\n\n" +
        "Either the cross-package contract tests were deleted, or this detector\n" +
        "stopped matching them. A scan that finds nothing is not a pass — it is\n" +
        "this job quietly becoming decorative."
    );
    process.exit(1);
  }
  for (const file of files) console.log(file);
}
