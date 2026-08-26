/**
 * Placeholder data for the console.
 *
 * Everything in this file stands in for something the app cannot get yet.
 * Each block says what will replace it. Nothing here is a fixture of real
 * customer data — the values are the ones in `docs/design/console-mockup.html`,
 * which are themselves invented, plus the demo contexts below.
 *
 * What is **not** here, because it is already live from Convex:
 *   - the list of contexts and your role in each  → `functions/workspaces.listMyWorkspaces`
 *   - the storage binding and its capabilities    → `functions/storage.getStorageBinding`
 *   - connected AI clients and revocation         → `functions/grants.listGrants` / `revokeGrant`
 */

import type { FileEntry, FolderListing, Visibility } from "./files/types";
import type { IngestionSettings } from "./ingestion/settings";
import type { MapEdge, MapGraph, MapNode } from "./map/layout";

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
  {
    id: "pw",
    x: 0.7,
    y: 0.75,
    r: 22,
    label: "@public-worship",
    sub: "shared · 6 members",
    kind: "shared",
  },
  { id: "c1", x: 0.1, y: 0.62, r: 12, label: "Claude", kind: "client" },
  { id: "c2", x: 0.31, y: 0.09, r: 12, label: "ChatGPT", kind: "client" },
  { id: "c3", x: 0.08, y: 0.16, r: 12, label: "Codex", kind: "client" },
  { id: "c4", x: 0.93, y: 0.55, r: 12, label: "Notion AI", kind: "client" },
];

