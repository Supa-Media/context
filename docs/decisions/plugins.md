# Plugins

_See `docs/decisions/README.md` for the index._

Two things are called a plugin here, and merging them was a decision rather
than a tidy-up (owner, 2026-09-14).

**Obsidian's** are somebody else's code in the customer's bucket. Obsidian's
plugin ecosystem is the largest body of work built on top of plain Markdown
vaults, and Context's storage model means it is not somebody else's ecosystem:
**the bucket that Context serves is the vault those plugins are already running
against.** Everything from "The bucket is the vault" down governs how far we go
towards running them, and what we promise about the ones we do not.

**Context's** are ours, and they were not called plugins at all until this
file said so. Forms, images, meetings and chat days were features of the app —
a tool in the gateway, a widget in the editor, a card in the console — with no
off switch and no row anywhere, while the word "plugin" in this product meant
Templater. That split is arbitrary from the customer's side: a person looking
for "the forms thing" and a person looking for Templater are asking the same
question of the same screen.

## A Context plugin is Obsidian's manifest with one extra key, and no bundle

`apps/mcp/src/plugins/catalog.js` declares four, in Obsidian's own manifest
shape — `id`, `name`, `version`, `minAppVersion`, `description`, `author`,
`authorUrl`, `isDesktopOnly`, spelled the way Obsidian spells them. Everything
Context needs that Obsidian has no concept of goes under a single `context`
key, which Obsidian ignores exactly as it ignores any unknown manifest key, the
same round-trip rule frontmatter already keeps here.

That is what makes "the same shape, in two places" a fact rather than a
resemblance: one renderer draws a row for a plugin from this catalogue and a row
for a plugin in `.obsidian/plugins/`, because the fields it reads are the same
fields.

**What it is not is a bundle.** Nothing in the catalogue is downloaded, stored
in a bucket, scanned, or executed. The code ships with the gateway and the
console. So a Context plugin has no verdict, no fingerprint and no grant — the
whole apparatus below exists for code we did not write, and applying it to our
own would be theatre.

**Ids carry a reserved `context-` prefix, and the prefix is a guard.**
`isReservedPluginId` refuses it to anything read out of a bucket. A vault folder
called `forms`, or a community plugin published under that id, must never be
able to present itself as the built-in one — the built-in's row carries a switch
that changes what the gateway serves, and a folder anybody can sync into a
bucket borrowing that row would be a control surface with an untrusted name on
it. Reserved is the whole prefix rather than the four ids in use, so a plugin
added later is not shadowable by a folder that predates it.

**What a simplification costs.** Dropping the prefix check lets a synced folder
take a built-in's row. Inventing a manifest shape of our own ends the one-row
claim and makes a future third-party Context plugin unpublishable to either
catalogue. `a vault folder cannot borrow a built-in id` is the check.

## The switch lives in the bucket, in two lists rather than one

`.context/plugins/enabled.json`, beside the managed installs and deliberately
not inside `.obsidian/` — which is read and never written, and this is a file
of ours.

It could have lived in the control plane. It is small, it is not note content,
and Convex already holds the plugin *grants*. It does not, and the reason is
non-negotiable #1 rather than convenience: a customer who hands their bucket to
storage of their own, or self-hosts the gateway at it, should find their context
configured the way they left it. A workspace whose forms silently come back on
after an export was partly ours. `an owner turning one off writes the decision
into the customer's bucket` asserts it against the bucket, never against a row.

**Two lists, because these default to on.** Obsidian's
`.obsidian/community-plugins.json` is a bare array of enabled ids, and the
absence of an id means off. Copying that exactly would be wrong in the one case
that matters most — a bucket that has never seen this file, which is every
bucket today. Under Obsidian's shape an empty file and a missing file both mean
*everything off*, so shipping it would turn four working features off for every
existing customer at once. So the file records **decisions** —
`{ "version": 1, "enabled": [], "disabled": ["context-meetings"] }` — and an id
nobody has decided about takes its manifest's default. An id in both lists is
not a third state to invent a rule for; it is a file edited into a
contradiction, and it makes the file malformed.

