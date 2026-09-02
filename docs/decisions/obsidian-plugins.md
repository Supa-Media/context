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

- **Running plugins.** An `obsidian` API shim over the storage adapter, plugin
  bundles in a sandboxed worker in the console. The editor half is unusually
  cheap because Context's editor is already CodeMirror 6, the same as Obsidian's
  — `SUPPORTED_MEMBERS` is written against what that shim would answer, so the
  table is the shim's specification as much as the scan's input.
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
