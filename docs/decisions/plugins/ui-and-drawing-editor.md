# Plugins — UI and the drawing editor

## A plugin's UI reaches the console as text, never as DOM

The status bar is the first piece of plugin interface Context draws, and it set
the shape for the rest: **the guest reports what an element says, and the
console draws that with its own components in its own theme.** The element never
crosses. A plugin therefore cannot style, size, position or script anything on
the trusted side, and the sandbox stays the only place its markup exists — the
same boundary the view conditions draw, arrived at from the other side.

Two rules come with it and apply to whatever is drawn next:

- **State is sent whole, not as a diff.** The guest reports its entire status
  bar on every change, so there is no removal message that a guest torn down
  mid-render could fail to send, and the console's copy cannot drift from the
  guest's. A plugin that empties its status bar sends an empty list.
- **Bounds are enforced on the trusted side too.** The guest stops at eight
  items and collapses each to a single line; the host truncates and re-bounds
  whatever arrives anyway, because a cap the untrusted half applies to itself is
  not a cap.

And it is labelled. This is the first third-party text in the console, and a
reader who takes a plugin's "412 words" for something Context measured has been
misled by the frame it was put in rather than by the plugin.

## The drawing editor is a page, because a dynamic import is not a lazy chunk

Drawings became editable by embedding the real Excalidraw — the only way to be
sure a drawing made here is one Excalidraw and Obsidian open unchanged, since
anything we wrote ourselves would author a subset and diverge the first time
upstream shipped a feature.

The obvious way to carry that cost is a dynamic `import()`, on the reasoning
that it produces a chunk fetched on demand. **Measured, under Expo's Metro, it
does not.** `expo export --platform web` put the editor in a `__common` chunk
that `index.html` loads with a plain blocking `<script src>`:

| | total web JS | eager |
|---|---|---|
| before | 5.7MB | entry only |
| `import()` inside the console | **14.6MB** | entry + a 5.1MB `__common` |
| editor as its own page | 5.7MB | entry only |

Nine megabytes on every console page load, for a feature most sessions never
open. The numbers are here rather than in a commit message because the next
person to reach for `import()` will reach for it for the same good reason.

So `apps/mobile/drawing-editor/` is built separately by
`scripts/build-drawing-editor.mjs` into `public/drawing-assets/editor/` and
loaded in an `<iframe>` on web and a `WebView` on native. The console's bundle
is unchanged; the editor (8MB, 2.4MB gzipped) is fetched the first time somebody
opens a drawing.

**It also made the native half exist.** The first attempt had phones showing a
read-only view with an apology, because folding Excalidraw into
`bundle.generated.ts` — committed, shipped over the air to every phone on every
update — was rightly unthinkable. One page, loaded from the console's own
origin, serves both platforms. The honest cost is that *editing* on a phone
needs network; reading does not, because `DrawingView` renders from the file the
console already holds.

### The page never sees the customer's Markdown

Elements go in, elements come back, and `serializeDrawing` splices them into the
original bytes on the console side. So the editor cannot produce a file body at
all — which means neither a bug in it nor anything that manages to talk to that
frame can corrupt one. `postMessage` is a channel anything on the page can post
to, so `drawingBridge.ts` checks the origin of every message before reading it,
checks a channel name, and requires `elements` to be an array; the iframe's
sandbox allows scripts and same-origin and withholds navigation, popups, forms
and downloads.

### Fonts are served from our own origin, and that is not a preference

Excalidraw does not *choose* between our fonts and a CDN. It appends
`ASSETS_FALLBACK_URL` — a URL on **esm.sh** — to the `src` list of every
`FontFace` it registers, unconditionally, and the browser walks that list in
order. The third party is not reached only for as long as the URL in front of it
works, which makes this a fallback that fires on a bug rather than a setting
that can be turned off. And the request goes out at the moment somebody opens
their own private drawing, from a page whose URL identifies this product. The
share renderer already refuses the same thing in different clothes: "a remote
image in a shared note is a tracking pixel that reports every read to whoever
wrote it". A font is that request with a different extension.

