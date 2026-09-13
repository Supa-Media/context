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
 */

import {
  channelDayNotePath,
  contactNotePath,
  contactSlug,
  messageAnchor,
  renderChannelDayNote,
  renderContactNote,
} from "@context/communications";
import type { CommunicationEvent } from "@context/communications/protocol";
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

/**
 * The demo account's four tiles.
 *
 * All four are invented, and only two of them have a live counterpart: the
 * signed-in console computes contexts-reachable and clients-connected from
 * Convex, and shows **no tile at all** for notes and bytes, because nothing
 * counts a whole bucket yet. See `useLiveConsoleData`.
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

/**
 * The email ingestion alias, derived rather than fetched.
 *
 * Not really a placeholder any more: `getIngestionSettings` exists and returns
 * the issued alias, but it answers `null` for a personal context that has no
 * policy row yet, and its owner still needs an address to forward mail to. This
 * is the same formula the backend applies — `ingestionAddressFor` in
 * `apps/convex/functions/lib/ingestion.ts` — so what the console shows in that
 * gap is the address that would actually receive.
 *
 * **The address is real; neither half of the delivery is.** Two separate facts
 * have to hold before any surface may say mail lands, and this function knows
 * neither of them:
 *
 *  - *Does this context have an address?* Only a personal one does, so this is
 *    only ever displayed for a context that has one. A shared context is shown
 *    no address at all; see `ingestion/settings.ts`.
 *  - *Is a receiver live?* There is none deployed. Mail sent here bounces with
 *    `550 5.1.1 Address does not exist`, so every surface that renders this
 *    string must gate its delivery claims — and its Copy button — on
 *    `receivesMail`, which is where the two are `&&`-ed.
 *
 * This function deliberately returns neither fact. The first belongs to the
 * workspace and the second to the deployment; a placeholder module is the last
 * place that should be guessing at either.
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

// ── Communications fixtures ──────────────────────────────────────────────────
//
// Real notes, rendered by the same package the gateway renders a customer's
// mail with — `renderChannelDayNote` and `renderContactNote` from
// `@context/communications` — never hand-typed markdown standing in for them.
// That is what lets `apps/mobile/e2e/webkit` walk Inbox → a channel → a day →
// a contact's activity link and land back on that exact day at the exact
// message the link named: the anchor on the fixture's contact page and the
// anchor on the rendered message are the same `messageAnchor(event)` call,
// not two numbers somebody kept in sync by hand.
//
// `@seyi` is the fixture `useDemoConsoleData` selects by default, so this is
// the one tree that carries them.

/** One communication, with the fields every fixture message shares. */
function commsMessage(
  overrides: Partial<CommunicationEvent> &
    Pick<CommunicationEvent, "messageId" | "threadId" | "sentAt" | "subject" | "from" | "body">,
): CommunicationEvent {
  return {
    channel: "email",
    account: "name-at-example-com",
    to: [{ address: "name@example.com" }],
    attachments: [],
    ...overrides,
  };
}

/**
 * Six messages across four threads on one day — enough that the sixth,
 * `BOARD_MESSAGE_ANCHOR`, is not the first thing on screen, so a WebKit case
 * following a link to it is actually asserting a scroll rather than a message
 * that was already in view.
 */
const EMAIL_DAY_EVENTS = [
  commsMessage({
    messageId: "<kickoff@mail.example.net>",
    threadId: "thread-kickoff",
    sentAt: "2026-09-07T09:05:00.000Z",
    subject: "LTN 2026 kickoff",
    from: { name: "Bea Lindqvist", address: "bea@example.net" },
    body: "Quick kickoff for LTN 2026 — notes are below, shout if anything is missing.",
  }),
  commsMessage({
    messageId: "<permit@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T10:20:00.000Z",
    subject: "Bandshell permit window",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body: "The 3–6 PM slot is confirmed. The amplification cap is still the open question.",
  }),
  commsMessage({
    messageId: "<rider@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T11:02:00.000Z",
    subject: "Re: Bandshell permit window",
    from: { name: "Name", address: "name@example.com" },
    body: "Assuming we bring our own PA — **rider** is attached.",
    attachments: [{ filename: "rider.pdf", contentType: "application/pdf", size: 48213 }],
  }),
  commsMessage({
    messageId: "<budget@mail.example.net>",
    threadId: "thread-budget",
    sentAt: "2026-09-07T13:45:00.000Z",
    subject: "Production budget draft",
    from: { name: "Bea Lindqvist", address: "bea@example.net" },
    body: "First pass at the budget. Load-in is the biggest line item by a wide margin.",
  }),
  commsMessage({
    messageId: "<soundcheck@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T15:30:00.000Z",
    subject: "Re: Bandshell permit window",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body: "Sound check moved to 2 PM sharp — please tell the crew.",
  }),
  commsMessage({
    messageId: "<board@mail.example.net>",
    threadId: "thread-board",
    sentAt: "2026-09-07T17:58:00.000Z",
    subject: "Board wants a one-pager",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body:
      "Can you put together a one-page summary for the board before Friday? Keep it short — " +
      "a page they will actually read, not a report nobody gets through.",
  }),
];

