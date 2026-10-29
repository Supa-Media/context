# Plugins — message checks and the shim

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

## The sandbox is a page of its own, and is public on purpose

The web console used to load the sandbox as a `srcdoc` frame. A `srcdoc` document inherits its parent's Content Security Policy. The sandbox runs its bootstrap and every plugin as inline script. So the console's `script-src` could never be enforced without breaking every plugin, and the CASA scan's "CSP: script-src unsafe-inline" stood on the whole console because of it (2026-10-29).

Since #2437 the console loads `/drawing-assets/plugin-sandbox/index.html` by `src`, keeping `sandbox="allow-scripts"` and never adding `allow-same-origin`. The build writes `pluginSandboxDocument()` to that path, byte for byte (`scripts/build-plugin-sandbox.mjs`). The router answers it in `infra/router/src/pluginSandbox.ts`:

- It serves only that page. Any other name gets a 404, any method but GET or HEAD gets a 405, and anything without the page's own CSP meta tag gets a 503, so the SPA fallback never stands in.
- It serves the page under the sandbox's own policy: `default-src 'none'`, inline script and style only, `connect-src 'none'`, and nothing else loadable, plus `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`.

**It is not gated on `EXPO_PUBLIC_EXPERIMENTAL_PLUGINS`, and cannot be.** That flag hides the Plugins section. It does not stop plugins running: the sandbox host is still mounted for owners, and a context that already enabled a vault plugin keeps running it ("The section is hidden, the machinery is not"). Gating the page on the flag would stop those plugins in production, which is exactly what deprecation promised not to do.

**The page on its own is inert, and that is the threat model:**

- **Nothing to run.** It carries no plugin code. The bootstrap runs nothing until a parent posts it a `load` message with a bundle.
- **Nothing to be told.** No credential, token or note is in the page or its URL. The bundle is only ever posted by the console, from its own authenticated session, into a frame it created. The grant-holding half (RPC, `fetch` brokering) stays in the console, which answers only its own frame's `contentWindow`, and only while that frame is still the document it loaded ("The message check is an identity check, not an origin check").
- **Nothing to reach.** Opened directly, or framed by our own origin with a hostile bundle, the page has an opaque origin: no cookies and no storage. Its CSP allows no connection, image, font, frame or worker, so it can exfiltrate nothing and reach no other privilege.
- **No other framer.** Another site cannot frame it at all, because of `frame-ancestors 'self'` and `SAMEORIGIN`.

**Proved in a real engine** by `apps/mobile/e2e/webkit/pluginSandboxPage.spec.ts`, run per push in WebKit whenever the sandbox's files change (`browser.yml`, "Plugin sandbox in WebKit"):

- the page is the router's own answer, with every header it sends;
- the frame's origin is `null`, and the handshake completes;
- the parent's DOM and storage are refused, and a connection is refused by the CSP itself;
- a frame that reloads itself or navigates away is handed nothing a second time;
- another site's frame gets nothing.

It was sabotage-checked three ways: widening `connect-src`, dropping the framing headers, and loosening `sandboxFrameIsOurs` each fail it.

**What this does and does not do to the scan finding.** A scanner that reaches this URL will still report `script-src 'unsafe-inline'` on this one page. That is the expected disposition: a documented exception for an inert, opaque-origin page with no network, not a waiver of the console's finding. The console's own finding is removed only when the console *enforces* a `script-src` without `'unsafe-inline'`. Moving the sandbox out of the console is what makes that enforceable, and it does not count as the enforcement.

**Known cost:** the sandbox page now needs the network on first load, where `srcdoc` had none. Because `/drawing-assets/` is outside the console's service worker, a plugin started with the network off fails to load its frame, until the page is cached the way the drawing editor's is.

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

## A sequence number orders a reply; it does not identify its sender

Suggestion, suggestion-apply and preview requests leave the trusted host for
one plugin frame. Their replies used to be matched against a process-wide
sequence number alone. That number orders overlapping work, but every running
plugin can predict it and send a reply carrying it. One plugin could therefore
answer another plugin's pending request. The most serious form was a forged
`suggest-applied` line entering the trusted editor after the reader picked a
different plugin's suggestion.

Each pending entry now records the plugin id and sandbox nonce it was sent to.
The host accepts the reply only from that exact frame. An impostor reply leaves
the entry in place so the real frame can answer or its timer can expire. The
nonce matters as much as the id: a restarted plugin is a new frame and cannot
finish work addressed to its predecessor.

**What a simplification costs.** Matching on `seq` alone lets any running
plugin answer another plugin's request. Matching on the plugin id but not the
nonce lets a restarted frame inherit a line or preview it never received.
Deleting the pending entry after an impostor reply lets one plugin silence
another. `apps/mobile/__tests__/pluginReplyOwnership.test.ts` holds all three
paths and was sabotage-confirmed by removing the suggestion owner check.

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