The build copies the font files next to the bundle and the page points
`window.EXCALIDRAW_ASSET_PATH` at the directory it was itself served from,
resolved at load time, so a self-hosted deployment serves its own.

**Not `"./"`, which is what this shipped as and what it looks like it should
be.** `FontFace.normalizeBaseUrl` rewrites any value beginning `./` or `/` as
`new URL(value, location.origin)` — against the origin, not the page — so `"./"`
became the origin root, every scene font resolved to `/fonts/<Family>/…` where
nothing is served, and the browser did exactly what the `src` list told it to
and fetched from esm.sh. An absolute URL passes through that normalization
untouched.

The bug survived a manual check at the time because it is silent from both
sides. The canvas still draws, in a fallback serif nobody had a reference for,
and the editor's *interface* font comes from `editor.css`, whose `url()`
resolves against the stylesheet and is same-origin whatever the asset path says
— so "the page loaded fonts from us" was true, of the wrong fonts. Watching the
network panel and seeing our own origin is not the same as seeing the drawing's
font come from it.

`e2e/webkit/drawingFonts.spec.ts` replaces that check and is built around the
same trap: it draws a scene in a named family, requires *that* family to have
been fetched from the editor's own directory and to have reached `loaded` rather
than `error`, and only then asserts that nothing went off-origin at all. Five
sabotages were measured against it — the `"./"` bug itself, the assignment
deleted, the path pointed at the CDN, the family dropped from the build, and an
unrelated off-origin resource added to the page — and each fails it on the
assertion meant for it.

`Xiaolai` is excluded: 13MB on its own, more than the rest of the editor
together, for Chinese handwriting. A drawing using it falls back to a system
font here and still renders correctly in Excalidraw and Obsidian.

### What this costs, stated plainly

`@excalidraw/excalidraw` brings about thirty runtime dependencies and some two
hundred transitively into a repository whose gateway is dependency-free by rule.
None of it reaches the gateway or the console bundle — it is confined to one
built page — but it is a real supply-chain surface in a public repository, and
the version is pinned exactly rather than ranged for that reason.

## A drawing is named by its file, never by `# Excalidraw Data`

`noteHeading` names a note in three rungs — the frontmatter's `title`, the
body's opening `# Heading`, then the filename — and the middle one is a trap for
this format. Every `.excalidraw.md` the plugin has ever written opens with
`# Excalidraw Data`, the container heading for the sections beneath it, so the
rung meant to catch a document naming itself caught the plugin's scaffolding
instead: the breadcrumb, the tab and the inline title all read **Excalidraw
Data**, for every drawing in every context.

It is not even a heading the reader can see. A drawing opens in `DrawingView`
or the editor page, so the Markdown half is never on screen — the collision the
middle rung exists to avoid (a title above the same `# H1`) cannot happen here,
and suppressing the title on account of it left a drawing with no name anywhere.

So a drawing skips that rung entirely and is named from its path. The trim is
`drawingName`, not a `.md` strip, because a drawing carries **two** extensions:
`plan.excalidraw.md` is a file called `plan`, and the older trim left
`plan.excalidraw` in the band. One function does it for the title, the
breadcrumb leaf and the tab label, so the three cannot come to disagree about
what a file is called — and the tab strip's collision test runs on the same
name, so `plan.md` and `plan.excalidraw.md` open as two tabs that say which is
which rather than two that look identical.

The frontmatter rung above is untouched. A `title:` somebody typed still wins,
for a drawing exactly as for a note.

**What a simplification costs.** Dropping the drawing branch restores
"Excalidraw Data" as the name of every drawing. Replacing `drawingName` with a
`.md` trim restores `plan.excalidraw`. `frontmatter.test.ts`,
`breadcrumbPath.test.ts` and `fileTabs.test.ts` fail respectively.

