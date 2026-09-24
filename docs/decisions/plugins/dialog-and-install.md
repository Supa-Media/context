# Plugins — dialog and install

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
