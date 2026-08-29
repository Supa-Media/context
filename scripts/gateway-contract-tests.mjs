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
import { join, relative } from "node:path";

const TESTS_DIR = "apps/convex/__tests__";
const HELPER = "gatewayFormat.helpers";

/** Reads the gateway's source, or imports the thing that does. */
export function readsGatewaySource(source) {
  if (typeof source !== "string") return false;
  // The path as it is written from inside apps/convex/__tests__, in either
  // quote style, with or without the `../..` prefix a nested file would use.
  if (/["'][^"']*mcp\/src\/index\.js["']/.test(source)) return true;
  return source.includes(HELPER);
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
  return walk(dir)
    .filter((file) => !file.endsWith(".helpers.ts"))
    .filter((file) => readsGatewaySource(readFileSync(file, "utf8")))
    .map((file) => relative("apps/convex", file))
    .sort();
}

function selfTest() {
  const cases = [
    ['const g = readFileSync(resolvePath(__dirname, "../../mcp/src/index.js"), "utf8");', true],
    ["import { gatewayInternals } from './gatewayFormat.helpers';", true],
    ['import { gatewayInternals } from "./gatewayFormat.helpers";', true],
    ["// the gateway refuses both already (apps/mcp/src/index.js, move_note)", false],
    ['import { api } from "../convex/_generated/api";', false],
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

  // A prose mention is not a read. That distinction is the whole reason
  // `check-gateway-imports.mjs` stopped being a grep, and the case above with
  // a bare unquoted path is exactly the shape that fooled it.
  if (failed) process.exit(1);
  console.log("ok   detector self-test passed");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const files = gatewayContractTests();
if (files.length === 0) {
  console.error(
    "No control-plane test reads apps/mcp/src/index.js.\n\n" +
      "Either the cross-package contract tests were deleted, or this detector\n" +
      "stopped matching them. A scan that finds nothing is not a pass — it is\n" +
      "this job quietly becoming decorative."
  );
  process.exit(1);
}
for (const file of files) console.log(file);
