# Plugins — fetch and the bridge

## A plugin's `fetch` goes through the grant, and the CSP still denies the frame

The sandbox is `connect-src 'none'`, so the frame reaches nothing on its own.
That is the boundary and it has not moved. What had moved without anybody
noticing is which calls a plugin could *make*: only `requestUrl` was brokered,
and Obsidian offers both.

So a plugin using plain `fetch` got a `TypeError` with no explanation. Measured
on the real Bible Reference release, which fetches its verses that way: its call
was refused by the CSP, its own handler swallowed the failure, and it served
**bundled fallback text labelled with the translation the reader had asked for
and had not got**. A grant the owner had approved, a capability the card
claimed, and a wrong verse on the page — the worst shape a failure can take
here, because nothing anywhere said so.

`fetch` is now routed through the same `network.request` broker `requestUrl`
uses: same runtime token, same grant, same host allowlist, same audit. This
widens what a plugin may *call*, never what it may *reach* —
`brokerNetworkRequest` is the gate and has not changed.

It behaves like `fetch`, which is the point: a 4xx **resolves** with `ok: false`
so a plugin's own error handling runs, and a refusal **rejects with a
`TypeError`** carrying the host's sentence, so a plugin falls into the path it
already has for being offline rather than an error shape it will not handle.

**`XMLHttpRequest` is deliberately not shimmed.** It is synchronous-capable with
a large surface, and a half-built one is the present-and-inert trap this area
keeps having to undo. Absent, it throws where it stands, the scanner reports it,
and it doubles as the direct-egress probe in `pluginSandbox.spec.ts` — the thing
that proves the CSP is still the only answer to a frame opening its own
connection.

**The scanner had to move with it.** `fetch` was missing from `NETWORK_MEMBERS`,
which was harmless while the CSP refused every direct call — the reading was
wrong about the code and right about the effect. Once brokered it reaches
outward for real, so a bundle calling it is `needs-approval` and its owner names
the hosts.

**What a simplification costs.** Dropping the override returns every
plain-`fetch` plugin to silent failure. Throwing on a 4xx sends plugins down
their catch path with the wrong reason. Resolving a refusal hands a plugin the
network its owner did not grant. Removing `fetch` from `NETWORK_MEMBERS` grants
the network without anybody being asked. `e2e/webkit/pluginNetwork.spec.ts`,
`e2e/webkit/pluginSandbox.spec.ts` and `apps/mcp/test/plugins.test.mjs` hold
these, all four sabotage-confirmed, the first against the real release.

## A plugin's suggestions cross the `WebView` bridge, and the guest asks nothing until told there is somebody to ask

`LiveEditorProps` declared `onSuggest` and `onPickSuggestion`; `LiveEditor.web.tsx`
installed the completion source with them and `LiveEditor.tsx` destructured
neither. On a phone a plugin could show **Running**, hold a grant its owner had
approved, and offer nothing in any note — silently, because nothing was broken.
That is the one shape this area keeps ruling out: a capability neither provided
nor reported. It is the same failure as the blank note editor — arithmetic in a
module nothing reads — and the same failure as `addSettingTab` being listed
inert, in a place nobody looked because the web console worked.

**The split is the one the web half already makes**, and it had to be, because
the editor is the trusted realm on both surfaces: the plugin decides what to
offer and what a pick produces, CodeMirror decides how a list looks and how keys
behave, and only strings cross. What is new is that on native there is a second
boundary in the middle — the editor is inside a `WebView` and the plugins are
outside it — so `pluginSuggest.ts`'s ref is filled in from across the bridge
instead of from props.

**The guest is told whether anyone can answer, rather than finding out by
asking.** A `suggest` message carries one boolean, and while it is false
`pluginSuggestSource` returns `null` without sending anything. Without it every
completion — which CodeMirror runs on every keystroke — would be a bridge round
trip returning an empty list, on every note, on every surface with no plugin
running. It is resent on `ready` with the rest of the desired state, because a
WKWebView can reload itself after a memory warning and the state it would come
back in is the one that asks nothing.

**Asking is a read and picking is a write, and they are gated differently.** The
ask is not gated on `editable`: it sends the caret's line to a plugin, and
whether a plugin may see note content is `maySeeContent` against `vault:read`,
decided where the sandboxes are — a member on a read-only note is exactly who a
suggesting plugin is for. The pick *is* gated, in the host, because a pick exists
to produce an edit and `EditorView.editable.of(false)` does not stop a
programmatic one. That is the second of the three refusals every edit meets here,
on the far side of a process boundary from the guest's own `changeFilter`.

**A malformed item list is refused whole, never filtered.** A pick crosses back
as an *index* into that list. Dropping the one bad row and offering the rest is
the obvious kindness and renumbers everything after it: the reader picks the
label they read and the plugin rewrites their line from the row below it. Nothing
legitimate trips this — the items reach the host already parsed out of a sandbox
message — which is the point. If it fires, something upstream is wrong and
guessing is the worst available answer.

**What a simplification costs.** Taking the `suggest` message out and asking
unconditionally is a bridge round trip per keystroke forever, for an empty list,
on every phone with no plugin running. Not resending it on `ready` is a plugin
that stops suggesting after a memory warning until the note is reopened.
Ungating the pick lets a read-only note's completion reach the plugin and rely on
one `changeFilter` to be the only refusal. Filtering the item list instead of
refusing it inserts the wrong verse. `apps/mobile/__tests__/nativePluginSuggest.test.ts`
holds the conversation and `nativePluginSuggestWiring.test.ts` holds the
component — the second exists because every test in the first builds the bridge
itself, and the bug that shipped was a component that never built one.

