#!/usr/bin/env node
/**
 * A real sign-in code for one of staging's personas (alpha..epsilon@supa.media).
 *
 * Staging's personas used to sign in with the fixed code `000000`. A code that
 * never expires and works for anybody failed the CASA assessment (1.2.1,
 * 1.3.x, 2026-11-11), staging included, so each sign-in now takes a fresh
 * code issued for that persona: random, single-use, ten minutes, and the same
 * attempt limits as everyone (`apps/convex/functions/signInCodes.ts`).
 *
 * Issuing one is an internal function, so it takes the staging deploy key
 * (`CONVEX_DEPLOY_KEY`, the GitHub staging environment's secret) through
 * `convex run`. Nothing on the public sign-in surface hands a code out.
 *
 * As a module: `await stagingSignInCode("alpha@supa.media")` returns the code
 * and never prints it. From a terminal, for a person signing in by hand:
 * `CONVEX_DEPLOY_KEY=… node scripts/staging-sign-in-code.mjs alpha` prints it.
 * Never run that in a CI log, which this public repository shows to anyone.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PERSONAS = ["alpha", "beta", "gamma", "delta", "epsilon"];

export function stagingSignInCode(email) {
  const address = String(email).trim().toLowerCase();
  if (!PERSONAS.some((name) => address === `${name}@supa.media`)) {
    throw new Error("Only staging's personas are issued codes this way.");
  }
  if (!process.env.CONVEX_DEPLOY_KEY) throw new Error("CONVEX_DEPLOY_KEY (the staging deploy key) is required.");
  const convex = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));
  const result = spawnSync(process.execPath, [convex, "run", "functions/signInCodes:issue", JSON.stringify({ email: address })], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, CONVEX_DEPLOYMENT: "" },
  });
  // Never echo stdout: it holds the code.
  if (result.status !== 0) throw new Error(`Issuing a staging code failed: ${result.stderr.slice(-500)}`);
  const { code } = JSON.parse(result.stdout);
  if (!/^\d{6}$/.test(code)) throw new Error("Issuing a staging code returned no code.");
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = (process.argv[2] ?? "").replace(/@supa\.media$/, "");
  console.log(stagingSignInCode(`${name}@supa.media`));
}