A decision about a plugin this build does not have is kept and never acted on,
so a newer console against an older gateway does not lose somebody's setting.
The rendered file is sorted and pretty-printed, because it syncs into a vault
and is opened in editors: off, on, off again produces the bytes that were there
before.

**What a simplification costs.** Moving the file into Convex ends the export
guarantee above. Adopting Obsidian's bare array turns every existing context's
plugins off on deploy. Dropping the round-trip lets a toggle rewrite a file that
was already correct. The checks are in `contextPlugins.test.mjs`.

## A switch removes a capability and never a protection

The rule the whole design rests on, and the one to check any addition against.
No guard, no privacy rule, no write refusal is part of any switch. Turning
Drawings off stops a drawing being described or rendered; it does **not** relax
the rule that a write to a `.excalidraw.md` path must itself parse as a drawing,
which is the guard standing between a careless client and somebody's only copy
of a diagram.

That is what makes the failure behaviour safe, and the failure behaviour is
uniform: absent, empty, malformed, contradictory, versioned from the future, or
a backend that threw — every one of them resolves to the manifest's default, and
the default is on. The worst that can do is hand somebody back a feature they
had hidden. The opposite failure — a storage blip disabling forms across a
shared workspace, so a member's bug report is refused with no explanation
anybody can act on — is both worse and silent. A settings file that will not
parse is *reported* on the panel, so nobody is left thinking their choice stuck.

**What a simplification costs.** Folding any guard into a switch makes a
preferences file a security control, and a preferences file is hand-editable in
Obsidian by anybody with the bucket. Failing closed turns a typo into a
workspace losing its tools. `a switch never fails closed: an unreachable file
disables nothing` is the check, sabotage-confirmed.

## The switch is enforced twice, because the listing is cached

Exactly as scope is, and for the same division of labour. `toolsForSession`
filters a disabled plugin's tools out of `tools/list`, and that is the
**courtesy**: the modern listing is `CACHEABLE` for a minute, and a client
remembers a tool name for much longer than that. `callToolForSession` refuses
the call, and that is the **control**.

Two things about where the per-call gate sits. It is **after** the argument
check, reversing the order scope uses, because it costs a storage read and the
comment above it promises that a call carrying arguments we never advertised
reaches no storage at all. And it reads the switch off the **target** store, so
a cross-context call into a workspace whose owner turned forms off is refused
with that owner's setting rather than the caller's.

The refusal names the plugin and where to turn it back on. "Unknown tool" is
what a client would otherwise report to somebody whose own setting caused it,
and it names no way back — the `report.js` rule that a refusal always carries
its next step, applied to the one refusal an owner can undo in a single press.

**What a simplification costs.** Keeping only the listing filter makes the
switch a suggestion for up to a minute, and forever for a client that caches
harder. `a Context plugin turned off takes its tools out of the listing` and
`a call to a switched-off tool is refused by name, with the way to undo it` fail
respectively; the second was deliberately merged from a weaker pair, because
`isError === true` alone passes on the broken build.

## What may never be a plugin

A feature belongs in the catalogue when turning it off removes a **capability**
and nothing else. Notes, privacy, search, audit, storage and encryption are
absent and are not candidates: a switch that can stop the privacy engine running
is not a plugin, it is a hole, and a switch that hides encrypted notes is a
switch that loses somebody's content.

`no Context plugin claims a core tool` pins the tool half of that —
`read_note`, `write_note`, `search`, `search_notes`, `orient` and `list_notes`
have no owner and cannot acquire one — and the catalogue refuses to build at all
if two plugins claim one tool, because a tool whose switch is ambiguous is on
for one reader and off for another.

## The owner authorizes a plugin over their own workspace; the workspace is the wall

