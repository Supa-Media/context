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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const TESTS_DIR = "apps/convex/__tests__";

/** A quoted path — any quote style — pointing anywhere under the gateway's src. */
export function readsGatewaySource(source) {
  if (typeof source !== "string") return false;
  return /["'`][^"'`]*mcp\/src\/[^"'`]*["'`]/.test(source);
}

/**
 * A test qualifies if it reads the gateway's source, or imports a helper that
 * does — and **which helpers those are is derived too.**
 *
 * The first version matched `mcp/src/index.js` plus one helper named in the
 * script. Review measured that false against files present in the tree that
 * day: `addressing.test.ts` imports `../../mcp/src/store/s3.js` and
 * `writeImage.test.ts` imports `../../mcp/src/store/index.js`; neither
 * matched, and `addressing.test.ts` catches a sabotage none of the six did.
 * The obvious widening — qualify on any `*.helpers` import — was worse in the
 * other direction: nearly every test here imports some local helper, so it
 * matched 34 of 40 files. So the helpers are filtered to the ones that
 * themselves read the gateway, which today is exactly one.
 *
 * It matches the written import path rather than resolving it, so a
 * `readFileSync(join(GATEWAY_DIR, …))` or a path alias still slips through.
 * Stated rather than papered over: the workflow runs the whole suite, so a
 * miss here costs a name in a listing, not a gap in coverage.
 */
export function importsGatewayHelper(source, helpers) {
  if (typeof source !== "string") return false;
  return helpers.some((name) => new RegExp(`["'\`][^"'\`]*${name}["'\`]`).test(source));
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
    // Both of these are real files the first version of this detector missed.
    ['import { S3Store } from "../../mcp/src/store/s3.js";', true],
    ['import { WRITABLE_CONTENT_TYPES } from "../../mcp/src/store/index.js";', true],
    ["import x from `../../mcp/src/session.js`;", true],
    // A path in prose is not a read. That distinction is why
    // check-gateway-imports.mjs stopped being a grep.
    ["// the gateway refuses both already (apps/mcp/src/index.js, move_note)", false],
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

  if (failed) process.exit(1);
  console.log("ok   detector self-test passed");
}

// Only when run as a command. The functions above are exported so a test can
// drive them, and a module that prints and can `process.exit(1)` merely
// because it was imported is a module nobody can safely reuse.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