const EMAIL_DAY = {
  channel: "email" as const,
  account: "name-at-example-com",
  address: "name@example.com",
  date: "2026-09-07",
  nonce: "e2efixturenonceone",
  now: "2026-09-07T18:04:11.221Z",
  events: EMAIL_DAY_EVENTS,
};

const EMAIL_DAY_EARLIER = {
  ...EMAIL_DAY,
  date: "2026-09-05",
  events: [
    commsMessage({
      messageId: "<early@mail.example.net>",
      threadId: "thread-early",
      sentAt: "2026-09-05T08:00:00.000Z",
      subject: "Save the date",
      from: { name: "Bea Lindqvist", address: "bea@example.net" },
      body: "Save September 7th for the LTN 2026 kickoff.",
    }),
  ],
};

const GOOGLE_CHAT_DAY = {
  channel: "google-chat" as const,
  date: "2026-09-06",
  nonce: "e2efixturenoncetwo",
  now: "2026-09-06T20:00:00.000Z",
  events: [
    commsMessage({
      channel: "google-chat",
      account: "",
      messageId: "<gc-1>",
      threadId: "gc-thread-1",
      sentAt: "2026-09-06T14:00:00.000Z",
      subject: "",
      from: { name: "Bea Lindqvist" },
      body: "Anyone free to help load in Saturday morning?",
    }),
    commsMessage({
      channel: "google-chat",
      account: "",
      messageId: "<gc-2>",
      threadId: "gc-thread-1",
      sentAt: "2026-09-06T14:05:00.000Z",
      subject: "",
      from: { name: "Adam Okonkwo" },
      body: "Yep, I'm in.",
    }),
  ],
};

/**
 * The message a contact's activity link points at, in `renderContactNote`'s
 * own words. `apps/mobile/e2e/webkit`'s anchor-scroll case locates this
 * message by its **visible subject** rather than importing this hash, so it
 * is asserting what a person actually sees rather than an internal value —
 * see that spec's own comment.
 */
const BOARD_MESSAGE_ANCHOR = messageAnchor(EMAIL_DAY_EVENTS[5]!);

const EMAIL_DAY_PATH = channelDayNotePath({
  channel: "email",
  account: "name-at-example-com",
  date: "2026-09-07",
});
const EMAIL_DAY_EARLIER_PATH = channelDayNotePath({
  channel: "email",
  account: "name-at-example-com",
  date: "2026-09-05",
});
const GOOGLE_CHAT_DAY_PATH = channelDayNotePath({ channel: "google-chat", date: "2026-09-06" });

const ADAM_CONTACT = {
  name: "Adam Okonkwo",
  organization: "Public Worship",
  identifiers: [{ kind: "email", value: "adam@example.net" }],
  activity: [
    {
      date: "2026-09-07",
      channel: "email",
      path: EMAIL_DAY_PATH,
      anchor: BOARD_MESSAGE_ANCHOR,
      label: "Board wants a one-pager",
    },
  ],
  notes: "Production lead for LTN 2026.",
  now: "2026-09-07T18:04:11.221Z",
};
const ADAM_CONTACT_SLUG = contactSlug(ADAM_CONTACT.name);
const ADAM_CONTACT_PATH = contactNotePath(ADAM_CONTACT_SLUG);

const COMMS_LISTINGS: Record<string, FolderListing> = {
  "0-inbox/email": listing("0-inbox/email", "private", [
    folder("0-inbox/email/name-at-example-com", "private"),
  ]),
  "0-inbox/email/name-at-example-com": listing(
    "0-inbox/email/name-at-example-com",
    "private",
    [file(EMAIL_DAY_EARLIER_PATH), file(EMAIL_DAY_PATH)],
  ),
  "0-inbox/google-chat": listing("0-inbox/google-chat", "private", [file(GOOGLE_CHAT_DAY_PATH)]),
  "0-inbox/contacts": listing("0-inbox/contacts", "private", [
    file(ADAM_CONTACT_PATH, { updatedAt: Date.parse(ADAM_CONTACT.now) }),
  ]),
};