Decided by the owner, 2026-09-16, and it settles a question this file had been
answering too cautiously. Plugin grants are per workspace. An owner enabling one
is saying *I authorize this code to work on my data* — which is the same trust
they already place in Context itself, and the same bargain Obsidian and every
browser extension store runs on. People are allowed to make that call about
their own notes, and a product that refuses on their behalf is not protecting
them, it is choosing for them.

**The boundary that is not theirs to waive is the next workspace along.** A
plugin enabled in one context may never read or write another, however much its
owner authorizes it — because the people in that other workspace authorized
nothing. That is non-negotiable #4 (one workspace is one security boundary)
applied to plugins, and it is enforced by construction rather than by policy: a
plugin never names a workspace. `resolveRuntimeSession` derives one from the
runtime token it was issued, so "which workspace" is not an argument any plugin
code can reach, and `a plugin's token reaches exactly one workspace` holds it.

Two things follow that are easy to get wrong.

**The permission model was never the thing in the way.** An owner can already
grant `vault:read`, `vault:write`, `vault:rename`, `vault:delete`,
`metadata:read`, `settings:read`, `settings:write` and `network:request` — full
reach over their own workspace's data. What stops a plugin like Bible Reference
is not a refused permission, it is a *surface Context has not drawn yet*. Those
are opposite problems and conflating them turns a build task into a policy
argument.

**Isolation is what makes the wall enforceable, so it is not the part to trade
away.** The sandbox is not there to second-guess the owner about their own
notes; it is there because a plugin running in the trusted page holds a session
that reaches every workspace its person belongs to, which is exactly the one
thing the owner may not authorize. Widening what a plugin may *do* in its own
workspace is a grant change. Moving it into the page is not a widening, it is
removing the wall.

**What a simplification costs.** Letting plugin code into the trusted realm
makes the cross-workspace rule unenforceable in the only place it is currently
free. Letting a plugin name its own workspace does the same, more directly.

## A base class is a load-bearing export, so the dialog was built rather than stubbed

`SuggestModal` and `FuzzySuggestModal` are answered by the shim, and the reason
they moved off `ABSENT_MEMBERS` is not that the dialog was next on a list. It is
that **a plugin extends them at module scope**: `class X extends
api.SuggestModal {}` throws `extends undefined` before `onload`, so a missing
class is not a missing feature, it is the whole plugin gone.

Bible Reference is the case. Its inline verse suggester needed nothing that was
not already built — `registerEditorSuggest` has worked end to end for weeks —
and it never got to register one, because the bundle died on a class it uses for
a *secondary* flow. One absent export cost the feature that was already working.

**Stubbing them would have been the wrong fix twice over.** An inert base class
gets the bundle loading and then silently does nothing when a reader presses the
command, which is the "present and inert" trap this same file spends a section
on. And it would have been a stub shipped in the name of a plugin that then
still did not work.

So the dialog is real, by the same inversion `registerEditorSuggest` uses:
`getSuggestions`, `renderSuggestion` and `onChooseSuggestion` run **in the
sandbox**, the guest reports the text its elements carry, the console draws its
own list, and a pick crosses back as an index. Nothing the plugin built reaches
the trusted realm — not markup, not a link, not an image.

Four consequences worth keeping:

- **The console draws the rows in the plugin's order and does not rank them.**
  This is why it is not `Palette`, which ranks a fixed array against the query:
  the plugin already decided what matches, and re-ranking would drop the answers
  whose text does not contain the query — which is most of them, since
  "Gen 1:1" does not appear in the verse it returns.
- **The dialog names the plugin that opened it.** Somebody is being asked to
  choose something by third-party code, and "who is asking" is the first
  question that deserves an answer.
- **A pick can only land on the list now on screen.** The guest replaces its
  values on every query and refuses an index past the end, for the reason the
  editor's own `offered` exists.
- **`reopened` is carried back on a pick.** `onChooseSuggestion` runs in the
  guest and may open another dialog — a two-step flow picks a translation and
  then a verse — so a console that closed unconditionally would shut the one it
  had just been asked for.

