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
[page covers](../privacy-and-sharing/page-covers.md). A page with no picture of
its own gets Tex's ink drawing of its topic first, and its cover is then the
wide card of its title and drawing
([page drawings](./page-drawings.md), 2026-11-03).

**What a simplification would cost.**

- *Store the page as HTML.* Loses editing in place, comments, search and the
  plain-Markdown export.
- *Draw the page in the app's own document, or with `allow-same-origin`.* A
  page's code box would run with the signed-in session.
- *Let the frame write the note.* Any page could rewrite its own front matter,
  comments or another note.

**On a phone** (owner, 2026-11-10: pages should "open up seamlessly"), the
app draws a page in a web view with the same runtime (`PageView.tsx`), loaded
from the console's own origin and never the sites domain, whose other paths
are a customer's website. A web view has no parent frame to check, so the
view puts a random key in the page's main frame before it runs; the runtime
deletes it from `window` and signs every message with it, and the app drops
anything unsigned. A box frame may reach the bridge (Android gives it to
every frame) but never the key, and only the app can call the runtime's
`__contextPageFromApp`. What a signed message asks then goes through the same
`answerPage` checks as on web. The view loads that page and its box page and
nothing else; links open outside it. Offline, the page shows as its
Markdown. Tests: `apps/mobile/__tests__/pageNative.test.ts`.