## A plugin row answers "is it on"; everything else is one press away

Reported from a phone, looking at a single plugin that filled the screen:
*"there is soooo much jargon text here, people just want to enable or disable a
plugin, push details into another screen or something."*

They were right, and the shape of being right matters: **none of the words were
wrong.** The author's blurb, the named findings, the hosts it calls, the fold of
limitations, what was read, where it came from, the route out of a refusal — each
of those exists because something went wrong without it, and each has a decision
in this file behind it. What was wrong was that all of them were on a **row in a
list**, and a list exists to choose from. Nothing in that wall helps choose.

So the row now carries a name, an id, one pill, and at most two presses; the rest
is `PluginDetail`, unabridged. **Nothing was shortened to fit** — the wall was a
placement problem and shortening the sentences would have been the wrong repair
twice over, since the wording is the part that is load-bearing.

**The pill is "is this on", so it is absent where there is no such answer.** A
`wont-run` plugin is not off; it is not a thing that has an on. Filling its pill
with the verdict would repeat the group heading directly above it, on every row,
which is a good part of what the wall was made of.

**A running plugin's own state outranks the scan and the grant.** The scan reads
a bundle and a grant is permission; neither is evidence about now. A row reading
"Needs approval" over a plugin that is running is the panel preferring its own
taxonomy to the facts.

**One press, or a door.** Start and Stop are complete and happen on the row.
Enabling is not — it needs capabilities chosen and hosts named — so it opens the
detail screen and says so with an ellipsis. And a door with nothing behind it is
worse than no door: a plugin naming hosts on a deployment with no egress cannot
be approved at all, so it is offered Details rather than an "Approve…" that can
only ever land on the sentence explaining why not.

**What a simplification costs.** Putting the detail back on the row is the
original report. Letting the verdict fill the pill is the group heading twice per
row. Letting the scan outrank the runtime hides the Stop from the only person who
can press it. Gating the consent door on the *runtime* — which the first draft
did — puts an Enable on no row at all in a console that can approve but whose
runtime has not loaded, and `pluginsAccess.test.ts` caught exactly that.
`pluginRowSummary.test.ts` holds the decision, `pluginsPanel.test.ts` holds that
every sentence still reaches a reader through the press, and six sabotages
confirm both.

## The section is hidden, the machinery is not

Owner's call, 2026-09-18, with Sayo, and it reverses nothing above. Everything
in this file still holds; what changed is who sees the screen it describes.

The Plugins section comes off the settings list. **Nothing else goes.** The
gateway still scans `.obsidian/`, `catalog.js` still declares the five
built-ins, the control plane still stores their switches, the sandbox host is
still mounted at console scope, every grant already given still holds, and
every plugin running in a context today goes on running in it. That sentence is
the whole difference between a deprecation and a deletion, and it is the
condition the call was made under rather than a courtesy: a change that hides a
screen and turns something off is not the change that was agreed.

**Why.** Sandboxing is the part that is not finished. Obsidian's model is
somebody else's code on their own laptop against their own vault; ours is
somebody else's code in our cloud against a bucket we hold the key to, and the
distance between those is the whole of `apps/mcp/src/plugins/` and still not
enough. Beside that, the audience the product is being pointed at does not have
an Obsidian vault to bring: *"focus on people who don't really know what
Obsidian is"*. A settings row is an invitation, and this one invites the thing
we are least ready for, to the people least likely to want it.

**Why not delete it.** An extension point is most of why Obsidian is what it
is, and the argument for having one here — *"we build the scaffolding and the
plugins we default-on are built against it"* — is unchanged and long-term.
Deleting the section means rebuilding it later, and rebuilding is where the
decisions in this file get quietly re-litigated and lost. So the row stays in
`SETTINGS_SECTIONS` carrying `experimental: true`, the panel stays, the
`?settings=plugins` URL stays a name we have, and coming back is flipping a
flag rather than writing a feature twice.

**Two ways back, and the second is not a nicety.**
`EXPO_PUBLIC_EXPERIMENTAL_PLUGINS=1` at export time is the switch for the
product — off in every shipping build until sandboxing is solved, in the
`EXPO_PUBLIC_*` shape `communications/flags.ts` already uses for a gate that
waits on something other than engineering. `pluginsInUse` is the switch for one
person: hiding a section takes its controls with it, and the controls here are
the only place a context can turn a built-in off, read what a vault plugin was
allowed to do, or remove one. A context that has a managed install, a built-in
moved off its shipped default, or a vault plugin the scan found keeps the
screen. A context with nothing but defaults never learns it existed.

The three signals are asymmetric on purpose and each means *somebody chose
this*. `enabled` alone is not one of them: all five built-ins ship on, so a
check on it is true for every context alive and would hide the row from nobody.
Every unfinished or failed read — `idle`, `loading`, `failed`, `withheld` —
reads as "not in use", because the default of a deprecation is hidden and a
bucket having a bad minute must not put a retired screen back in front of
everybody.

**What a simplification costs.** Deleting the section instead is the rebuild,
and the decisions in this file are what gets lost in it. Dropping `pluginsInUse`
and hiding the row from everybody takes working controls away from people who
are using them, which is the one thing this was not allowed to do. Reading
`enabled` instead of `enabled !== defaultEnabled` hides nothing at all. Letting
a failed read show the row puts it back for everyone, one outage at a time.
Known and accepted: the five built-ins' off switches go with the section for
anybody who has not already used one — the owner's call, not a side effect, and
a home of their own for those switches is a separate change this does not block.
`pluginsExperiment.test.ts` holds all of it, `settingsOverlayRender.test.ts`
holds the wire at the rendered list, and four sabotages confirm both.
