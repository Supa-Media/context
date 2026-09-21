#!/usr/bin/env node
/**
 * The exit is never gated. This is the check, not the comment.
 *
 * Non-negotiable #1 is the promise the whole product rests on: a customer can
 * always leave with their content, and *"that exit is never gated, never
 * degraded, and never behind a paywall — gate it and this is a different
 * product."* `billing.ts` already forbids the class of code that would break
 * it, under the heading **"What this file may never grow"**:
 *
 *   > A function that consults the plan to decide whether somebody may export,
 *   > download, or hand over their bucket.
 *
 * That is a prohibition on code nobody has written yet, and a prohibition in
 * prose cannot fail a build. `docs/decisions/testing.md` is one rule — **a
 * guard nobody has checked is not a guard** — and a rule nobody can check is
 * not even that.
 *
 * ## What is checked, and why it is the STRONGER property
 *
 * Not "the exit ignores the plan" but **"the plan never reaches the exit"**.
 *
 * Two files serve every export. `/gateway/session` resolves the token that
 * every read runs under, and `/gateway/binding` opens the storage the bytes
 * come out of; both land in `apps/convex/functions/controlPlane.ts`, and
 * everything downstream of them is `apps/mcp/src`. If billing vocabulary never
 * appears in either, then no future edit can gate on it *by accident* — the
 * value is not in scope to be read. Checking "it is read but not acted on"
 * would need dataflow analysis and would pass a gate written the obvious way.
 *
 * This is the same shape as `check-gateway-imports.mjs`, whose `stripComments`
 * is imported rather than reimplemented: a second copy of that walker is a
 * second place for it to be wrong.
 *
 * ## Comments are stripped, and that is load-bearing
 *
 * The prose documenting *compliance* names the very identifiers this forbids —
 * `menu.ts` says the download is **"deliberately not gated on `canEdit`"**, and
 * a naive grep would redden on the sentence that proves the rule is kept. That
 * is the false positive `check-gateway-imports.mjs` records hitting first, in
 * its own header, and the reason its walker exists.
 *
 *   node scripts/check-exit-is-ungated.mjs
 *   node scripts/check-exit-is-ungated.mjs --self-test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./check-gateway-imports.mjs";

/**
 * The files that serve the exit.
 *
 * `controlPlane.ts` is both halves of it: `gatewaySession` and `gatewayBinding`
 * in `http.ts` are thin routes that hand straight to this file. `apps/mcp/src`
 * is every byte that leaves afterwards.
 */
export const EXIT_PATHS = ["apps/convex/functions/controlPlane.ts", "apps/mcp/src"];

/**
 * Billing vocabulary, as identifiers.
 *
 * Every entry is a word that only appears when code is consulting what somebody
 * has paid for. Each was checked against the tree before being added: all of
 * them are absent from the exit paths today, so this guard starts green and can
 * only go red on a new gate.
 *
 * Deliberately NOT here: a bare `cancelled`, which the Google Calendar adapter
 * uses for an event status and the MCP protocol uses for
 * `notifications/cancelled`. A term that matches honest code is a term that
 * gets the guard disabled rather than the gate removed.
 */
export const GATE_TERMS = [
  "workspacePlan",
  "workspacePlans",
  "entitlement",
  "entitlements",
  "subscription",
  "premium",
  "isPaid",
  "past_due",
  "requirePremium",
  "canEdit",
  "stripe",
  "managedStorage",
  "planFor",
];

function filesUnder(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  const out = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(js|ts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every gate term appearing in `source` outside comments. */
export function gatesIn(source) {
  const code = stripComments(source);
  const found = [];
  for (const term of GATE_TERMS) {
    // Word-boundaried and case-insensitive: `Premium`, `PREMIUM_PLAN` and
    // `isPremium` are all the same gate wearing different capitalisation.
    if (new RegExp(`\\b${term}\\b`, "i").test(code)) found.push(term);
  }
  return found;
}

function run(roots = EXIT_PATHS) {
  const failures = [];
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const gates = gatesIn(readFileSync(file, "utf8"));
      if (gates.length > 0) failures.push({ file, gates });
    }
  }
  return failures;
}

function selfTest() {
  const cases = [
    // The four gates, one per line of attack.
    ["a plan gate", `const plan = await planFor(ctx, id); if (!plan) return null;`, true],
    ["a subscription gate", `if (workspace.subscription !== "active") return json({ binding: null });`, true],
    ["a canEdit gate on the exit", `if (!canEdit) return { download: false };`, true],
    ["a cancellation gate by entitlement", `const e = await entitlements(id); if (!e.active) return null;`, true],
    // And the shapes that must NOT redden.
    ["the comment that documents compliance", `// deliberately not gated on canEdit — downloading is a read\nreturn download();`, false],
    ["a block comment naming the rule", `/* A function that consults the plan (premium, subscription) is forbidden. */\nok();`, false],
    ["an honest cancelled event status", `const status = raw?.status === "cancelled" ? "cancelled" : "confirmed";`, false],
    ["ordinary export code", `const bytes = await store.get(key); return bytes.arrayBuffer();`, false],
  ];
  let failed = 0;
  for (const [name, source, shouldFlag] of cases) {
    const flagged = gatesIn(source).length > 0;
    const ok = flagged === shouldFlag;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const failures = run();
  if (failures.length > 0) {
    console.error("The exit is gated. Non-negotiable #1 says it never is.\n");
    for (const { file, gates } of failures) {
      console.error(`  - ${file}: reads ${gates.join(", ")}`);
    }
    console.error(
      "\nThese files serve every export: /gateway/session resolves the token each read runs\n" +
        "under, and /gateway/binding opens the storage the bytes come from. Billing state must\n" +
        "not be in scope here at all — not read and ignored, not present. If a plan genuinely\n" +
        "needs to be consulted somewhere, it does not belong on the path somebody leaves by.",
    );
    process.exit(1);
  }
  console.log("OK — the exit consults no billing state; non-negotiable #1 holds.");
}