**Not built yet.** Publishing a page as a website page.

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
- **A note they already have is never made a page, moved or archived
  unasked** (owner, 2026-10-30: "why was my note completely overwritten,
  archived and replaced with this ugly page?"). Their chapter note Joshua 1
  was archived and `Joshua 1.page.md` put in its place. The page floor read
  "created" from the write's activity hint, a texting wrapper's spread had
  dropped it, and the fallback counted any write with no etag as new, so an
  overwrite of their note was sent back with "write it as a page, then
  archive the plain note". Now: the hint is enumerable and survives a spread,
  a write with no hint is a change, never new (`noteWrite`); a new plain note
  in a folder of their plain notes follows its neighbours (`amongPlainNotes`)
  unless they asked for a page; and a texted or group turn's dispatcher
  (`agent/theirNotes.js`) answers, instead of running, an archive or move of
  a note this turn did not make unless their words ask to move, file, tidy,
  archive or the like, and a new `<name>.page.md` beside their own
  `<name>.md` unless they asked for a page. The page floor's own "archive the
  plain copy you made this turn" still runs. Tests:
  `apps/mcp/test/agentTheirNotes.test.mjs`, `agentPageNotice.test.mjs`.
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
  (AVIF) is converted (#2322) or else counts as not found, so the hunt tries the next; a bar chart of more
  than four bars or long labels lies down as rows, values as money when its
  `unit:` is a currency sign; a table of four columns or more becomes one
  card per row on a narrow page; a page's cover is checked as a cover, not as
  an answer; and on a phone a page runs to the top of the glass under the
  round ‹ and ••• alone, with no workspace notices over it. Tests:
  `apps/mcp/test/pagesPhone.test.mjs`, `apps/mobile/__tests__/pageBareChrome.test.ts`.

- **Every place swipes, and every option says where it came from** (owner,
  2026-10-28: "show more images of the different options, and have a
  swipable carousel go through, also there should be a link out to the
  website sources where we got the info"). A place's photos are a carousel
  (every photo it names, the next one peeking, dots that follow); the gateway
  hunts up to three per place, every place's first before any second, inside
  the write's ten pictures. Any option, place, price or stop with `source:`
  (or `link:`, `url:`, `site:`) links out to that site, named by its domain,
  and only ever to a web address; the skill asks for one on every option.
  Tests: `pagesPhone.test.mjs`, `pagesDesign.test.mjs` ("places").

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

### A page link opens the page

*Decided by the owner, 2026-11-10*, choosing "finish today's pages, then HTML
layouts" after an audit that started from "it's supposed to open up
seamlessly, right now it doesn't really do any of this".

**Why.** The link Tex texted for a page was the app's `/note/@slug/<path>`
link. Tapping it loaded the whole app (a 2.5 MB script, the console, the file
tree, then a redirect to the console address) before the note was asked for.
A page someone is waiting on should be on screen at once.

**What it does.** A page's link is `/p/@slug/<path>.page.md`
(`noteLinkUrl` in `apps/mcp/src/agent/noteLinks.js`; a plain note keeps
`/note/…`). For a person the router answers it with the page viewer
(`infra/router/src/pageViewer.ts`): one small page from the web export
(`apps/mobile/page-viewer/`, about 7 KB of script, built by
`scripts/build-page-frame.mjs` into `/drawing-assets/viewer/`). The viewer
asks the control plane for the note at once and draws it in the same sealed
page runtime as the app, read only, with one "Open in Context" link. A
crawler gets the note link's card for it, as before.

**Why it grants nothing.** The viewer has no session of its own and no
ticket in its address. It is on the app's own origin and reads with the
sign-in the browser already holds for the app: the stored token, refreshed
exactly as the app refreshes it and under the app's own lock
(`__convexAuthRefreshToken`), so a tab of the app and the viewer never rotate
the refresh token at once. It reads through the calls the app makes
(`names:resolveMyName`, which answers only for a member, and
`files:readNote`, which runs the note's own permission check), so it opens
exactly what the app would. The router looks nothing up for it and serves the
same bytes for every address, so it says nothing about whether a note exists.
Its CSP lets it talk to the control plane only, and frame only the page
runtime.

**Never worse than before.** Anything the viewer can't do goes to the
`/note/…` link, which is where the link went before: no sign-in in this
browser (so a signed-out guest still gets the guest page), a workspace it
isn't a member of, an encrypted note, a link to another note, a vote, a pick
or an edit. An export without the viewer (its marker missing) does the same,
at the router.

**What a simplification would cost.**

- *A bearer ticket in the link so it opens with no sign-in.* A forwarded
  text, or a group chat, would open a private page for whoever taps first;
  only a share row the owner mints may do that (non-negotiable 5).
- *Serve the page's HTML from the router.* The router would read notes, and
  a private note would leave the app's own permission path.
- *Keep `/note/…` and make the app faster.* Worth doing too, but the app has
  to load before it can ask for anything, so it can't be as fast as a page
  that asks first.

**Tests that fail if it is reversed.** `infra/router/src/worker.test.ts`
("a page link opens the page viewer": the same bytes for every page, the
marker check, a plain note to the app, the crawler's card);
`apps/mobile/__tests__/pageViewer.test.ts` (the address grammar, the app
link, the stored sign-in's keys and margin);
`apps/mcp/test/agentNoteLinks.test.mjs` ("a page's link opens the page
viewer, a plain note's the app", "a page link they text is read as the note").

### Tex draws inside a page, not only on its cover

A page can hold a Tex ink drawing anywhere in its body: a fenced `drawing`
block whose body is the same scene markup `draw_visual` takes, with an
optional caption after the word (owner, 2026-11-10: "pages were supposed to
have drawings using Tex styling"). The parser reads it with the one scene
reader (`packages/shared/src/ink/drawing.cjs`, `readScene`), and the renderer
draws it with `drawingSvg`, both inks inline, cropped to the drawing's safe
area, with the light or dark ink shown by the page's own tokens. Each
drawing's filter and pattern ids carry its own suffix, so two drawings on a
page never share a filter. A drawing that can't be read is shown as its
markup with the reason, never dropped, and the gateway refuses it at write
like any other broken block. The page skill names the block, so its stamp
changed and every agent reads it again before its next page.

What a "simplification" would cost: drawing the scene in the frame from the
markup lets a page's own script restyle Tex's ink; sharing ids makes the
second drawing reuse the first one's roughness and hatch. Tests:
`apps/mcp/test/pageInkDrawings.test.mjs`.

### Pages start from a template

A page starts from a template: a page whose parts, order and drawing are
already decided, with gaps for the facts (owner, 2026-11-10: pages "were
supposed to have templates"). Six are built in
(`packages/shared/src/pages/templates.cjs`): decision, research brief, plan,
status, review, and trip or event. The page skill names them, and
`orient about: "template <name>"` hands one out with the current stamp, so an
agent decides the facts and not the layout. A gap is `[in brackets]` and an
unknown `?`; where a block needs a number to draw, the template holds a 0 to
replace, so every template is itself a page that draws.

A person's own templates come first: `.page.md` notes in `tex/templates/` in
their personal workspace, and in a shared workspace's `templates/`, which
everyone there gets. "Keep this as a template" is a copy written there with
the facts of the one case turned back into gaps. They are ordinary notes, so
they are edited, shared and exported like any other, and no new store or
setting holds them.

What a "simplification" would cost: templates the gateway keeps somewhere
other than notes can't be edited or taken away; templates that don't draw
teach agents broken blocks. Tests: `apps/mcp/test/pageTemplates.test.mjs`.

### Work Tex shows is a page, and the Tex page lists them

Work Tex looked up for someone is a page, not a text (owner, 2026-11-10:
pages are "the default for all work output done through Tex that would be
shown to the user"). A new note was already a page (`pageNotice.js`) and a
job already delivered one; what still came back as bubbles was a turn that
searched, opened sites or browsed and texted its findings. Such an answer,
over 110 words or four list lines of findings, is sent back once to be a
page from a template, with one line and the link texted
(`apps/mcp/src/agent/workPage.js`). A quick answer stays a text, and so does
a turn that only read their notes, already made a page or picture, wrote
words to copy, or was asked for as a text.

The Tex page lists them: under Pages, every `.page.md` the chat's turns and
jobs wrote, newest first, each once, read from the chat's own ledger
(`view: "pages"`, `http/texPage/pages.js`), each opening in the app. Nothing
new is kept; a page the reader can no longer open says so, as its link would.

What a "simplification" would cost: counting only sentences, as the wordy
check does, lets a list of findings through as the short form; keeping a
separate list of pages drifts from the notes. Tests:
`apps/mcp/test/agentWorkPage.test.mjs`, `apps/mcp/test/texPagePages.test.mjs`,
`apps/mobile/__tests__/texPagesRead.test.ts`.

### A page can have a layout of its own

For work that needs to look designed, a page can carry its own HTML and CSS
(owner, 2026-11-10: pages "extensible enough for custom Ui using html css",
"similar to instinct", whose roast set numbered findings beside exhibits in
an editorial grid). A ```` ```layout ```` fence holds the HTML, and each
`data-from` in it names a part the runtime puts there: `cover` (the title,
opening line, cover and anything before the first `##`), a `##` section by
its heading (case and spacing ignored), or `rest`. The words stay in the
note as Markdown, so editing, comments, search, export and covers all work
as before; delete the fence and the page reads as it did. A section the
layout doesn't place goes into `rest`, or after the layout, and an unplaced
cover before it: a layout never hides a word.

It is checked twice. At write, `packages/shared/src/pages/layout.cjs`
refuses, with what to fix, anything that runs, loads, embeds, submits or
names an address (script, frames, forms, svg, `on...=`, `src=`/`href=`,
`javascript:`, `@import`, `url(`), a slot that names no section, a layout
that places nothing, and a second layout. In the frame,
`apps/mobile/page-frame/layout.js` reads it with `DOMParser` and keeps only
an allow-list of elements and attributes (no ids, no `data-*` but
`data-from`, so it can't pose as the runtime's own markers), and its
`<style>` joins the page's stylesheet only if it loads nothing; the frame's
CSP loads nothing anyway. A layout with problems is left out and the page
draws as it would without one. Pictures and drawings in any page enlarge to
the frame's width when tapped.

What a "simplification" would cost: letting the layout hold words splits a
page's text between Markdown and HTML, and edits, comments and export lose
the half in HTML; trusting the write check alone lets a layout written past
the gateway (an old version, a synced file) run in the frame. Tests:
`apps/mcp/test/pageLayouts.test.mjs`, `apps/mobile/__tests__/pageLayout.test.ts`.

### A page always has a picture, and its people and links show

Owner, 2026-11-10, on a background job's page of new NYC churches: "no
photos of church logos, no photos of the lead pastors, no buildings, WE NEED
TO MAKE VISUAL PAGES", and "there are no hyperlinks either". The job put the
churches in a timeline and their pastors in a people block, which no photo
hunt read; it skipped the cover call as "optional", so the page got no
drawing; and its sources were bare addresses, drawn as words.

- A turn that saves a page with no picture of any kind (no cover photo, no
  option's or person's photo, no image, no map, no drawing) and makes no
  cover call after it is sent back once to make one
  (`apps/mcp/src/agent/pageCoverFloor.js`, a reply check). The cover call
  draws the picture (`visuals/pageDrawing.js`), so the floor is code, not
  the reviewer's judgement or the model's choice.
- The page-photo hunt reads people (searched by name with their role, so it
  finds that person) and timeline rows that name something (two capitalised
  words, or a `source:`), after the options, within the write's ten
  pictures. A person shows their photo in place of initials; a row shows a
  thumbnail; both show their `source:` as a link.
- A bare `https://` address in a page's words is a link, drawn as its site
  and path, and not editable as words.
- The page skill says so: addressed things (churches, offices) are places,
  every person and row carries `source:`, and the cover call is never
  optional.

What a "simplification" would cost: leaving the cover to the prompt is what
failed; hunting people by name alone finds someone else of that name.
Tests: `apps/mcp/test/pageVisual.test.mjs`.
