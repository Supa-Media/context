import { renderFile } from "@context/shared/src/activity.cjs";
// A namespace import rather than `{ DEMO_ACTIVITY }`: this file sits outside
// the demo-path allowlist `liveConsoleFacts.test.ts` checks by scanning for a
// named `import { DEMO_* }`, and this module is reachable only from
// `placeholderData.ts` (which is on that allowlist) — the same guarantee the
// named form would give, in a shape the source-scanning guard can see through.
import * as activityData from "./activity";
import { COMMS_LISTINGS, COMMS_NOTES } from "./communications";
import { type DemoContextTree, exception, file, folder, listing, privacyNote, teamFile } from "./treeHelpers";

// ── @seyi — personal, owner ──────────────────────────────────────────────────

export const SEYI_TREE: DemoContextTree = {
  listings: {
    "": listing("", "private", [
      folder("0-inbox", "private"),
      folder("1-projects", "team"),
      folder("2-areas", "private"),
      folder("3-resources", "private"),
      folder("4-archive", "private"),
      file("index.md"),
      /*
        The activity file, at the root beside the other two, because that is
        where it is in a real bucket — and because the board could not show the
        page it opens into until it was here. `ActivityPage` is the console's
        one document view nothing in a browser had ever drawn, which is how a
        column pinned to the left edge at a hard 760 shipped and was found in a
        screenshot instead of in CI.

        Private, like the real one: it names paths from every corner of a
        context, so a member is served the filtered rendering and never the
        file. `NOTE_BODIES` carries a real rendered file for it, machine
        comments and all.
      */
      file("activity.md"),
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
    /*
      The activity file, rendered from `DEMO_ACTIVITY` by the real `renderFile`
      — not a hand-drawn approximation. Built from the module so the demo
      cannot drift from the format: the fixture's first draft of the
      *indicator*'s data named notes in a folder the demo has never had, drew
      no dot, and the board reported on itself. A literal here would be the
      same mistake one level down, in a file whose whole point is that a parser
      reads it.

      The file and the console's view of it come from **one** array for the
      same reason. Two lists would be two chances for the page to show rows the
      file does not contain.
    */
    "activity.md": renderFile(activityData.DEMO_ACTIVITY),
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
    // drives real touch events against. No table: `callouts.spec.ts` types at
    // the end of this note and arrows back up into it, and a drawn table is an
    // atomic range the caret steps over. The table fixture is the org chart
    // below.
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
    /*
      THE NOTE WITH A TABLE IN IT, and it is a fixture as much as a persona's
      page. The decision log's rule is "a fixture that cannot show the thing
      under review is reporting on itself": a GFM table is drawn as a grid
      *while the note is being written* and is typed into in place, and until
      something in this tree carried one there was nowhere in the running app
      to look at that. A table somebody has to make first is not the same
      screen as a table that was already in the file.

      Here rather than in `weekly-review.md` because that note is the one the
      touch specs type into and arrow around in, and a drawn table is an atomic
      range the caret steps over. `tables.spec.ts` opens this one.

      A seat per row is also what the prose above it describes, which is the
      other half of a fixture: it has to be a page somebody would really have.
    */
    "2-areas/public-worship/org-chart.md": [
      "# Org chart",
      "",
      "Executive Director → Music, Production, Formation, Operations.",
      "Each lead holds a seat, and a seat carries duties rather than a",
      "person's name — so a handover is a change to one field.",
      "",
      "| Seat | Holder | Backup |",
      "| --- | --- | --- |",
      "| Music | **Sayo** | LK |",
      "| Production | John | LK |",
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
