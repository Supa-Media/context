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
schemes, typed punctuation).
