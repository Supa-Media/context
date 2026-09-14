# Obsidian plugins

_See `docs/decisions/README.md` for the index._

Obsidian's plugin ecosystem is the largest body of work built on top of plain
Markdown vaults, and Context's storage model means it is not somebody else's
ecosystem: **the bucket that Context serves is the vault those plugins are
already running against.** The decisions here govern how far we go towards
running them, and what we promise about the ones we do not.

### The bucket is the vault, so compatibility starts as a duty not to break things

Most Obsidian plugins already work for a Context customer, because they are
running in Obsidian over the same bucket. That reframes the first version of
"plugin support" from a feature into an obligation: the cheapest and largest
win is that Context never damages what those plugins wrote.

Concretely, and each of these is either already true or is a rule this file
makes explicit:

- **`.obsidian/` is read and never written.** It is the one part of a
  customer's bucket that belongs to another program — a plugin's settings, its
  `data.json`, the enabled list. `isPlumbing` already keeps it out of notes,
  listings, search and the note count. `src/plugins/inventory.js` adds the
  only read path in the gateway, and there is no write path anywhere.
  `reading the inventory writes nothing at all` is the check.
- **Frontmatter, `[[wikilinks]]`, block ids and unknown YAML keys round-trip.**
  Dataview, Tasks, Templater and Periodic Notes are each a *file convention*
  before they are code; a gateway that normalised frontmatter would break all
  four at once without touching a line of their JavaScript.
- **`.canvas` and `.excalidraw.md` are opaque, not malformed.** A file we do
  not parse is still a file we do not corrupt.

A "tidy-up" of any of these would be indistinguishable from a data-loss bug in
the client the customer actually uses.

### A compatibility verdict is a floor, and the code is shaped to keep it one

`src/plugins/scan.js` reads a plugin's `manifest.json` and `main.js` and returns
one of five verdicts: `runs`, `needs-approval`, `files-only`, `wont-run`,
`unknown`. It matches on **member names and module specifier strings**, because
those are the two things a minifier cannot rename — a property access has no
knowable shape at build time, and a module string is the module's identity.
Nothing is executed to produce a verdict; the check exists to run before
anything runs.

The asymmetry is the decision. `wont-run` and `needs-approval` rest on evidence
we found and can name. `runs` rests on evidence we did *not* find, which is a
weaker claim, so three paths where an absence could read as a clean bill are
routed to `unknown` instead:

1. **A bundle past the read cap.** A partial read reporting "no blockers" is
   reporting on the part it happened to reach — the note count's trap exactly,
   where a floor gets printed as a total.
2. **A bundle that assembles code or a module name at runtime.** Not a finding
   about the plugin; a statement that this method does not apply to it.
3. **A manifest that will not parse.** Nothing to attach a verdict to, and
   nothing to re-check on the next release.

The second one has a specific shape worth keeping. The obvious test — "`require(`
not followed by a quote" — passes `require("child_" + "process")`, which begins
with a quote, is not a literal module name, and is exactly how a blocked module
would be hidden from a text scan. So the argument is read to its closing
parenthesis and must be *precisely* one quoted string; concatenation included,
anything else is a module name this check cannot resolve. Reversing that turns
the strongest evasion into a clean `runs`.

`unknown` is a real state with its own screen and its own wording — "couldn't be
checked", never "refused". Rounding it up to `runs` is the failure this whole
design exists to prevent, and `a bundle using eval is never reported as running`
is the check.

### Curation changes the label and never the sandbox

`CURATED_PLUGINS` in `src/plugins/capabilities.js` holds human judgement about
specific plugins: that Context reads the format one writes (`formatSupported`),
or that a blocked call is confined to an optional feature so the rest of the
plugin runs without it (`optionalBlockers`).

**An `optionalBlockers` entry may only soften a label. It can never widen what
code is allowed to do.** The runtime still has no `child_process`; the entry
only stops us telling somebody their whole templating plugin is unavailable
because one optional command runner is. A curation file able to grant capability
would be a privilege-escalation path with a friendly name, and this one cannot
be, by construction: nothing reads it but the labelling.

Two consequences that are tested rather than asserted. Curation is keyed on the
**manifest's** id, never the folder a plugin was found in, so renaming a folder
cannot buy a softer verdict. And curation is applied *after* the `unknown`
gates, so it cannot lift an obfuscated bundle to `runs` —
`curation cannot lift an obfuscated bundle to running`.

### The refusal is the product, so its wording is a rule and not a preference

More plugins will fail this check than pass it, which makes the "won't run"
message the screen most people see. `src/plugins/report.js` is the only place
that phrases one, and it keeps four rules:

- **Name the call, not the category.** "Incompatible" is a policy nobody can
  check; `child_process` is a fact they can, and evidence that we looked.
- **Never end on the refusal.** Every plugin that cannot run here carries the
  route that does — it runs in Obsidian against the same bucket, and Context
  reads what it writes. A message with no next step is the only real failure
  state.
