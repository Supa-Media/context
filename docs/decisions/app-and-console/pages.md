# App and console — pages: `.page.md` notes drawn as pages

### A page is a Markdown note named `<name>.page.md`, with blocks and sealed code boxes

*Decided by the owner, 2026-10-27* (".page.md is great, lets do blocks and
code at the same time, i want extensibility, job results become pages and
your default suggestion for private pages"), after "people don't like to just
read text, they want a webpage really with visualizers ... all of the text and
all of the words are editable and can still be commented on, sort of like a
super markdown".

**Why.** Tex's finished work was a Markdown note, and people read it as a wall
of text. An HTML file would draw well and break everything else the product
promises about a note: its words are no longer words a person can edit in
place, comment on, search, or take away as plain Markdown
(non-negotiable 3). So a page is still a Markdown note, in four layers:

- **Words**: ordinary Markdown. Every run of text a page draws carries its
  offsets in the note, so typing over it, ticking a task or commenting on it
  changes exactly those characters in the note.
- **Blocks**: fenced data the page draws (```` ```compare Quotes ````, then
  `- Label: value | detail` items and `key: value` settings). The kinds are
  Tex's picture-card templates as data: stats, compare, chart, progress,
  timeline, steps, choose, board, people, places, versus. A `choose` block
  writes the reader's pick back as its `chosen:` line, which is how a page
  answers Tex.
- **Look**: front matter (`theme`, `accent`, `kicker`, `layout: tabs`) and
  ```` ```css ```` fences.
- **Code boxes**: ```` ```box height=N ```` holds HTML and script for what no
  block draws. This is the extensibility the owner asked for.

The format lives once, in `packages/shared/src/pages/` (CommonJS, like
`comments.cjs`), read by the gateway, the app and the page runtime.

**How it is drawn, and why it cannot reach anything.** The app draws a page in
an iframe with `sandbox="allow-scripts"` and never `allow-same-origin`, so the
frame's origin is opaque wherever it is served from. Its CSP loads nothing but
its own script (`default-src 'none'`). A code box is a second frame of the
same kind inside it, handed the page's blocks as `window.page`, with a CSP that
allows its inline script and loads nothing at all. The frame only *says* what
the reader did; the app checks every message's shape (`readPageMessage`) and
applies it against the note as it is now (`pageChange`): an edit must land
exactly on a run the page draws, a tick on a task box, a pick on an option the
block offers, and anything made against an older copy is refused. Comments are
written by `comments.cjs` as the signed-in person. So a page written by
anybody with write access can change only the words a reader sees.

**Where the runtime is served.** In production the frame is loaded from the
person's own `<handle>.ctxlc.site/_page/` (the router serves the runtime's four
static files there before any workspace lookup), a different site from
context.lc, with the deployment's own `/drawing-assets/page/` copy as the
fallback; other deployments use their own copy. The note's words never go to
that host: the app posts them into the frame. That is what "private pages
open through the app" means: a private page has no address of its own, and
publishing one stays the website's job ([websites](../websites.md)).

**Tex delivers pages.** A background job writes its result as a `.page.md`
and texts `draw_visual { template: "page" }`, the page's first screen drawn by
the same renderer, with the link. A write whose blocks cannot be drawn is
refused with the line to fix (`apps/mcp/src/pages.js`), as a broken form is;
`orient about: "pages"` is the format guide, built from the block kinds so it
cannot drift from the checks.

**One picture, then the link (owner, 2026-10-27: "Cover picture + link").**
The cover replaces the link's name card rather than joining it: a job's
answer carries its pictures to the chat (`apps/agent/src/jobTexts.ts`), they
go first, and once one went a bare note link is texted inside a sentence, so
no name card is drawn for it. A cover that would not send is skipped and the
link gets its name card as before. A job update holds at most two pictures
and 1.5 MB of them, because an update the chat's inbox did not take is kept
in the job's object until it does. Messages cannot draw a rich preview for a
link sent from an API line (Sendblue has no rich-link send), which is why
the picture is texted rather than left to the link.

A linked page's preview is the same cover, for a team link as well as a link
for anyone (owner, 2026-10-27): the gateway keeps each cover it draws in the
person's bucket and the link's card shows it. The privacy trade is in
[page covers](../privacy-and-sharing/page-covers.md).

**What a simplification would cost.**

- *Store the page as HTML.* Loses editing in place, comments, search and the
  plain-Markdown export.
- *Draw the page in the app's own document, or with `allow-same-origin`.* A
  page's code box would run with the signed-in session.
- *Let the frame write the note.* Any page could rewrite its own front matter,
  comments or another note.

**Not built yet.** The native app opens a page as text (`PageView.tsx`); the
page view is the web app's. Publishing a page as a website page.

**Tests that fail if it is reversed.** `apps/mobile/__tests__/pageHost.test.ts`
(messages, stale copies, edit ranges, frame address order);
`infra/router/src/pageFrame.test.ts` (only the runtime's files, never the
console, box framable); `apps/mcp/test/pages.test.mjs` (write refusal, guide,
job line, cover) and `apps/mcp/test/pagesFormat.test.mjs` (escaping, link
schemes, typed punctuation); `apps/agent/src/jobCovers.test.ts` (cover
first, no name card after it, a retry repeats nothing, a failed cover keeps
the card).

### Pages look designed, and an agent reads the page design skill before writing one

Decided by the owner, 2026-10-27, after the first pages shipped: "pages look so
ugly ... this is just a glorified markdown page"; then, on the round 2 artboard,
"the format and ordering etc is all good, looks like a real page, should be
responsive", with Context's own fonts rather than a serif, and "skill should be
required when making pages".

- **The look is Context's.** Instrument Sans and JetBrains Mono, the app's
  palette and indigo accent (`css.cjs`, `cssBlocks.cjs`). The sealed frame loads
  nothing, so the two faces are carried in it as `data:` (`font-src data:` in
  `PAGE_CSP`, `scripts/build-page-frame.mjs`); the texted cover links them as
  Tex's cards do. Layout answers to the page's own width (`container: pg`), so
  the same page is a phone column and a desktop spread.
- **A cover by kind** (`cover.cjs`): `kind: research` (or none) is a photo and
  the title side by side, `plan` a collage of three photos, `status` one big
  number (`number: 412 of 1,000`) with a field of a thousand dots. Under the
  title: the opening sentence, and a status pill from `status:`. Photos come
  from `cover:` or the first ones the blocks name.
- **Item fields.** Lines indented under a block item are its fields (`photo:`,
  `seats:`, facts split at `; `), each still words a reader can edit. They are
  what the richer blocks draw from (`drawRich.cjs`): `vote` (the pick, why, the
  options with photos and faces, one button that follows the pick), `places`
  (photo spreads, seats against `need:`, a fact strip; a shortlist past six),
  `prices` (one shared axis, totals from `for:`, `?` drawn as one to ask for),
  `itinerary`, `tiers` and `contacts`.
- **A vote is the signed-in person's.** The frame says which option was
  tapped; the app writes the person's own name under it (`castVote`), moving it
  off any other option. The frame never names the voter. The button decides,
  as `chosen:`, like a `choose` block.
- **Pictures are files of the note.** A page names them in fields; a write's
  `images` that match a field's name are stored and the field points at the
  stored copy (`uploadedImages.js`), so they export with the note. The cover
  reads them through the page's own note (`read_image`) and draws them in as
  bytes; it loads nothing by itself.
- **The skill is required.** `apps/mcp/src/pageSkill.js` is the page design
  skill (what goes first, which block fits which facts, hard cases, the checks
  before sending) with the format reference appended from the block kinds. It
  is what `orient about: "pages"` answers, and it ends with a stamp, a hash of
  its own text. A `.page.md` write whose front matter does not carry the
  current `skill:` stamp is refused before anything is looked up, and the
  refusal carries the whole skill and its stamp, so the refused writer has
  read it with no second call; changing the skill changes the stamp, so every
  agent reads it again. Edits made in the app are not agent writes and are
  not gated. (The first version only named `orient about: "pages"`; within
  the hour Tex in a WhatsApp group was refused, never made that call, and
  saved the research as a plain note, telling the chat pages "wouldn't save
  from this chat". The refusal also says never to fall back to a plain note.)

- **Every note Tex makes is a page** (owner, 2026-10-27: "by default every
  note that tex produces should be a page, and only ever a regular note when
  the user explicitly asks"). Asked by text for a detailed concert plan, Tex
  had saved a plain checklist: only background jobs were told to write pages.
  The texting prompt now says it (`PAGES_LINE` in `apps/mcp/src/agent/prompt.js`),
  and a texted or group turn that still creates a plain `.md` goes back once
  with the skill attached (`agent/pageNotice.js`, read by `claimCheck.js`).
  Left plain: a change to a note that already exists (an etag was passed),
  Tex's own `tex/` notes, `about-me`, `todo.md`, index pages, the inbox and
  routines, and any turn where the person asked for a plain note.
- **A page opens bare** (owner, same day: "no properties, no floating
  buttons, nothing but the page please, maybe 1 menu to hide actions"). On a
  page the note screen draws no contact header, properties or routine bar,
  the Page | Text switch is gone, and the phone's bottom bar of note actions
  and compose button is hidden. The one ••• menu holds the rest, with "Edit as
  text" / "View as page" in place of reading mode (`pageView/pageText.ts`).

- **The page is drawn for a phone first, and shows its things** (owner,
  2026-10-28, on a birthday plan with no picture, a budget chart whose
  "2000" wrapped as "200 / 0", a table off the screen and the Notes header
  and a workspace banner over it: "it literally still looks like a glorified
  markdown page"; "remove this freakin header"). The fixes live in the
  renderer and the gateway, never in the model's good behaviour: a `choose`
  block's options are hunted for photos like a vote's (and drawn with them,
  so they feed the cover); a hunted picture the note write would refuse
  (AVIF) counts as not found, so the hunt tries the next; a bar chart of more
  than four bars or long labels lies down as rows, values as money when its
  `unit:` is a currency sign; a table of four columns or more becomes one
  card per row on a narrow page; a page's cover is checked as a cover, not as
  an answer; and on a phone a page runs to the top of the glass under the
  round ‹ and ••• alone, with no workspace notices over it. Tests:
  `apps/mcp/test/pagesPhone.test.mjs`, `apps/mobile/__tests__/pageBareChrome.test.ts`.

What a "simplification" would cost: dropping the stamp check lets agents write
pages from memory of an older format, which is how the first pages came out
as styled Markdown; letting the frame name the voter lets any page's script
vote as anyone. Tests: `apps/mcp/test/pages.test.mjs` ("a page is written only
by a caller who read the page design skill"), `pagesDesign.test.mjs`, and
`apps/mobile/__tests__/pageHost.test.ts` ("a vote is cast as the signed-in
person"), `agentPageNotice.test.mjs` ("a plan saved as a plain note goes
back to be a page"), `noteActions.test.ts` ("a page swaps reading mode for Edit
as text").

Not built yet: the "N changes since you looked" line, and drawing a map from
the addresses on the server without the agent asking (the skill has the agent
draw one with `draw_visual` and keep it as `map:`).