const COMMS_NOTES: Record<string, string> = {
  [EMAIL_DAY_PATH]: renderChannelDayNote(EMAIL_DAY),
  [EMAIL_DAY_EARLIER_PATH]: renderChannelDayNote(EMAIL_DAY_EARLIER),
  [GOOGLE_CHAT_DAY_PATH]: renderChannelDayNote(GOOGLE_CHAT_DAY),
  [ADAM_CONTACT_PATH]: renderContactNote(ADAM_CONTACT),
};

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
      folder("0-inbox/email", "private"),
      folder("0-inbox/google-chat", "private"),
      folder("0-inbox/contacts", "private"),
    ]),
    ...COMMS_LISTINGS,
    "1-projects": listing("1-projects", "team", [
      teamFile("1-projects/context-lc.md"),
      teamFile("1-projects/dc-chapter.md"),
      exception("1-projects/ltn-2026-rider.md", "private", "team"),
    ]),
    "2-areas": listing("2-areas", "private", [
      folder("2-areas/public-worship", "team"),
      folder("2-areas/supa-media", "private"),
      file("2-areas/architecture-map.md"),
      file("2-areas/weekly-review.md"),
    ]),
    "2-areas/public-worship": listing("2-areas/public-worship", "team", [
      teamFile("2-areas/public-worship/org-chart.md"),
      exception("2-areas/public-worship/board-notes.md", "private", "team"),
    ]),
    "3-resources": listing("3-resources", "private", [
      file("3-resources/doxology-framework.md"),
      file("3-resources/matthew-13-soil.md"),
      folder("3-resources/books", "private"),
    ]),
    /*
      Four folders deep — past the old `MAX_FOLDER_CRUMBS` cap — so the demo
      console itself is real evidence that nothing elides any more. It is the
      exact path `crumbs.ts`'s header and `docs/decisions/app-and-console.md`
      measured against a browser when the cap and the character budget still
      existed; `scripts/ux-audit-shots.ts`'s "deep-path" shot is what
      photographs it now.
    */
    "3-resources/books": listing("3-resources/books", "private", [
      folder("3-resources/books/reading-notes", "private"),
    ]),
    "3-resources/books/reading-notes": listing("3-resources/books/reading-notes", "private", [
      folder("3-resources/books/reading-notes/2026", "private"),
    ]),
    "3-resources/books/reading-notes/2026": listing(
      "3-resources/books/reading-notes/2026",
      "private",
      [file("3-resources/books/reading-notes/2026/the-lean-startup.md")],
    ),
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
    /*
      THE PARAGRAPHS HERE ARE ONE LINE EACH, AND THAT IS THE POINT.

      This note is `defaultSelection` — it is what the console opens on, what
      the e2e fixture shows first, and what every screenshot of the editor has
      ever contained. It used to be hard-wrapped at about fifty characters, so
      the demo text *appeared* to wrap at a comfortable width on a wide screen
      while the layout was doing nothing at all: measured in Chromium at
      1440x900, the element holding the first sentence was 1160px wide with
      `max-width: none` on every ancestor. A reader saw a tidy column; a real
      note, written the way people write them, ran to about 150 characters a
      line. Pre-wrapped demo data hid that from every visual check there was,
      which is why it survived — `--lp-measure`, in `LiveEditor.web.tsx` and in
      `files/webview/styles.ts`, is the fix, and this note is how it is seen.

      So the wording is a persona's and the line breaks are the browser's. Do
      not re-wrap this.
    */
    "1-projects/context-lc.md": [
      "---",
      "updated: 2026-08-26",
      "status: active",
      "---",
      "",
      "# Context.LC — build decisions",
      "",
      "Tenancy is bucket-level, never prefix-level. No key namespacing inside a customer bucket, so an existing workspace connects with zero migration and Obsidian Remotely Save keeps working.",
      "",
      "A shared context is just a workspace with more than one member — so a storage binding hangs off a workspaceId, never a userId.",
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
    /*
      The note `apps/mobile/e2e/webkit/htmlPreview.spec.ts` renders, and the
      only fixture in this file whose content is chosen by an attacker rather
      than by a persona.

      It carries three things on purpose:

       - an `html-preview` fence holding a small version of the real
         architecture diagram, so "the diagram draws" is measurable;
       - a `<script>` inside that fence which sets `window.PWNED`. **Anyone can
         email `<name>@context.lc`**, so this is exactly what a note written by
         a stranger looks like, and the WebKit suite asserts the global is
         still undefined after the frame has loaded. A bare `sandbox` attribute
         is what makes that true, and jsdom cannot prove it — it does not
         enforce iframe sandboxing at all;
       - a plain ```` ```html ```` fence below it, which must stay a code block.
         Opting in is the whole convention.

      The `<script>` is inert everywhere this file is read: it is inside a
      fenced code block in a string in a TypeScript module, and the only thing
      that ever renders it is a frame that cannot run code.
    */
    "2-areas/architecture-map.md": [
      "# Where the notes actually live",
      "",
      "Three zones, and only one of them holds a note.",
      "",
      "```html-preview",
      "<script>window.PWNED = 1</script>",
      "<style>",
      ".zmap{--ink:#17171B;--ln:#B9B9B2;--ht:#B0740B;font-family:system-ui,sans-serif;",
      "display:grid;grid-template-columns:1fr 96px;color:var(--ink)}",
      ".zmap .stk{grid-column:1;display:flex;flex-direction:column;gap:8px}",
      ".zmap .bd{border:1.5px solid var(--bc);background:var(--bg);border-radius:12px;padding:10px 12px}",
      ".zmap .bd h3{font-size:13px;margin:0;color:var(--bi)}",
      ".zmap .bd p{font-family:ui-monospace,monospace;font-size:11px;margin:2px 0 0;color:var(--bi);opacity:.72}",
      ".zmap .c1{--bc:#3B5BA5;--bg:#EDF1FA;--bi:#1E3266}",
      ".zmap .c2{--bc:#6D4AA6;--bg:#F3EEFB;--bi:#3E2A63}",
      ".zmap .c3{--bc:#2E6B4F;--bg:#E9F3ED;--bi:#1C4732}",
      ".zmap .rail{grid-column:2;position:relative}",
      ".zmap .rail .br{position:absolute;top:16px;bottom:22px;left:6px;right:20px;",
      "border:3px solid var(--ht);border-left:none;border-radius:0 14px 14px 0}",
      "</style>",
      '<div class="zmap">',
      '  <div class="stk">',
      '    <div class="bd c1"><h3>CLOUDFLARE</h3><p>stateless - stores nothing</p></div>',
      '    <div class="bd c2"><h3>CONVEX - the directory</h3><p>metadata only - never note content</p></div>',
      '    <div class="bd c3"><h3>THE FILES</h3><p>one bucket per workspace</p></div>',
      "  </div>",
      '  <div class="rail"><div class="br"></div></div>',
      "</div>",
      "```",
      "",
      "The block above is a diagram. The block below is a quotation, and stays",
      "one:",
      "",
      "```html",
      "<div>quoted, never drawn</div>",
      "```",
      "",
    ].join("\n"),
    // Carries a wikilink, a checked and an unchecked task, and a plain bullet
    // long enough to wrap at 390pt — the constructs `apps/mobile/e2e/webkit`
    // drives real touch events against.
    "2-areas/weekly-review.md": [
      "# Weekly review",
      "",
      "Friday. Empty 0-inbox, move anything that has become work into",
      "1-projects, and ask of every project: is this still the thing?",
      "",
      "- [ ] Reply to [[1-projects/context-lc.md]] about the rider",
      "- [x] Send the Sunday recap",
      "- Keep this list short enough to actually run through before the next Friday, because a list nobody rereads is not a review",
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
    "3-resources/books/reading-notes/2026/the-lean-startup.md": [
      "# The Lean Startup",
      "",
      "Build-measure-learn as a loop rather than three separate phases —",
      "the point is the cycle time, not any one step done well.",
      "",
    ].join("\n"),
    ...COMMS_NOTES,
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
  readOnlyReason: "This is a demo. Sign in to edit your own workspace.",
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
      "You are seeing this workspace with **team** access, which is why it",
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
    "You have team access to this workspace. Anything LK keeps private is not listed here at all — that is the privacy model, not a loading state.",
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
      "Six people can read this workspace. Everything in it is team by",
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
  readOnlyReason: "This is a demo. Sign in to edit your own workspace.",
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
 * PLACEHOLDER — the demo's ingestion rules, one set per **personal** context.
 *
 * Replaced by the same `getIngestionSettings` call as everything else. These
 * exist so the landing page shows the two shapes the control actually has — a
 * single address, and a whole domain — instead of an empty list that would read
 * as "this does nothing".
 *
 * `pw` is absent, and that absence is the point: a shared context has no capture
 * address, so there is no policy to mock up. It used to have an entry here, and
 * the demo showed a team an inbox it would never have. See
 * `ingestion/settings.ts`.
 */
export const DEMO_INGESTION: Record<string, IngestionSettings> = {
  seyi: {
    address: "seyi@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: ["seyi@publicworship.life"],
    allowedDomains: [],
    allowAnySender: false,
    attachmentPolicy: "store",
    maxAttachmentBytes: 2_000_000,
  },
  lk: {
    address: "lk@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: [],
    allowedDomains: ["publicworship.life"],
    allowAnySender: false,
    attachmentPolicy: "list",
    maxAttachmentBytes: 2_000_000,
  },
};
