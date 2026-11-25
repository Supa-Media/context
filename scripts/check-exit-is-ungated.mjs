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
 * in `http.ts` are thin routes that hand straight to this file. Its grant
 * resolution, binding shapes and validators live in `lib/controlPlane/`, split
 * out of it and scanned exactly as it is. `apps/mcp/src` is every byte that
 * leaves afterwards.
 */
export const EXIT_PATHS = [
  "apps/convex/functions/controlPlane.ts",
  "apps/convex/functions/lib/controlPlane",
  "apps/mcp/src",
];

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

/**
 * Exact string literals that carry a gate term but name somebody else's
 * protocol, not a plan of ours. Each is removed, quotes and all, before the
 * terms are looked for, so the same word anywhere else still reddens.
 *
 * - `"x-subscription-token"`: the header Brave Search reads its API key from
 *   (`packages/tex/gateway/agent/search.js`). It is our key to their service, and it
 *   says nothing about what a customer has paid for.
 */
export const FOREIGN_LITERALS = ['"x-subscription-token"'];

/**
 * One folder where one gate term names somebody else's service, not a plan of
 * ours. Each entry lets exactly its listed terms through for files under its
 * folder, and nothing else: every other term still reddens there, and the
 * same term still reddens in every other file.
 *
 * - `apps/mcp/src/data/connect/`, `stripe`: the data connectors read a
 *   customer's OWN Stripe account (their revenue, with a read-only key they
 *   gave) into a sheet in their workspace. That is their data coming in, not
 *   what they have paid us. Decided by the owner, 2026-11-25 ("Allow it in
 *   data connectors only"). Our own billing never lives in this folder.
 */
export const FOLDER_ALLOWED = [{ folder: "apps/mcp/src/data/connect/", terms: ["stripe"] }];

/** The terms `file` may carry, from `FOLDER_ALLOWED`. */
export function allowedFor(file = "") {
  const path = file.split("\\").join("/");
  return new Set(FOLDER_ALLOWED.filter((entry) => path.startsWith(entry.folder)).flatMap((entry) => entry.terms));
}

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

/** Every gate term appearing in `source` outside comments, less what `file`'s folder allows. */
export function gatesIn(source, file = "") {
  const allowed = allowedFor(file);
  let code = stripComments(source);
  for (const literal of FOREIGN_LITERALS) code = code.split(literal).join('""');
  const found = [];
  for (const term of GATE_TERMS) {
    if (allowed.has(term)) continue;
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
      const gates = gatesIn(readFileSync(file, "utf8"), file);
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
    ["a search provider's header name", `headers: { "x-subscription-token": key }`, false],
    ["that word gating anything else", `headers: { "x-subscription-token": key }; if (!subscription) return null;`, true],
    ["ordinary export code", `const bytes = await store.get(key); return bytes.arrayBuffer();`, false],
    // The one folder allowance: the word through, only there, and only that word.
    ["a customer's own Stripe read in the data connectors", `const STRIPE = "https://api.stripe.com/v1/balance_transactions";`, false, "apps/mcp/src/data/connect/stripe.js"],
    ["stripe anywhere else in the gateway", `const STRIPE = "https://api.stripe.com/v1/balance_transactions";`, true, "apps/mcp/src/data/sync/object.js"],
    ["a folder that only starts the same", `if (stripe.status) return null;`, true, "apps/mcp/src/data/connectors/x.js"],
    ["another gate term in the data connectors", `if (workspace.subscription !== "active") return null;`, true, "apps/mcp/src/data/connect/stripe.js"],
    ["a plan gate in the data connectors", `const plan = await planFor(ctx, id);`, true, "apps/mcp/src/data/connect/apps.js"],
  ];
  let failed = 0;
  for (const [name, source, shouldFlag, file] of cases) {
    const flagged = gatesIn(source, file).length > 0;
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