## A bare `%%` ends a section, and that rule has one definition

The plugin writes `%%` on its own line to hide the payload from Obsidian.
`textElementsSpan` — the span `serialize.js` splices somebody's labels over —
has always stopped there. `splitSections`, which decides what a label *is*,
stopped only at a heading, so for a drawing with no `Element Links` and no
`Embedded Files` (any drawing whose shapes point at nothing, which is most of
them) the `%%` directly after the last label was read as one more label.

It surfaced wherever labels are shown rather than counted: a `%%` in a
drawing's label list, a `%%` term in the index for every drawing, and a `%%`
in the description of an *unreadable* drawing — the one case those Markdown
labels exist for, so the defect was loudest exactly where the fallback matters.

The reader and the writer disagreeing about where a drawing's labels end is the
failure `textElementsSpan`'s own comment refuses ("two copies of a span
calculation are two chances for the reader and the writer to disagree"), so the
`%%` rule is now one string used by both. It is a **line**, never an
occurrence: `100%% off ^id` is somebody's label.

**What a simplification costs.** Inlining the pattern in either place lets the
two drift again; dropping it from `splitSections` restores the phantom label.
`packages/drawings/test/test.mjs` group (10) fails — three checks, plus one that
pins that `%%` inside a label is still text.

## A file that does not exist yet is scaffolded, once, and edited ever after

`serialize.js` refuses to build a drawing from a template, and its header is
right about why: it rewrites bytes somebody's bucket holds, and a regenerating
serializer drops the frontmatter, the plugin's warning line, `Element Links`,
`Embedded Files`, a heading somebody added, the trailing newline, even CRLF.

That header carried a second sentence which went further than the argument
supported: that a new drawing is created by the editor that owns the format,
and this package only edits what comes back. Nobody had priced it. It meant the
console could offer **no** New drawing at all, so starting a diagram required
installing Obsidian and its Excalidraw plugin, in a product that renders and
edits drawings natively on the web and on a phone. The feature read as "we
support Obsidian's format" when the true statement is that we support drawings
and keep Obsidian's format so files move both ways.

So the rule is narrowed rather than dropped. **An existing file is edited, never
regenerated. A file that does not exist yet is scaffolded once, in
`scaffold.js`, and every change after that goes back through
`serializeDrawing`.**

The risk the old rule guarded against was two producers of one format that
disagree. That is answered by writing what the plugin writes rather than by
writing nothing: the frontmatter key, the `# Excalidraw Data` container, the
`## Text Elements` section and the `%%` wrapper are the plugin's, and the
warning line is copied character for character from a real file rather than
composed. If the plugin later reworded it, a file we scaffolded keeps the old
wording until Obsidian next saves it, which rewrites the line itself. That is
the whole of the drift and it is cosmetic.

The payload is `compressed-json` because that is the plugin's default, so a
drawing this product created is indistinguishable from one Obsidian created,
sitting in the same folder. An empty scene would read better as plain `json`
and that is the wrong reason to choose it.

**The seed is chosen by the path, not by which control was pressed.**
`createNote` writes `# name` for a note and a scaffold for a `.excalidraw.md`
name, so the toolbar, the phone's `+`, and a folder row's menu all reach the
same file. Before this, typing `plan.excalidraw` into New note produced a note
the gateway then refused, because `toolWriteNote` requires a write to a drawing
path to carry a payload. The dead end and the missing feature were one bug.

New drawing is a row in the create chooser and an item in the folder menu, and
deliberately **not** a fifth button in the explorer's toolbar. That toolbar's own
comment refuses permanent chrome for anything short of the controls somebody
uses every day, and the icon set holds only marks that have a caller.

**What a simplification costs.** Deleting `scaffold.js` puts drawing creation
back inside Obsidian. Moving it into `serialize.js` puts a template next to the
splice and invites the next person to reach for it when editing.
`packages/drawings/test/test.mjs` group (11) and three checks in
`apps/mobile/__tests__/fileBrowserGuards.test.ts` fail.

