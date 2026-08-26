/**
 * Placeholder data for the console.
 *
 * Everything in this file stands in for something the app cannot get yet.
 * Each block says what will replace it. Nothing here is a fixture of real
 * customer data — the values are the ones in `docs/design/console-mockup.html`,
 * which are themselves invented.
 *
 * What is **not** here, because it is already live from Convex:
 *   - the list of contexts and your role in each  → `functions/workspaces.listMyWorkspaces`
 *   - the storage binding and its capabilities    → `functions/storage.getStorageBinding`
 *   - connected AI clients and revocation         → `functions/grants.listGrants` / `revokeGrant`
 */

import type { MapEdge, MapGraph, MapNode } from "./map/layout";

// ─── The MCP endpoint ────────────────────────────────────────────────────────

/**
 * Not placeholder data — a deployment constant. It is the same URL for every
 * customer; what differs is the OAuth grant the client gets after signing in.
 * Overridable so a self-hoster's console points at their own gateway.
 */
export const MCP_ENDPOINT =
  process.env.EXPO_PUBLIC_MCP_URL ?? "https://mcp.context.lc/mcp";

// ─── Browse pane ─────────────────────────────────────────────────────────────

// Nothing. The folder tree and the note itself are real: they come from the
// Convex actions in `apps/convex/functions/files.ts`, which open the
// workspace's storage credential inside a single internal action, talk to the
// customer's bucket, and return the result.
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
// The landing page's read-only version lives in
// `features/console/files/useDemoFileBrowser.ts` — literals, not a bucket.

// ─── Map pane ────────────────────────────────────────────────────────────────

/**
 * PLACEHOLDER — note counts and bytes stored.
 *
 * Replaced by: a stats call to the MCP gateway, which is the side that can see
 * the bucket. The control plane deliberately cannot count a customer's notes.
 * Contexts-reachable and clients-connected are computed from live Convex data
 * and are not placeholders; see `MapPane`.
 */
export const PLACEHOLDER_NOTE_TOTAL = "1,284";
export const PLACEHOLDER_BYTES_TOTAL = "2.4 GB";

/**
 * PLACEHOLDER — the per-context "1,102 notes" sub-label.
 *
 * Same replacement as above. The "· owner" half of that line is real, and is
 * appended from the Convex membership role.
 */
export const PLACEHOLDER_CONTEXT_NOTE_COUNTS: Record<string, string> = {};

/**
 * The signed-off demo constellation, with the mockup's exact hand-placed
 * coordinates.
 *
 * This renders only when there is no live data to draw yet — a signed-out
 * visitor, or a brand-new account with no context. Real accounts get
 * `buildConstellation`, which places nodes on orbits rather than by hand.
 */
const DEMO_NODES: MapNode[] = [
  { id: "you", x: 0.5, y: 0.5, r: 26, label: "You", kind: "you" },
  { id: "seyi", x: 0.26, y: 0.32, r: 34, label: "@seyi", sub: "1,102 notes · owner", kind: "own" },
  { id: "lk", x: 0.79, y: 0.3, r: 24, label: "@lk", sub: "team access", kind: "team" },
  { id: "ign", x: 0.7, y: 0.75, r: 22, label: "@ignite-2026", sub: "shared · 4 members", kind: "shared" },
  { id: "c1", x: 0.1, y: 0.62, r: 12, label: "Claude", kind: "client" },
  { id: "c2", x: 0.31, y: 0.09, r: 12, label: "ChatGPT", kind: "client" },
  { id: "c3", x: 0.08, y: 0.16, r: 12, label: "Codex", kind: "client" },
  { id: "c4", x: 0.93, y: 0.55, r: 12, label: "Notion AI", kind: "client" },
];

const DEMO_EDGES: MapEdge[] = [
  { from: "you", to: "seyi", kind: "own" },
  { from: "you", to: "lk", kind: "team" },
  { from: "you", to: "ign", kind: "shared" },
  { from: "seyi", to: "c1", kind: "client" },
  { from: "seyi", to: "c2", kind: "client" },
  { from: "seyi", to: "c3", kind: "client" },
  { from: "lk", to: "c4", kind: "client" },
];

export const DEMO_GRAPH: MapGraph = { nodes: DEMO_NODES, edges: DEMO_EDGES };

export const DEMO_STATS = {
  contexts: "3",
  clients: "4",
  notes: PLACEHOLDER_NOTE_TOTAL,
  bytes: PLACEHOLDER_BYTES_TOTAL,
};

// ─── Storage pane ────────────────────────────────────────────────────────────

/**
 * PLACEHOLDER — object count, PARA-structure detection, and versioning state.
 *
 * Replaced by: the connect-time capability probe that already exists on the
 * backend path (`functions/storage.bindStorage` verifies the binding and
 * records `capabilities`). Today `getStorageBinding` returns only
 * `conditionalWrite` and a status, both of which the pane reads live. The other
 * three lines need the probe to persist what it saw — an object count, whether
 * the PARA folders exist, and whether bucket versioning is on.
 */
export const PLACEHOLDER_OBJECT_COUNT = "1,284";
export const PLACEHOLDER_PARA_PRESENT = true;
export const PLACEHOLDER_VERSIONING_ON = false;

/**
 * PLACEHOLDER — the email ingestion alias.
 *
 * Replaced by: a per-workspace ingestion alias issued by the control plane and
 * routed by the Cloudflare email worker into `0-inbox/`. There is no Convex
 * function for it yet, so the console derives a plausible address from the
 * workspace slug purely for display and does not offer it as truth.
 */
export function placeholderIngestionAddress(slug: string): string {
  return `${slug}@context.lc`;
}
