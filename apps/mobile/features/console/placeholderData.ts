/**
 * Data for the signed-out console on the landing page.
 *
 * **The rule this file exists to enforce: an invented value may never reach a
 * signed-in person as a fact about their own data.** Everything invented here
 * is named `DEMO_*` and belongs to the marketing demo alone. Where the control
 * plane has no answer, the live console renders *nothing* — an absent row, not
 * a plausible one.
 *
 * That is not a style preference. The whole claim of this product is that the
 * notes are yours and the bucket is yours, and these values sat beside claims
 * that are genuinely derived — `Conditional writes verified` comes from
 * `binding.capabilities.conditionalWrite`. One fake check mark next to a true
 * one makes the true one unbelievable, so an invented number costs more here
 * than the blank it replaces. It shipped twice: #20 (the console stats) and
 * #25 (object count, PARA detection, versioning state), and both times a real
 * person read it as the truth about their own bucket.
 *
 * Enforcement, so it cannot come back by accident:
 *   - every invented export is prefixed `DEMO_`;
 *   - only the demo path may import one, and `__tests__/liveConsoleFacts.test.ts`
 *     fails if any other module does.
 *
 * The one non-`DEMO_` placeholder left is `placeholderIngestionAddress`, and it
 * is deliberately not a claim: the card that shows it says in words that the
 * rules are not configurable yet.
 *
 * What is **not** here, because it is already live from Convex:
 *   - the list of contexts and your role in each  → `functions/workspaces.listMyWorkspaces`
 *   - the storage binding and its capabilities    → `functions/storage.getStorageBinding`
 *   - connected AI clients and revocation         → `functions/grants.listGrants` / `revokeGrant`
 *
 * The data itself is split by subject under `./placeholderData/`: `map.ts`
 * (the constellation demo), `activity.ts`, `ingestion.ts`, the three demo
 * contexts (`seyi.ts`, `lk.ts`, `publicWorship.ts` — each built from
 * `treeHelpers.ts` and, for `@seyi`, `communications.ts`), and `contexts.ts`,
 * which keys them together. This file re-exports every one of them, so this
 * remains the one path anything outside the demo may import a `DEMO_` value
 * from.
 */

export { DEMO_GRAPH } from "./placeholderData/map";
export { DEMO_ACTIVITY } from "./placeholderData/activity";
export { placeholderIngestionAddress, DEMO_INGESTION } from "./placeholderData/ingestion";
export type { DemoContextTree } from "./placeholderData/treeHelpers";
export { DEMO_CONTEXT_TREES, demoTreeFor } from "./placeholderData/contexts";

// ─── The MCP endpoint ────────────────────────────────────────────────────────

/**
 * Not placeholder data — a deployment constant. It is the same URL for every
 * customer; what differs is the OAuth grant the client gets after signing in.
 * Overridable so a self-hoster's console points at their own gateway.
 */
export const MCP_ENDPOINT =
  process.env.EXPO_PUBLIC_MCP_URL ?? "https://mcp.context.lc/mcp";

// ─── Browse ──────────────────────────────────────────────────────────────────

// The live tree is real: it comes from the Convex actions in
// `apps/convex/functions/files.ts`, which open the workspace's storage
// credential inside a single internal action, talk to the customer's bucket,
// and return the result.
//
// This is worth a note because the block that used to live here said the
// opposite — that a tree could never come from Convex, because the control
// plane holds metadata only and must never see note content (CLAUDE.md,
// non-negotiable #1). That rule has not changed and is not bent. What changed
// is the reading of it: content **passing through** an action is not content
// **held** by the control plane. Nothing is cached, logged, or written to a
// table, and `apps/convex/__tests__/files.test.ts` sweeps every table for a
// marker string after a full editing session to prove it.
//
// What *is* placeholder is the demo further down this file: the three sample
// contexts the landing page browses. See `DEMO_CONTEXT_TREES`.

// ─── Map ─────────────────────────────────────────────────────────────────────
//
// See `./placeholderData/map.ts` for `DEMO_GRAPH`, the signed-off demo
// constellation with the mockup's exact hand-placed coordinates. It renders
// only when there is no live data to draw yet — a signed-out visitor, or a
// brand-new account with no context. Real accounts get `buildConstellation`,
// which places nodes on orbits rather than by hand.

/**
 * The demo account's four tiles.
 *
 * All four are invented, and only two of them have a live counterpart: the
 * signed-in console computes contexts-reachable and clients-connected from
 * Convex, and shows **no tile at all** for notes and bytes, because nothing
 * counts a whole bucket yet. See `useLiveConsoleData`.
 *
 * Kept here, rather than moved beside the other subject files, because
 * `__tests__/liveConsoleFacts.test.ts` reads this file's own source text to
 * confirm the demo path is where the invented values actually live —
 * `expect(placeholders).toContain("export const DEMO_STATS")` — so this is
 * the one export the split leaves in place on purpose.
 */
export const DEMO_STATS = {
  contexts: "3",
  clients: "4",
  notes: "1,284",
  bytes: "2.4 GB",
};

// ─── Context settings ────────────────────────────────────────────────────────

// The demo's object count, PARA flag and versioning state are literals on the
// three bindings in `useDemoConsoleData`, and used to be shared constants that
// the live console imported too — which is exactly how #25 happened. They are
// not exported from here any more, so there is nothing for the live path to
// reach for.
//
// Making them real is a backend job, not a frontend one: `getStorageBinding`
// returns `capabilities.conditionalWrite` and a status, and nothing else. An
// object count, PARA detection and versioning state each need the connect-time
// probe in `functions/storage.bindStorage` to persist what it saw. Until it
// does, `ConsoleStorage` leaves all three `undefined` and the rows do not
// render.
//
// See `./placeholderData/ingestion.ts` for `placeholderIngestionAddress` and
// `DEMO_INGESTION`, the email alias and the demo's per-context ingestion
// rules.

// ─── The demo contexts ───────────────────────────────────────────────────────
//
// See `./placeholderData/treeHelpers.ts` for the `DemoContextTree` shape and
// what the three demo contexts (`@seyi`, `@lk`, `@public-worship`) are each
// chosen to demonstrate, and `./placeholderData/contexts.ts` for
// `DEMO_CONTEXT_TREES` and `demoTreeFor`.