## The editor is cached by a worker scoped to its own directory

Shipping the drawing editor as a page rather than as part of the console was
measured and is not in question: importing it took the console's web JavaScript
from 5.7MB to 14.6MB **on every page load**, for a feature most sessions never
open. The cost stated at the time was that editing a drawing needed a network.
A drawing still rendered offline, because `DrawingView` draws from the file the
console already holds, so losing connectivity cost the editor rather than the
content.

The obvious answer to that is to bundle it after all, on the grounds that 8MB
is not much. It is not 8MB idle: it is 14.6MB of blocking script on every page
load, for everybody, including the people who never open a drawing. Caching the
page that already exists gets the same outcome and changes the console's
page-load size by nothing.

**Scope is the whole design.** A worker's scope is the directory it is served
from, so this one is emitted beside the editor at
`/drawing-assets/editor/sw.js` and controls that directory and nothing else. A
worker at the origin root would sit in front of every console request, and a
bug in it would serve a stale app shell to people who never open a drawing.
Confined, the worst it can do is serve a stale editor. It is registered from
`DrawingEditor.web.tsx` rather than at app start, so the load that pays for the
2.4MB is the load that caches it.

**Stale while revalidate, because the filenames are not hashed.** `editor.js`
and `editor.css` keep their names across deploys, so cache-first with no
refresh would pin somebody to the version they first opened. Every response is
served from the cache and refetched behind it. The one-version lag is safe here
and would not be in the console: the page and its bundle always deploy
together, and what crosses between them is a versioned protocol
(`context.drawing.v1`), so a console that has moved on can tell rather than
guess.

**No precache manifest.** The build emits a page, a bundle, a stylesheet and a
directory of fonts whose names change when the font list does. A manifest is a
second list to keep in step, which is the failure `bundle.generated.ts` needs a
whole CI job to prevent. Caching what was actually fetched needs no list.

**Native is deliberately not done this way, and is not done yet.** A phone has
no service worker, and the `WebView`'s HTTP cache is off on purpose:
`DrawingEditor.tsx` passes `incognito`, so nothing the page touches outlives
the view in a shared web store. Under `incognito`, `cacheEnabled` and Android's
`cacheMode` do nothing, and removing `incognito` to get caching would also
start persisting cookies, `localStorage` and IndexedDB for that origin. That is
a privacy trade for a two-line win. The native answer is to download the
editor's files to app storage and load a `file://` copy, which keeps
`incognito`. It is not built, and the three things standing in the way are
worth writing down rather than rediscovering:

- **The page loads a module script.** `build-drawing-editor.mjs` emits
  `format: "esm"` and the page carries `<script type="module">`. A module
  script is fetched with CORS semantics and a `file://` page has an opaque
  origin, so a downloaded copy may not boot at all without relaxing the
  WebView's file-access flags — which is the security surface this was
  avoiding. The clean fix is an IIFE bundle, and that changes the web path
  that is currently working.
- **The font filenames are hashed.** They come from esbuild's `file` loader,
  so nothing can enumerate them ahead of time. A downloader needs a manifest
  emitted by the build; `metafile: true` is already on, so this is small, but
  it does not exist.
The message check was the third item here and is **done**, separately and
first, for the reason it was listed at all: it needed no device, and pairing a
change to a security control with newly granted file access in one step is
what should not happen. See the section below.

Neither of the two remaining can be verified without a device or a simulator.

**What a simplification costs.** Registering the worker at the origin root, or
widening `cacheable`, puts every console request behind it. Dropping the
revalidation pins a device to one build for ever. Caching a response regardless
of `response.ok` serves a bad deploy's 404 offline permanently.
`apps/mobile/__tests__/drawingServiceWorker.test.ts` holds each, and its
sabotage record names the one that started at zero.
