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