**What a simplification costs.** Exporting these as inert stubs gets a bundle
loading and leaves a command that does nothing. Ranking the rows here reorders
somebody else's answers. Letting the guest hand over an element instead of its
text puts third-party DOM in the trusted realm, which is the line this whole
area exists to hold. The checks are in `pluginSandboxGuest.test.ts` (seven,
including `a query runs the plugin's getSuggestions and only text comes back`,
sabotage-confirmed by sending `innerHTML`) and `pluginSuggestDialog.test.ts`.

### A member the shim lacks is a limitation, except when it is extended

`PLANNED_MEMBERS` always held two kinds, and `surface.js` always said so:
**inert** (reachable, accepts, does nothing — `addSettingTab`) and **absent**
(not on the shim at all — `SuggestModal`). The data did not distinguish them,
and the scanner treated both as a limitation on a row that could still read
`runs`.

That is right about a call and wrong about a base class. `class X extends
api.SuggestModal {}` evaluates `extends undefined` and throws where it stands,
so the bundle never finishes loading and **nothing** of the plugin arrives —
reported, until this, as `runs` with a "not yet" footnote under a heading that
says "everything these use, Context implements". The same asymmetry this area
already rests on, arriving one level down: `runs` rests on evidence we did not
find, and here the evidence was found and filed as a footnote.

So the map is two maps, `INERT_MEMBERS` and `ABSENT_MEMBERS`, with
`PLANNED_MEMBERS` derived as their union so every reader that only wants
"name → sentence" is unchanged. A bundle extending an absent member is
`wont-run` — `files-only` where curation says we read its format, mirroring the
blocker path rather than special-casing — and the name is named, so the row says
`SuggestModal` rather than "incompatible".

**Both maps are checked against the shim rather than asserted.**
`pluginSandboxGuest.test.ts` walks the real sandbox and holds that every inert
name is reachable on it and every absent name is not. The guard could not prove
that direction before and its own comment said so; it needed only "reachable or
not", which the walk answers exactly.

Found on Bible Reference (`obsidian-bible-reference`), which extends
`SuggestModal` and today is held off this path only by the 4MB read cap — so the
bug was live for any smaller plugin doing the same.