- **Say the check is a floor.** The footer is load-bearing, not decoration: a
  verdict from reading a bundle is weaker than one from running it.
- **Distinguish "refused" from "not checked".** An `unknown` plugin is told it
  was not read, not that it was rejected.

### One unreadable plugin costs one verdict, never the report

`readPlugin` wraps each plugin in its own `try`, and the guard is around the
whole plugin rather than only inside the two reads. It was written the other way
first — the reads catching, the caller trusting them — and a sabotage run proved
what that costs: making one read throw did not degrade one plugin's verdict, it
took down the report for the entire bucket, and did it by rejecting the suite so
that *no check reported a failure at all*.

That is the note count's bug in a new place, where one oddly named folder
suppressed a customer's total forever, and it has the same fix: each unit walked
in its own `try`. The check is
`a throwing backend never rejects the report for the whole bucket`, and it is
deliberately written to await a settled result — written the direct way, a
regression here rejects, and a rejecting suite is silent about it.

### The read path cannot be aimed

`list_plugins` takes no arguments. Every key it reads is built from a fixed
shape — `.obsidian/plugins/<folder>/manifest.json` and `.../main.js` — where
`<folder>` comes from a listing of that one prefix and nothing else.

This matters more than it looks. `.obsidian/` sits outside the privacy
manifest's reach, because it is not notes and `canSee` has nothing to say about
it. A tool that reads there and *also* accepted a caller's path would be a way
to read around the privacy engine wearing a helpful name. The safe form of such
a tool is one that cannot be pointed anywhere, and that is why the argument
schema is empty rather than optional.

### What is deliberately not built

The scan is the foundation, not the feature. Three things it stops short of, and
what each would take:

- **Running plugins (built in the first client runtime below).** This required
  an `obsidian` API shim over the storage adapter and one browser-process
  sandbox per bundle. `SUPPORTED_MEMBERS` became the shim's initial
  specification; frontend rendering of the registrations it emits remains
  follow-up work.
- **The grant model for `needs-approval`.** A plugin that reaches a host should
  be a grant like any other: scoped to declared folders and hosts, approved by
  the owner, recorded in the audit trail under its own name, revocable in one
  click. `scanBundle` already extracts the hosts a bundle names, which is the
  consent screen's content.
- **Server-side execution.** A per-workspace Node VM would run the plugins a
  browser cannot, and buys mainly Git and sync plugins that Context makes
  redundant. It is not worth hosting third-party code with network egress for
  that.

The rule that governs all three, and the reason none of them is a small step:
**a plugin must never be able to read notes another person shared into this
context.** `team` means named people the owner granted access to, and none of
them consented to somebody else's plugin. Whatever the runtime ends up being, it
is scoped below the context, not equal to it.

## Drawings: read the file, describe it, and refuse to write over it

`.excalidraw.md` was listed above as a format we do not parse and therefore
cannot corrupt. That is still the floor, and it is no longer the whole answer:
a drawing is now **read** — described in words for an agent and drawn as a
picture in the console — and still never rewritten.

The reason the floor stopped being enough is that a drawing is a `.md` file, so
every rule in the gateway already applied to it and each one was wrong in the
same way. `list_notes` showed it as an ordinary note. The indexer tokenized a
megabyte of LZ-String base64 into terms no query can produce, crowding out the
ones that can — the argument the fallback scan already makes for an encrypted
note ("matching a needle against base64 would produce hits nobody asked for"),
arriving by a different route. And `read_note` returned the whole file,
uncapped, so asking about a diagram spent a caller's entire context on a blob it
could not decode.

`packages/drawings` is the one parser, imported by the Worker by relative path
(no dependency, no build step — the `packages/meetings` arrangement) and by the
console as `@context/drawings`. One parse feeds both the description and the
render, so the words an agent is given and the picture a person sees cannot
drift into describing different drawings.

### The guard is the load-bearing half, and describing created the need for it

Returning a description introduces a failure that did not exist before it: a
client reads a note, edits a line, writes the whole thing back — and replaces
the diagram with a paragraph *about* the diagram. The only copy of those
elements was the file it just destroyed. That is the data-loss shape this
document already refuses, arriving through the gateway rather than through a
tidy-up.

So a write to a `.excalidraw.md` path must itself parse as a drawing. The test
is "does this carry a payload", not "is the caller trusted" and not "did the
caller pass a flag": a real drawing from a real editor passes it, text that only
describes one cannot, and creating a new drawing through the gateway still
works. The console enforces the same rule from the other side — `NoteEditor`
renders a drawing instead of opening it in `LiveEditor`, because an editor over
that buffer is one keystroke away from a payload nothing can decompress and a
file that still looks like a file.

### Everything degrades to "we could not read it", never to a refusal

Missing, oversized, undecodable or unrecognised payloads all parse to a drawing
with `elements: null` and whatever labels the Markdown half carried — which is
usually all of them, because the plugin writes them out as plain text precisely
so they stay searchable. The reply then says which of those happened and that
the file is untouched.