const DEMO_EDGES: MapEdge[] = [
  { from: "you", to: "seyi", kind: "own" },
  { from: "you", to: "lk", kind: "team" },
  { from: "you", to: "pw", kind: "shared" },
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

// ─── Context settings ────────────────────────────────────────────────────────

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
 * Replaced by: `getIngestionSettings({ workspaceId })`, which is being built in
 * parallel and returns the issued alias along with the target folder and the
 * allow-list. Until a deployment has that module, the console derives a
 * plausible address from the workspace slug purely for display, and the card
 * says the rules are not configurable yet rather than pretending — see
 * `ingestion/useIngestionSettings.ts`.
 */
export function placeholderIngestionAddress(slug: string): string {
  return `${slug}@context.lc`;
}

// ─── The demo contexts ───────────────────────────────────────────────────────

/**
 * PLACEHOLDER — the three sample contexts the landing page browses.
 *
 * Replaced by: nothing, ever. This is the read-only console on the marketing
 * page, and it is deliberately not a screenshot — it runs the real
 * `BrowsePane` against these literals, so the components cannot drift from the
 * product. The signed-in console never reads these trees; it reads the
 * customer's bucket.
 *
 * The material is chosen to make three different things legible at a glance:
 *
 *  - **`@seyi`** — a personal context you own. Full PARA, projects *and*
 *    standing areas, with private items sitting inside folders whose default
 *    is team. That combination is the whole visibility model in one screen.
 *  - **`@lk`** — someone else's context you have *team* access to. Visibly
 *    fewer items and not one private thing, because a team caller is never
 *    shown what it may not read. Its smallness is the privacy model working
 *    rather than a loading state, and the pane says so in words.
 *  - **`@public-worship`** — a shared context with several members, carrying
 *    the organisation's actual workstreams.
 *
 * Public Worship is a real Christian nonprofit in New York, founded September
 * 2024 and operating under Global Echo Charitable's 501(c)(3); Seyi is its
 * Executive Director. Using its real workstreams rather than lorem is the
 * point — a demo whose notes say nothing teaches nothing about what this is
 * for.
 */

export interface DemoContextTree {
  /** Folder listings by path. `""` is the root. */
  listings: Record<string, FolderListing>;
  /** Note bodies by path. A path with no entry here is a folder. */
  notes: Record<string, string>;
  /** What is open when you arrive in this context. */
  defaultSelection: string;
  /** Folders expanded on arrival, so the point of each tree is visible. */
  defaultExpanded: string[];
  /**
   * Why this console cannot edit. Two different reasons live in the demo and
   * the difference matters: a visitor cannot edit anything, and `@lk` is
   * additionally a context they only ever read.
   */
  readOnlyReason: string;
}

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

/** A file held back from — or shared out of — its folder's default. */
function exception(path: string, visibility: Visibility, inherited: Visibility): FileEntry {
  return file(path, { visibility, inherited, exception: true });
}

function folder(path: string, visibility: Visibility): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

/** A file in a `team` folder inherits team, so it carries no marker of its own. */
function teamFile(path: string): FileEntry {
  return file(path, { visibility: "team", inherited: "team" });
}

function listing(path: string, folderDefault: Visibility, entries: FileEntry[]): FolderListing {
  return { path, folderDefault, entries, truncated: false, manifestUsable: true };
}

/** The generated manifest, wrapped in the markers the gateway looks for. */
function privacyNote(rules: string): string {
  return [
    "---",
    "role: privacy-manifest",
    "---",
    "",
    "# Access map",
    "",
    "This file decides what a connected AI client is allowed to see.",
    "",
    "<!-- BEGIN BRAIN PRIVACY RULES -->",
    "",
    "```yaml",
    rules,
    "```",
    "",
    "<!-- END BRAIN PRIVACY RULES -->",
    "",
  ].join("\n");
}

// ── @seyi — personal, owner ──────────────────────────────────────────────────

const SEYI_TREE: DemoContextTree = {
  listings: {
    "": listing("", "private", [
      folder("0-inbox", "private"),
      folder("1-projects", "team"),
      folder("2-areas", "private"),
      folder("3-resources", "private"),
      folder("4-archive", "private"),
      file("index.md"),
      file("privacy.md", { readOnly: true }),
    ]),
    "0-inbox": listing("0-inbox", "private", [
      file("0-inbox/fwd-bandshell-permit.md"),
      file("0-inbox/voice-memo-2026-08-24.md"),
    ]),
    "1-projects": listing("1-projects", "team", [
      teamFile("1-projects/context-lc.md"),
      teamFile("1-projects/dc-chapter.md"),
      exception("1-projects/ltn-2026-rider.md", "private", "team"),
    ]),
    "2-areas": listing("2-areas", "private", [
      folder("2-areas/public-worship", "team"),
      folder("2-areas/supa-media", "private"),
      file("2-areas/weekly-review.md"),
    ]),
    "2-areas/public-worship": listing("2-areas/public-worship", "team", [
      teamFile("2-areas/public-worship/org-chart.md"),
      exception("2-areas/public-worship/board-notes.md", "private", "team"),
    ]),
    "3-resources": listing("3-resources", "private", [
      file("3-resources/doxology-framework.md"),
      file("3-resources/matthew-13-soil.md"),
    ]),
  },
  notes: {
    "index.md": [
      "# Seyi",
      "",
      "Executive Director, Public Worship (New York). Founder, Supa Media.",
      "",
      "Everything here is plain markdown in a bucket I own. The folders are",
      "PARA: capture in 0-inbox, active work in 1-projects, standing",
      "responsibilities in 2-areas, reference in 3-resources.",
      "",
    ].join("\n"),
    "0-inbox/fwd-bandshell-permit.md": [
      "---",
      "source: email",
      "received: 2026-08-25",
      "---",
      "",
      "# Fwd: Central Park Bandshell — permit window",
      "",
      "Forwarded to my ingestion address and filed here automatically.",
      "Naumburg Bandshell, the 3–6 PM slot. The amplification cap is the",
      "open question; the rider assumes we bring our own PA.",
      "",
    ].join("\n"),
    "0-inbox/voice-memo-2026-08-24.md": [
      "# Voice memo — Sunday",
      "",
      "Presence over performance. Say it again in the Academy intro —",
      "people keep hearing it as \"lower the standard\" and it is the",
      "opposite: the craft serves the room rather than the recording.",
      "",
    ].join("\n"),
    "1-projects/context-lc.md": [
      "---",
      "updated: 2026-08-26",
      "status: active",
      "---",
      "",
      "# Context.LC — build decisions",
      "",
      "Tenancy is bucket-level, never prefix-level. No key",
      "namespacing inside a customer bucket, so an existing",
      "brain connects with zero migration and Obsidian",
      "Remotely Save keeps working.",
      "",
      "A shared context is just a workspace with more than",
      "one member — so a storage binding hangs off a",
      "workspaceId, never a userId.",
      "",
    ].join("\n"),
    "1-projects/dc-chapter.md": [
      "---",
      "updated: 2026-08-18",
      "status: discussing",
      "---",
      "",
      "# Chapter model — DC next",
      "",
      "The chapter model is the growth path: a chapter runs its own",
      "gatherings on the shared format, under the same fiscal sponsor,",
      "with its own local leadership on the org chart.",
      "",
      "DC is the one being discussed. Open questions: who holds the",
      "local budget, and whether a chapter can host Worship With",
      "Strangers before it has run PW 101.",
      "",
    ].join("\n"),
    "1-projects/ltn-2026-rider.md": [
      "---",
      "updated: 2026-08-19",
      "visibility: private",
      "---",
      "",
      "# LTN 2026 — production rider",
      "",
      "Central Park Bandshell, 3–6 PM, planning for ~500 people.",
      "",
      "Held back from this folder's team default while the vendor quotes",
      "are still in it. The frontmatter above is ignored — privacy.md is",
      "what decides, and it lists this note as an exception.",
      "",
    ].join("\n"),
    "2-areas/weekly-review.md": [
      "# Weekly review",
      "",
      "Friday. Empty 0-inbox, move anything that has become work into",
      "1-projects, and ask of every project: is this still the thing?",
      "",
    ].join("\n"),
    "2-areas/public-worship/org-chart.md": [
      "# Org chart",
      "",
      "Executive Director → Music, Production, Formation, Operations.",
      "Each lead holds a seat, and a seat carries duties rather than a",
      "person's name — so a handover is a change to one field.",
      "",
      "Shared with the team on purpose: everyone should be able to see",
      "who is responsible for what without asking.",
      "",
    ].join("\n"),
    "2-areas/public-worship/board-notes.md": [
      "# Board notes",
      "",
      "Private inside a shared folder. Governance conversations under the",
      "fiscal sponsor are minuted here and summarised openly once the",
      "decisions are final.",
      "",
    ].join("\n"),
    "3-resources/doxology-framework.md": [
      "# The doxology framework",
      "",
      "How we evaluate a worship song before it goes in a set.",
      "",
      "1. **Who is it addressed to?** Doxology is sung *to* God, not",
      "   about an experience of God.",
      "2. **Could the room mean it?** If it only works when performed by",
      "   the person who wrote it, it is a concert piece.",
      "3. **Is it true?** Not \"is it moving\" — true.",
      "",
    ].join("\n"),
    "3-resources/matthew-13-soil.md": [
      "# Seeds and soil",
      "",
      "Matthew 13. The sower does the same thing everywhere; the",
      "difference is the ground. Our mission language comes from here —",
      "we are not trying to produce a harvest, we are trying to be",
      "somewhere one is possible.",
      "",
    ].join("\n"),
    "privacy.md": privacyNote(
      [
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  0-inbox: private",
        "  1-projects: team",
        "  2-areas: private",
        "  2-areas/public-worship: team",
        "  3-resources: private",
        "  4-archive: private",
        "",
        "note_overrides:",
        "  1-projects/ltn-2026-rider.md: private",
        "  2-areas/public-worship/board-notes.md: private",
      ].join("\n"),
    ),
  },
  defaultSelection: "1-projects/context-lc.md",
  defaultExpanded: ["1-projects"],
  readOnlyReason: "This is a demo. Sign in to edit your own context.",
};

// ── @lk — someone else's context, team access ────────────────────────────────

const LK_TREE: DemoContextTree = {
  listings: {
    "": listing("", "private", [
      folder("1-projects", "team"),
      folder("3-resources", "team"),
      file("index.md", { visibility: "team", inherited: "team" }),
      file("privacy.md", { readOnly: true }),
    ]),
    "1-projects": listing("1-projects", "team", [
      teamFile("1-projects/worship-with-strangers.md"),
      teamFile("1-projects/pw-101-curriculum.md"),
    ]),
    "3-resources": listing("3-resources", "team", [
      teamFile("3-resources/set-building.md"),
    ]),
  },
  notes: {
    "index.md": [
      "# LK",
      "",
      "Music and formation, Public Worship.",
      "",
      "You are seeing this context with **team** access, which is why it",
      "looks small: private folders are not listed at all, so there is",
      "nothing here whose absence you could notice.",
      "",
    ].join("\n"),
    "1-projects/worship-with-strangers.md": [
      "---",
      "updated: 2026-08-21",
      "status: active",
      "---",
      "",
      "# Worship With Strangers",
      "",
      "A public, participatory format. No stage in the usual sense: the",
      "room is the choir and the band is accompanying it.",
      "",
      "The rule that makes it work is that nothing is performed at",
      "people. If a song cannot be sung by someone who has never heard",
      "it, it does not go in.",
      "",
    ].join("\n"),
    "1-projects/pw-101-curriculum.md": [
      "---",
      "updated: 2026-08-11",
      "---",
      "",
      "# PW 101",
      "",
      "The Academy's entry course, in three movements:",
      "",
      "- **The Heart** — why we sing at all, and to whom.",
      "- **The Craft** — the musicianship the room deserves.",
      "- **The Witness** — what a gathering says to someone who",
      "  wandered in.",
      "",
    ].join("\n"),
    "3-resources/set-building.md": [
      "# Building a set",
      "",
      "Keys before songs. Pick the range the room can actually sing in,",
      "then find the songs that live there — not the other way round.",
      "",
    ].join("\n"),
    "privacy.md": privacyNote(
      [
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  1-projects: team",
        "  3-resources: team",
        "",
        "note_overrides: {}",
      ].join("\n"),
    ),
  },
  defaultSelection: "1-projects/worship-with-strangers.md",
  defaultExpanded: ["1-projects"],
  readOnlyReason:
    "You have team access to this context. Anything LK keeps private is not listed here at all — that is the privacy model, not a loading state.",
};

// ── @public-worship — shared, several members ────────────────────────────────

const PUBLIC_WORSHIP_TREE: DemoContextTree = {
  listings: {
    "": listing("", "team", [
      folder("0-inbox", "team"),
      folder("1-projects", "team"),
      folder("2-areas", "team"),
      folder("3-resources", "team"),
      folder("4-archive", "team"),
      file("index.md", { visibility: "team", inherited: "team" }),
      file("privacy.md", { readOnly: true }),
    ]),
    "0-inbox": listing("0-inbox", "team", [
      teamFile("0-inbox/fwd-bandshell-permit.md"),
    ]),
    "1-projects": listing("1-projects", "team", [
      teamFile("1-projects/ltn-2026.md"),
      teamFile("1-projects/dc-chapter.md"),
      teamFile("1-projects/academy-pw-101.md"),
      exception("1-projects/fiscal-sponsorship.md", "private", "team"),
    ]),
    "2-areas": listing("2-areas", "team", [
      teamFile("2-areas/org-chart.md"),
      teamFile("2-areas/financial-transparency.md"),
      teamFile("2-areas/worship-with-strangers.md"),
    ]),
    "3-resources": listing("3-resources", "team", [
      teamFile("3-resources/doxology-framework.md"),
      teamFile("3-resources/mission.md"),
    ]),
  },
  notes: {
    "index.md": [
      "# Public Worship",
      "",
      "A Christian nonprofit in New York City, founded September 2024 and",
      "operating under Global Echo Charitable's 501(c)(3).",
      "",
      "Six people can read this context. Everything in it is team by",
      "default — the exceptions are the two or three things that are not",
      "ours to publish yet.",
      "",
    ].join("\n"),
    "0-inbox/fwd-bandshell-permit.md": [
      "---",
      "source: email",
      "received: 2026-08-25",
      "---",
      "",
      "# Fwd: Central Park Bandshell — permit window",
      "",
      "Forwarded in through the ingestion address. Naumburg Bandshell,",
      "3–6 PM. Someone please turn this into a task on LTN 2026.",
      "",
    ].join("\n"),
    "1-projects/ltn-2026.md": [
      "---",
      "updated: 2026-08-19",
      "status: active",
      "---",
      "",
      "# LTN 2026",
      "",
      "Central Park Bandshell, 3–6 PM, planning for ~500 people.",
      "",
      "Load-in at noon, sound check 2 PM, doors 2:45. The rider assumes",
      "we bring our own PA; the amplification cap on the permit is the",
      "open question.",
      "",
      "Presence over performance applies to the production too — the rig",
      "should be invisible from the lawn.",
      "",
    ].join("\n"),
    "1-projects/dc-chapter.md": [
      "---",
      "updated: 2026-08-18",
      "status: discussing",
      "---",
      "",
      "# Chapter model — DC next",
      "",
      "A chapter runs its own gatherings on the shared format, under the",
      "same fiscal sponsor, with its own local leadership on the org",
      "chart. DC is the one being discussed.",
      "",
    ].join("\n"),
    "1-projects/academy-pw-101.md": [
      "---",
      "updated: 2026-08-11",
      "---",
      "",
      "# Public Worship Academy — PW 101",
      "",
      "Organised in three movements:",
      "",
      "- **The Heart** — why we sing at all, and to whom.",
      "- **The Craft** — the musicianship the room deserves.",
      "- **The Witness** — what a gathering says to someone who",
      "  wandered in.",
      "",
      "PW 101 is the prerequisite for leading anywhere, chapters",
      "included.",
      "",
    ].join("\n"),
    "1-projects/fiscal-sponsorship.md": [
      "---",
      "visibility: private",
      "---",
      "",
      "# Fiscal sponsorship",
      "",
      "The one exception in this folder. Correspondence with Global Echo",
      "Charitable about the sponsorship agreement stays private until the",
      "terms are settled — then it moves into the open like everything",
      "else.",
      "",
    ].join("\n"),
    "2-areas/org-chart.md": [
      "# Org chart",
      "",
      "Executive Director (Seyi) → Music, Production, Formation,",
      "Operations. Each lead holds a seat; a seat carries duties rather",
      "than a person's name, so a handover changes one field.",
      "",
      "Chapters attach here: a chapter lead reports into Formation for",
      "the format and into Operations for the money.",
      "",
    ].join("\n"),
    "2-areas/financial-transparency.md": [
      "# Financial transparency",
      "",
      "Donors can inspect the ledger at the transaction level. Not a",
      "summary, not a pie chart — the actual rows, with what each one",
      "bought.",
      "",
      "The rule is that anything we would not be willing to show a donor",
      "line by line is something we should not be spending on.",
      "",
    ].join("\n"),
    "2-areas/worship-with-strangers.md": [
      "# Worship With Strangers",
      "",
      "A public, participatory format. The room is the choir; the band",
      "accompanies it. Nothing is performed at people.",
      "",
      "It is the format a chapter runs, which is why it lives in areas",
      "rather than projects — it does not finish.",
      "",
    ].join("\n"),
    "3-resources/doxology-framework.md": [
      "# The doxology framework",
      "",
      "How we evaluate a song before it goes in a set.",
      "",
      "1. **Who is it addressed to?** Doxology is sung *to* God.",
      "2. **Could the room mean it?** If it only works performed by the",
      "   person who wrote it, it is a concert piece.",
      "3. **Is it true?** Not \"is it moving\" — true.",
      "",
    ].join("\n"),
    "3-resources/mission.md": [
      "# Mission",
      "",
      "Matthew 13. The sower does the same thing everywhere; the",
      "difference is the ground. We are not trying to produce a harvest —",
      "we are trying to be somewhere one is possible.",
      "",
      "House shorthand: **presence over performance**.",
      "",
    ].join("\n"),
    "privacy.md": privacyNote(
      [
        "default_visibility: team",
        "",
        "folder_defaults:",
        "  0-inbox: team",
        "  1-projects: team",
        "  2-areas: team",
        "  3-resources: team",
        "  4-archive: team",
        "",
        "note_overrides:",
        "  1-projects/fiscal-sponsorship.md: private",
      ].join("\n"),
    ),
  },
  defaultSelection: "1-projects/ltn-2026.md",
  defaultExpanded: ["1-projects"],
  readOnlyReason: "This is a demo. Sign in to edit your own context.",
};

/** The demo contexts, keyed by the id `useDemoConsoleData` gives them. */
export const DEMO_CONTEXT_TREES: Record<string, DemoContextTree> = {
  seyi: SEYI_TREE,
  lk: LK_TREE,
  pw: PUBLIC_WORSHIP_TREE,
};

/** The tree for a context, falling back to `@seyi` rather than to an empty pane. */
export function demoTreeFor(contextId: string | null): DemoContextTree {
  return (contextId !== null ? DEMO_CONTEXT_TREES[contextId] : undefined) ?? SEYI_TREE;
}

/**
 * PLACEHOLDER — the demo's ingestion rules, one set per context.
 *
 * Replaced by the same `getIngestionSettings` call as everything else. These
 * exist so the landing page shows the three shapes the control actually has —
 * a single address, a whole domain, and the two together — instead of an empty
 * list that would read as "this does nothing".
 */
export const DEMO_INGESTION: Record<string, IngestionSettings> = {
  seyi: {
    address: "seyi@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: ["seyi@publicworship.life"],
    allowedDomains: [],
    allowAnySender: false,
  },
  lk: {
    address: "lk@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: [],
    allowedDomains: ["publicworship.life"],
    allowAnySender: false,
  },
  pw: {
    address: "public-worship@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: ["grants@globalecho.org"],
    allowedDomains: ["publicworship.life"],
    allowAnySender: false,
  },
};
