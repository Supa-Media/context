# Plugins — manifest and switches

## A Context plugin is Obsidian's manifest with one extra key, and no bundle

`apps/mcp/src/plugins/catalog.js` declares five, in Obsidian's own manifest
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
it. Reserved is the whole prefix rather than the five ids in use, so a plugin
added later is not shadowable by a folder that predates it.

**What a simplification costs.** Dropping the prefix check lets a synced folder
take a built-in's row. Inventing a manifest shape of our own ends the one-row
claim and makes a future third-party Context plugin unpublishable to either
catalogue. `a vault folder cannot borrow a built-in id` is the check.

### Contacts is the fifth, and it earned the row by growing tools

Contact pages existed for a week before this, written into `0-inbox/contacts/`
by the Gmail, Chat and iMessage syncs and reachable only as ordinary notes: a
connected client could read one if it already knew the path, and had no way to
ask who the user corresponds with at all. That is the same state **drawings**
was in when it was written into this list and taken back out — every surface a
read of a file already there, nothing for a switch to govern — and the
difference is the one that rule names: `list_contacts` and `read_contact` are
a capability, so turning them off removes something.

**The switch governs the reading and says so.** The syncs do not consult this
file and keep writing pages with contacts turned off, so an `offMeans`
promising that contacts stop being collected would be a promise the product
does not keep, printed at the moment somebody is deciding. It names the Email
and Chats connection screens instead, the way Chat history's entry does.

**Both tools carry the provenance line, and that is not decoration.** A
contact page is the only thing this product writes whose **key was chosen by
whoever sent the user a message** — the fact the review of `#448` said to hold
in mind for anything built on contacts next — and its name, organization and
identifiers are values lifted off inbound mail. A model handed that page with
nothing said reads it as the context's own claim about a person. `list_contacts`
prints the sentence under the listing and `read_contact` prints it under the
page, from one constant, because the listing is where somebody chooses who to
read about and the read is where they choose what to believe.

**A path under `0-inbox/contacts/` is not proof the note is ours**, for the
same reason: a sender picked the name. `parseContactView` is lenient by design
and would happily render somebody's own note — or ciphertext — as a person's
contact details, so both tools gate on `isContactNote`, the positive
frontmatter marker `renderContactNote` always emits. The listing names such a
note rather than hiding it (hiding a visible note from a listing of its own
folder teaches the caller something false), and the read hands it to
`read_note` rather than printing fields it never had. *A lenient reader is a
dangerous gate* is that review's own lesson, applied on the read side.

**What a simplification costs**: dropping the `isContactNote` gate turns a
note the user wrote at a contact's key into a contact page in the listing and
in the read. Dropping the provenance line makes a sender's self-description
indistinguishable from something this context established. The checks are in
`apps/mcp/test/contacts.test.mjs`.

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