This is a deliberate ceiling on what a bug in the decoder can cost. LZ-String is
vendored (the gateway has no dependencies and cannot have one), and a vendored
decompressor is exactly the kind of code that is subtly wrong on a subset of
inputs. Every caller therefore treats a decode failure as "payload unavailable",
so the worst case is a missing preview rather than a file that will not open.

### The render is true, not hand-drawn, and that is the trade

Excalidraw's look comes from `roughjs` re-stroking every edge several times from
a seeded RNG. Reproducing it is a large amount of code whose output is *meant*
to be imprecise and which changes upstream — and it cannot run in the gateway at
all, which has no DOM. `scene.js` lays elements out as plain primitives and
`DrawingView` draws them with `react-native-svg` (already in `native-deps.json`,
so no new native dependency, and the same component on web, iOS and Android).
Hachure fills flatten to reduced-opacity solids for the same reason.

A preview that looks slightly too tidy is worth more than one that is wrong in
ways nobody can predict, and the file stays portable either way: the real
rendering is one click away in Obsidian or on excalidraw.com. **That is the
point of keeping the file plain, so the renderer is allowed to be the
approximate half.**

### What is deliberately not built

- **Editing.** The console draws a drawing; it does not change one. Authoring
  means the real Excalidraw editor — React DOM, so a lazy web chunk and a
  webview on native, deliberately *not* folded into the committed CodeMirror
  bundle that ships over the air.
- **Images inside a drawing.** Excalidraw stores those bytes in the payload's
  `files` map; they render as placeholder boxes until that is wired to the asset
  store.
- **Serving a drawing as an image over MCP.** `read_image` refuses SVG on
  purpose, and rasterising needs a renderer the Worker cannot host. An agent
  gets the description, which is the form it can actually use.

### The browser is the process boundary, and the runtime token never crosses it

The first client runtime uses one sandboxed iframe on web and one WebView on
native per loaded bundle. The web frame has `allow-scripts` and deliberately no
`allow-same-origin`; both hosts load a fixed document with a deny-by-default CSP
that blocks direct network, workers, child frames, forms, objects and external
assets. A real Chromium and WebKit check proves that plugin code cannot touch the
parent document or fetch directly.

The opaque runtime token stays in the trusted React host. The frame receives an
Obsidian shim and can send only a versioned operation with a request id. The host
adds no identity from that message: it calls `executePluginRequest` with the
token it retained, and the server resolves the workspace, plugin, reviewed
fingerprint and grant. RPC replies omit the host's sandbox nonce because plugin
code can observe events in its own realm; revealing the nonce would let it forge
the load-health messages the host records.

Start and Stop are separate from approve and revoke. Approval grants authority
to an exact bundle; Start loads it. Stop removes the frame and deletes every
bearer session without withdrawing the approval, while revoke still removes the
authority itself. A previous `loaded` state is resumed when an owner reopens the
console, tokens rotate before expiry, and three failed loads become
`crash-looped` rather than retrying forever.

The first shim covers conflict-safe vault reads and mutations, metadata, the
plugin's own settings, notices, command registration and lifecycle cleanup.
Rendering plugin-provided editor extensions, settings controls, ribbon actions
and views remains a frontend integration step; the sandbox is now the place
  those registrations come from rather than a reason they cannot be built.
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

## The message check is an identity check, not an origin check

Both halves of the editor accept a message and splice its elements into
somebody's file. Both used to gate that on an origin, and an origin was the
wrong question in a different way on each side.

**On the web the check was true and insufficient.** `event.origin` against
`window.location.origin` keeps other sites out and says nothing about *which*
of our own windows sent the message — and the editor page is served from our
own origin, so every same-origin window cleared it. The console's own included:
a `window.postMessage` from anywhere in the bundle reached the splice. The frame
is a ref the component already holds, so `event.source !==
frame.current?.contentWindow` costs nothing and asks the real question. It is
belt to the sandbox's braces rather than a replacement for it.

**On native the check was fail-open.** There is no `event.origin`, so it
distilled an origin out of `event.nativeEvent.url` with a regex and compared
that — with `?? origin` behind it, meaning a url the regex could not read was
treated as ours. `file:///…` has an empty host and matches nothing, so it took
the fallback: a page we never loaded, trusted. Nothing loads a `file://` page
there today, which is exactly why it went unnoticed, and it is the shape the
offline work above would have introduced.

`isEditorPageUrl` replaces both: compare the whole url with the page we asked
for, drop the hash and the query because a `WebView` reports what it loaded and
Excalidraw keeps view state in the hash, refuse anything with no readable host,
and compare with equality rather than `startsWith` so `…/index.html.evil` is
not the editor.

**What a simplification costs.** Dropping the `event.source` comparison lets
any same-origin window write to the open drawing. Restoring a fallback for an
unreadable url re-opens the native side. Comparing with `startsWith` accepts a
url somebody can serve. `apps/mobile/__tests__/drawingEditor.test.ts` and
`drawingBridge.test.ts` hold one each, all three sabotage-confirmed.
