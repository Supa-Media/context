/// <reference types="vite/client" />
/**
 * EVERY OPERATOR-SET VARIABLE THE CONTROL PLANE READS IS ONE THE DEPLOY PUSHES.
 *
 * `.github/workflows/deploy-convex.yml` exists because `convex deploy` does not
 * carry environment variables: a value set by hand in the dashboard survives
 * until somebody forgets it, and a value in the GitHub `production` environment
 * reaches the deployment only if that workflow's loop names it.
 *
 * The loop is a hand-maintained list, and the failure mode is silent in both
 * directions. `AUTH_EMAIL_FROM` was missing from it until 2026-09-05 — the
 * From: address on every sign-in code, out of step with GitHub, with nothing to
 * say so. `FORM_NOTIFY_EMAIL_FROM` was missing from it the day form
 * notifications shipped, which is how this test came to be written: the feature
 * worked, its one operator knob could not be turned, and the suite was green.
 *
 * So: collect the variable names the control plane actually reads, and require
 * each to be either **in the workflow's loop** or **in `SET_ELSEWHERE` below,
 * with a reason**. Adding a `process.env` read to `functions/` now forces that
 * choice at review time rather than at the first support question.
 *
 * It deliberately does not check the reverse direction. The loop may name a
 * variable nothing here reads yet — a feature flag landing ahead of its code is
 * ordinary, and failing on it would push people to leave it out of the loop,
 * which is the bug this file is about.
 *
 * ## There is a second guard, one link further up the chain
 *
 * `scripts/check-secrets-allowlist.mjs` checks that a name a workflow reads as
 * `secrets.NAME` is one the 1Password → GitHub sync actually supplies. That is
 * the hop *into* the GitHub environment; this file is the hop *out of* it, onto
 * the Convex deployment. A name can pass either and fail the other, so adding
 * an operator-set variable means touching `secrets-allowlist.json` as well —
 * the three names added alongside this file were caught by that checker, not
 * by this one.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function repoFile(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

/**
 * Names the deploy has no business pushing, each with the reason it is exempt.
 *
 * A name reaches this list because something *other than the GitHub production
 * environment* is responsible for it. "We have not got round to it" is not a
 * reason, and a name parked here to quiet the test is the failure this file
 * exists to make loud.
 */
const SET_ELSEWHERE: Record<string, string> = {
  APP_ENV: "synced only by scripts/staging-env.mjs; absent production value keeps the staging bypass disabled",
  STAGING_CONVEX_DEPLOYMENT: "synced only by scripts/staging-env.mjs from the staging GitHub environment variable",
  CONVEX_CLOUD_URL: "set by Convex itself on every deployment; used to verify the staging selector",
  CONVEX_SITE_URL: "set by Convex itself on every deployment; nothing to push",
  INGESTION_RECEIVER:
    "flipped by hand once, when Email Routing is actually pointed at the Worker — " +
    "a deploy must not be able to turn ingestion live",
  FREE_MANAGED_STORAGE:
    "flipped by hand, deliberately — production stays off until the export and hand-off " +
    "path lands (non-negotiable #1), staging is on through stagingStorageIsFree(), and a " +
    "deploy must not be able to turn a no-card managed bucket live",
  HOME_SITE_HANDLE:
    "a self-host's own homepage handle; our deployments leave it unset and get the " +
    "default, `context-lc`, which is also the router's default",
};

/** Every `.ts` under a directory, skipping tests and generated code. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "_generated" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * The names this file reads out of the environment.
 *
 * Two shapes, because the codebase uses both and a guard that knew only one
 * would be defeated by the other. `process.env.NAME` is the direct read;
 * `const SOMETHING_ENV_VAR = "NAME"` is the indirection `lib/crypto.ts`,
 * `lib/gatewayAuth.ts` and `functions/formNotify.ts` all use so the string
 * appears once.
 */
function envNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.push(m[1]);
  for (const m of source.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) names.push(m[1]);
  for (const m of source.matchAll(/ENV(?:_VAR)?\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) names.push(m[1]);
  return names;
}

/**
 * The `for var in … ; do` list in the workflow's sync step.
 *
 * There are two such loops in that file — this one, and the shorter one in
 * "Verify the control plane has what it needs" below it. The first match is
 * the sync loop today, and `assertIsSyncLoop` is what keeps that true: a
 * reordering that silently started checking the *verify* list would turn this
 * whole file into a test that a handful of variables are required, which is
 * not what it claims to assert.
 */
function workflowSyncList(): Set<string> {
  const workflow = readFileSync(repoFile(".github/workflows/deploy-convex.yml"), "utf8");
  const loop = workflow.match(/for var in ([\s\S]*?); do/);
  if (loop === null) throw new Error("no `for var in … ; do` loop in deploy-convex.yml");
  const names = new Set(
    loop[1].replace(/\\\s*\n/g, " ").split(/\s+/).filter((n) => n.length > 0),
  );
  // Present in the sync loop and absent from the verify loop, so this says
  // which of the two was read rather than merely that something was.
  for (const sentinel of ["RESEND_API_KEY", "TURNSTILE_SECRET_KEY"]) {
    if (!names.has(sentinel)) {
      throw new Error(`matched a loop without ${sentinel} — this is not the sync loop`);
    }
  }
  return names;
}

describe("the deploy pushes what the control plane reads", () => {
  const read = new Set<string>();
  for (const path of sources(repoFile("apps/convex"))) {
    for (const name of envNamesIn(readFileSync(path, "utf8"))) read.add(name);
  }

  it("finds the reads at all", () => {
    // A regex that matched nothing would make every assertion below vacuous.
    expect(read.has("RESEND_API_KEY")).toBe(true);
    expect(read.has("GATEWAY_SECRET")).toBe(true);
    expect(read.size).toBeGreaterThan(10);
  });

  it("names every one of them in the loop, or exempts it with a reason", () => {
    const synced = workflowSyncList();
    const unaccounted = [...read]
      .filter((name) => !synced.has(name) && SET_ELSEWHERE[name] === undefined)
      .sort();
    expect(unaccounted).toEqual([]);
  });

  it("keeps the exemptions honest", () => {
    // An exemption for a name nothing reads any more is stale documentation
    // about a risk that no longer exists, and hides the next real one.
    const stale = Object.keys(SET_ELSEWHERE).filter((name) => !read.has(name)).sort();
    expect(stale).toEqual([]);
    for (const reason of Object.values(SET_ELSEWHERE)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