**What a simplification costs.** Collapsing the two maps restores a crash
reported as a missing feature. Dropping the `extends` prefix from the matcher
misses every namespaced base class, which is what a bundler emits. Letting the
name stay in `limitations` as well puts "does not run" and "one part will not
work" on one row. The checks are `a bundle extending a class the shim does not
provide will not run here`, `a bare identifier works too`, `it is not reported
as a limitation on a row that says it runs`, `and every member called absent
really is not there` — each sabotage-confirmed.

### A read cap is about our memory, never about their storage

`MAX_SCAN_BYTES` was 4MB and Bible Reference is 4.11MB, so it came back
"couldn't be checked" by 2.7% — a cap that ordinary plugins trip is not
protecting anything, it is refusing to answer. It is 16MB now, and the two
sentences worth keeping are why there is a number at all and how it was chosen.

It bounds **what this Worker pulls into memory to check a bundle**, not what a
customer may keep in their own bucket. Their storage, their plugin; the only
question is how much of it we read at once.

Sized against the 128MB isolate, with the arithmetic that actually decides it:
a JavaScript string holds two bytes per code unit, so 16MB of text is a ~33MB
string, about a quarter of the isolate, beside a report that holds one bundle at
a time. CPU is not the constraint — 4MB, 8MB and 16MB of real minified
JavaScript all scan in under a millisecond, because the alternations stop at the
first match per name.

It is deliberately **equal to `MAX_PLUGIN_ASSET_BYTES`**, which bounds the
download. Before this they disagreed at 4MB and 10MB, so a plugin could install
successfully and then report "couldn't be checked" for ever. Installing what we
cannot check is the one combination worth ruling out by construction.

**What a simplification costs.** Removing the cap entirely lets one plugin OOM
the isolate and take down the report for every plugin in the bucket — the
failure this module already refuses in `readPlugin`. Letting the two caps drift
apart restores the install-then-cannot-check state.

### And a switch has to actually do something

The other half of the same rule, learned the expensive way. **Drawings was
written into the catalogue and taken back out.** Every surface drawings has —
the description in `read_note`, the console's render, the editor page — is a
*read* of a file that is already there, and gating a read would be the switch
hiding content rather than removing a capability. Excalidraw's own write guard
is unconditional and is not anybody's switch to work. So there was nothing left
for the control to govern, and a switch that governs nothing is worse than no
switch: it is a promise printed beside a control, at the moment somebody is
deciding, that the product does not keep.

Two more entries were over-claimed in the same draft and corrected before they
shipped, both found by reading the diff rather than by a failing test:

- **"Form blocks stop being drawn"** was false — the gateway refused the four
  form tools while the console went on writing rows into the same response
  file. Fixed by closing the second door rather than by softening the sentence:
  `runFileOperation`'s `form` arm now carries the same check, so "forms are off
  in this context" is not a statement about AI clients only.
- **"Notes stop accepting new images"** was false in the other direction:
  nothing a person would call uploading an image reaches `writeImage` at all —
  its only caller is the share-card renderer. Gating it would have made an
  owner turning off an agent's `read_image` silently break their own share
  links, a switch reaching past what its own row promises. So that entry is
  read-only and says so, and `writeImage` carries a comment explaining why it
  is deliberately not gated.

`every Context plugin has a surface its switch actually governs` is the check
that holds the drawings lesson, and
`the console refuses a form submission while forms are off` holds the first
correction. The second is held by `the switch never reaches past what its row
promises`, which asserts the doors that stay open.

**What a simplification costs.** Adding an entry with no enforceable surface
puts a decorative control in a settings pane. Gating a read hides somebody's
content behind a preference.

## A vault copy and a managed install are one plugin, and the duplicate is not created

Precedence when one id is in both places is **unchanged**: the Context-managed
release is the row and the runtime. The reversal — prefer the vault copy,
because `.obsidian/` is the directory its owner actually keeps current — was
written, tested and backed out, and the fact that killed it belongs here so it
is not tried again: **a managed release is the only bundle this product can
run.** `loadPluginBundle` reads `.context/plugins/<id>/releases/<version>/` and
a fingerprint only resolves there, so an inventory that hid the managed row
behind a synced folder would take a plugin somebody installed here, approved
here and is running here, and silently stop it the moment they also installed it
in Obsidian.

What was right about the reversal is kept in two places.

**The duplicate is visible.** `alsoInVault` rides the row, and `list_plugins`
says which copy runs here and which runs in Obsidian, so nobody spends a week
updating the one that is being ignored.

**The duplicate is not created.** A registry row for a plugin already in
`.obsidian/plugins/` offers no install control at all — not a disabled one,
because a greyed button invites somebody to go looking for the switch that
enables it. It says the plugin is in the vault, that the vault is a fine place
for it, and that Context reads every file it writes. The button that used to be
there read "Also install a managed copy", and the honest description of what it
did is that it put two copies of one plugin in one bucket and made the
maintained one the ignored one.

**What a simplification costs.** Restoring the install button restores the
two-copy state. Preferring the vault copy stops approved, running plugins. The
checks are `a managed release deterministically replaces the same Obsidian
plugin id`, `and the vault's copy is reported on that row rather than silently
dropped`, and `already in the vault offers nothing, and says to keep it there` —
the last two replacing assertions that are quoted where they used to be.

## One panel, one box, and the registry is still a deliberate press

The two halves are one screen: a search box, a three-way filter (All ·
Context · Obsidian), then the Context block and the vault block, drawn from the
same card vocabulary. Context first, because it is the half that is definitely
working — no bundle to read, no verdict to be unsure about.

**The Context block sits outside every state the vault block can be in**, and
that is structural rather than cosmetic. Each of those states used to *end the
panel*: a member got "only an owner can read this", a bucket with no
`.obsidian/` got "no plugins in this bucket" — in a context that was running
four plugins the whole time. Nothing about the built-ins depends on reading
somebody's plugin directory, so nothing about them sits behind that read. Four
checks assert it by name rather than in a loop, because a loop over states is
exactly what a future early return passes silently.

**Typing narrows what is already here and sends nothing anywhere.** Reaching the
community registry is a request to a third party on somebody's behalf, and
`PluginBrowse`'s rule — nothing without a deliberate press — is unchanged. What
the box does is put the words on that press: "Browse" becomes `Search for "…"`
and opens already looking for it. The vault block's head counts are deliberately
*not* recomputed against the filtered set: `foundLabel` and the verdict chips
are a statement about what is installed, and making them follow a search box
would turn "3 won't run here" into a number meaning "3 of the ones matching what
you typed", which is the note count's floor-as-total trap in a new costume.

**Each row says what turning it off costs, in both states**, in words that
travel from the gateway's catalogue rather than being restated in the console —
so the promise beside the switch and the behaviour of the tool gate cannot
drift. A switch whose cost only appears after it has been pressed is a switch
somebody presses to find out, and this one changes what every connected client
of every member can do.

**Reading is a member's, changing is an owner's.** A member who cannot see which
features their context has is a member who files "the form isn't there" as a
bug; they see the list, no controls, and a sentence naming who has them. Whether
the caller may manage comes back from the server as `canManage` rather than
being re-derived in the client.

**What a simplification costs.** Putting the Context block inside the vault
block's ready branch hides it from every reader who cannot scan and every bucket
with no vault — five checks fail. Making the box drive the registry sends a
request to a third party per keystroke on somebody's behalf. Printing the
consequence only on the off state fails two.

## What is deliberately not built, for Context plugins

- **Third-party Context plugins.** The manifest shape is chosen so they could
  exist, and nothing about the catalogue, the settings file or the panel assumes
  the four are the only ones — `withDecision` deliberately keeps a decision
  about an id this build does not have. What is missing is the part that
  matters: a runtime, a review, and a grant. None of it is foreclosed.
- **Drawings as a plugin.** Not "no", but "not yet, and not like this" — see
  the section above. It belongs in the catalogue the day drawings grows a tool
  or a write path of its own for the switch to govern.
- **Per-plugin settings for the built-ins.** `.context/plugins/<id>/data.json`
  already exists for managed installs and is the obvious home, but no built-in
  has a setting worth having yet, and inventing one to justify the screen is how
  a settings pane grows rows nobody asked for.
- **Turning a plugin off for one person rather than one context.** The switch is
  the context's, which is why it is the owner's and why it is audited. A
  per-member override would be a second answer to "is forms on here" and the
  two would disagree.

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

### Network access uses a public-only socket service

An approved exact hostname does not make a direct `fetch` safe. DNS can return
a public address during validation and a private address when the connection is
opened. The control plane therefore keeps request policy, while
`infra/egress-service` performs one socket operation. It resolves every address
for the hostname, refuses the request if any address is not public, and opens
TLS to one checked address with the hostname as SNI and the HTTP `Host` header.
Convex handles redirects manually and calls the service again for each hop.

The service receives the URL, method, headers, and body after Convex has checked
the plugin grant. It receives no workspace, user, plugin, or storage identity,
and it has no storage binding. `PLUGIN_EGRESS_URL` and
`PLUGIN_EGRESS_SECRET` configure the Convex caller. With either value absent or
invalid, `pluginRuntimeCapabilities` reports `{ egress: false }` and network
approval fails closed.

This does not reopen server-side plugin execution. The plugin still runs in the
console sandbox. The container only makes a bounded HTTPS request that Convex
already authorized.

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
Rendering plugin-provided editor extensions, settings controls and views remains
a frontend integration step; the sandbox is now the place those registrations
come from rather than a reason they cannot be built.

YouVersion Linker 1.8.1 sets the compatibility boundary more precisely. Its
bundle imports `@codemirror/language`, `@codemirror/state` and
`@codemirror/view` before `onload`, even though its Generate links command only
needs an Obsidian editor. The guest therefore supplies the exact imported
CodeMirror constructors as inert, guest-only objects and accepts the extension
and suggestion registrations without mounting them in Context's trusted
editor. Command invocation receives a bounded in-memory editor over the active
note; a changed document is written once through the existing etag-checked
`vault.modify` RPC. The note target is pinned before any awaited plugin work so
opening another note cannot redirect the eventual write. This makes Generate
links functional without claiming that live decorations, suggestions or a
third-party CodeMirror instance run in Context's editor.

`requestUrl` also follows Obsidian's response shape inside the guest:
`{ status, headers, arrayBuffer, json, text }`. Convex transports the bounded
body as base64 so the RPC remains JSON-safe; host policy, the public-only socket
service, redirects and auditing are unchanged. These compatibility objects and
response helpers add no authority — every read, write and request still crosses
the same grant-checked RPC boundary.

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

## A list of what the shim is missing cannot be written by hand

`SuggestModal` was found because somebody had written it down as absent, and
fixing it uncovered `Events`, and fixing that uncovered `Modal`. Neither of the
second two was on any list in this repository — not supported, not planned, not
absent — so the scanner had nothing to say about them, and the real Bible
Reference release was reported as **"runs here — everything these use, Context
implements"** while it could not finish evaluating at all.

The shape is always the same: `class X extends <ns>.Something` at module scope
is evaluated on load, so a missing class is not a missing feature. It is
`extends undefined` thrown before `onload`, and the whole plugin is gone over a
class it uses in a flow nobody would call central. Bible Reference's inline
verse suggester needed nothing that was not already built; it died three times
on classes it uses somewhere else.

So the question is derived rather than listed. `SANDBOX_MODULE_EXPORTS` declares
exactly what `require("obsidian")` hands back, `undeclaredBases` finds every
`extends` reached through a namespace that provably came from that module, and
anything not in the first is reported. Keyed off the module *string*, which a
minifier cannot rename, rather than off the identifier, which it does —
`var eo = require("obsidian")` is real output from the release this was written
against. A bundled third-party library's own `ui.Widget` is therefore never
mistaken for ours.

**What a simplification costs.** Going back to a hand-written list of absent
names re-opens the exact hole: a class nobody thought of scans clean and takes a
plugin down. Comparing against `SUPPORTED_MEMBERS` instead of
`SANDBOX_MODULE_EXPORTS` compares against a list of *methods* and fails every
plugin that extends anything. Matching an unqualified `extends Foo` fails
plugins over their own local classes.
`apps/mcp/test/plugins.test.mjs` holds all three, and
`pluginSandboxGuest.test.ts` holds the declaration against the real shim in both
directions — a class the shim exports and the list omits fails a working plugin,
and a class on the list the shim lacks passes a broken one.

## A base class has to be real, and a real dialog is text in one direction

`Modal` could have been an empty class. It would have got the bundle loading,
which is the whole crash, and then done nothing when somebody pressed the
command — the "present and inert" trap two sections up, shipped in the name of a
plugin that still did not work.

So it draws. `contentEl` and `titleEl` are real elements *in the sandbox*, a
plugin builds into them exactly as it would in Obsidian, and what crosses is
`textContent` — the same inversion `registerEditorSuggest` and the suggestion
dialog use, and the same boundary: no markup, no link, no image, no script from
a plugin in front of a reader.

Two details are load-bearing rather than tidy. The text is pushed on **every
mutation of the dialog's own DOM**, not once when `open()` returns, because a
plugin may fill it after `onOpen` has already finished — Bible Reference's verse
of the day opens the dialog and *then* fetches, and a dialog reported once would
be reliably empty for the plugin that made it necessary. And a dismissal closes
the dialog on the console **before** telling the guest, because a reader pressing
Escape must not be waiting on a wedged plugin.

`Events` needed none of that. It is a map of callbacks inside the sandbox with
nothing to ask anybody, and it is implemented rather than declared for the same
reason: a plugin builds its own bus out of it at module scope.

**What a simplification costs.** An inert `Modal` loads plugins and silently
does nothing. Sending `innerHTML` instead of `textContent` puts a plugin's
markup in the trusted realm. Dropping the observer empties every dialog filled
asynchronously, with no error anywhere. Waiting for the guest to confirm a
dismissal hands a plugin the power to keep a dialog on screen.
`pluginSandboxGuest.test.ts` and `pluginTextDialog.test.ts` hold one each, all
sabotage-confirmed — the observer one after a first version survived its
sabotage by testing the awaited path instead.

## The only check that has ever caught a plugin not loading

Every other check on the shim asks whether a member exists and behaves. Three
times now the answer to *"does the plugin a person installed actually run"* was
no while every unit suite was green.

`apps/mobile/e2e/webkit/pluginBundles.spec.ts` loads a real community release
into the real sandbox document in a real browser and asserts it reaches
`loaded`. It asserts `pageerror` is empty as well, and that is not belt and
braces: the shim evaluates a bundle in a `<script>` element, a `<script>` that
throws reports to `window.onerror` rather than to the `try` around
`appendChild`, and the frame is cross-origin — so every genuine load failure
arrives at the console as the same sentence, *"Plugin bundle did not export a
plugin class"*, whatever actually went wrong. Playwright sees those errors for
every frame and is the only place the real cause is readable.

The releases are fetched by `e2e/webkit/fetch-bundles.mjs` and pinned by
version, never committed: megabytes of third-party minified code do not belong
in a public repository, and a floating "latest" would make a green run mean
"this morning's release happens to load".

## What is installed is a different question from what runs, and a cheaper one

The inventory waits to be asked because it opens every bundle in somebody's
vault. That was right for a scan and wrong for the screen, and the difference
cost more than the reads would have: the panel that installs plugins could not
name one it had installed, so a person came back the next day, saw *"read the
plugins in this bucket"* and an empty panel, and drew the obvious conclusion —
the install had not stuck. It had. Nothing had ever read it back. The registry
beside it, with no inventory to compare against, then offered **Install** on the
row that was already installed, and it got installed again.

`listManagedInstalls` answers the cheap question for a listing and one small
pointer per install: no manifest, no bundle, no stylesheet, no verdict. It is
Context's own directory rather than `.obsidian/`, so the "another program's
files" argument does not apply either. The console reads it on mount, like
`useContextPlugins` and unlike `usePlugins`.

It deliberately cannot say whether any of them runs. That is the scan's answer
and stays behind the press, because it is the expensive half and the half a
stale answer would misreport.

The copy moved with it. Every sentence on that panel named `.obsidian/` and only
`.obsidian/`, which is why the missing list was read as *"Context ignores its own
plugins folder"* — a reasonable reading of a screen that showed nothing and
talked about one directory.

**What a simplification costs.** Folding this into the inventory puts it behind
the press again and restores the bug exactly. Returning an empty list when the
listing fails prints "you have installed nothing" for a storage error, which is
the same false statement in a new place. Giving these rows a verdict claims
something about third-party code nobody checked.
`apps/mcp/test/plugins.test.mjs`, `apps/convex/__tests__/files.test.ts`,
`apps/mobile/__tests__/pluginsPanel.test.ts` and
`apps/mobile/e2e/webkit/pluginsInstalled.spec.ts` hold these, the last in a real
browser in the state a first visit is actually in.
