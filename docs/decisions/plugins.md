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

Moved to [A Context plugin is Obsidian's manifest with one extra key, and no bundle](./plugins/manifest-and-switches.md#a-context-plugin-is-obsidians-manifest-with-one-extra-key-and-no-bundle).

## The switch lives in the bucket, in two lists rather than one

Moved to [The switch lives in the bucket, in two lists rather than one](./plugins/manifest-and-switches.md#the-switch-lives-in-the-bucket-in-two-lists-rather-than-one).

## A switch removes a capability and never a protection

Moved to [A switch removes a capability and never a protection](./plugins/manifest-and-switches.md#a-switch-removes-a-capability-and-never-a-protection).

## The switch is enforced twice, because the listing is cached

Moved to [The switch is enforced twice, because the listing is cached](./plugins/manifest-and-switches.md#the-switch-is-enforced-twice-because-the-listing-is-cached).

## What may never be a plugin

Moved to [What may never be a plugin](./plugins/manifest-and-switches.md#what-may-never-be-a-plugin).

## The owner authorizes a plugin over their own workspace; the workspace is the wall

Moved to [The owner authorizes a plugin over their own workspace; the workspace is the wall](./plugins/manifest-and-switches.md#the-owner-authorizes-a-plugin-over-their-own-workspace-the-workspace-is-the-wall).

## A base class is a load-bearing export, so the dialog was built rather than stubbed

Moved to [A base class is a load-bearing export, so the dialog was built rather than stubbed](./plugins/dialog-and-install.md#a-base-class-is-a-load-bearing-export-so-the-dialog-was-built-rather-than-stubbed).

## A vault copy and a managed install are one plugin, and the duplicate is not created

Moved to [A vault copy and a managed install are one plugin, and the duplicate is not created](./plugins/dialog-and-install.md#a-vault-copy-and-a-managed-install-are-one-plugin-and-the-duplicate-is-not-created).

## One panel, one box, and the registry is still a deliberate press

Moved to [One panel, one box, and the registry is still a deliberate press](./plugins/dialog-and-install.md#one-panel-one-box-and-the-registry-is-still-a-deliberate-press).

## What is deliberately not built, for Context plugins

Moved to [What is deliberately not built, for Context plugins](./plugins/not-built-and-drawings.md#what-is-deliberately-not-built-for-context-plugins).

## Drawings: read the file, describe it, and refuse to write over it

Moved to [Drawings: read the file, describe it, and refuse to write over it](./plugins/not-built-and-drawings.md#drawings-read-the-file-describe-it-and-refuse-to-write-over-it).

## A plugin's UI reaches the console as text, never as DOM

Moved to [A plugin's UI reaches the console as text, never as DOM](./plugins/ui-and-drawing-editor.md#a-plugins-ui-reaches-the-console-as-text-never-as-dom).

## The drawing editor is a page, because a dynamic import is not a lazy chunk

Moved to [The drawing editor is a page, because a dynamic import is not a lazy chunk](./plugins/ui-and-drawing-editor.md#the-drawing-editor-is-a-page-because-a-dynamic-import-is-not-a-lazy-chunk).

## A drawing is named by its file, never by `# Excalidraw Data`

Moved to [A drawing is named by its file, never by `# Excalidraw Data`](./plugins/ui-and-drawing-editor.md#a-drawing-is-named-by-its-file-never-by-excalidraw-data).

## A bare `%%` ends a section, and that rule has one definition

Moved to [A bare `%%` ends a section, and that rule has one definition](./plugins/ui-and-drawing-editor.md#a-bare-ends-a-section-and-that-rule-has-one-definition).

## A file that does not exist yet is scaffolded, once, and edited ever after

Moved to [A file that does not exist yet is scaffolded, once, and edited ever after](./plugins/ui-and-drawing-editor.md#a-file-that-does-not-exist-yet-is-scaffolded-once-and-edited-ever-after).

## The editor is cached by a worker scoped to its own directory

Moved to [The editor is cached by a worker scoped to its own directory](./plugins/ui-and-drawing-editor.md#the-editor-is-cached-by-a-worker-scoped-to-its-own-directory).

## The message check is an identity check, not an origin check

Moved to [The message check is an identity check, not an origin check](./plugins/message-checks-and-shim.md#the-message-check-is-an-identity-check-not-an-origin-check).

## A list of what the shim is missing cannot be written by hand

Moved to [A list of what the shim is missing cannot be written by hand](./plugins/message-checks-and-shim.md#a-list-of-what-the-shim-is-missing-cannot-be-written-by-hand).

## A base class has to be real, and a real dialog is text in one direction

Moved to [A base class has to be real, and a real dialog is text in one direction](./plugins/message-checks-and-shim.md#a-base-class-has-to-be-real-and-a-real-dialog-is-text-in-one-direction).

## The only check that has ever caught a plugin not loading

Moved to [The only check that has ever caught a plugin not loading](./plugins/message-checks-and-shim.md#the-only-check-that-has-ever-caught-a-plugin-not-loading).

## What is installed is a different question from what runs, and a cheaper one

Moved to [What is installed is a different question from what runs, and a cheaper one](./plugins/message-checks-and-shim.md#what-is-installed-is-a-different-question-from-what-runs-and-a-cheaper-one).

## A settings pane is described, never forwarded

Moved to [A settings pane is described, never forwarded](./plugins/settings-and-editor-writes.md#a-settings-pane-is-described-never-forwarded).

## The open note is an editor a plugin can write into, while its work is running

Moved to [The open note is an editor a plugin can write into, while its work is running](./plugins/settings-and-editor-writes.md#the-open-note-is-an-editor-a-plugin-can-write-into-while-its-work-is-running).

## A press that does nothing is a bug, even when nothing is broken

Moved to [A press that does nothing is a bug, even when nothing is broken](./plugins/settings-and-editor-writes.md#a-press-that-does-nothing-is-a-bug-even-when-nothing-is-broken).

## A check that reads React state from inside `onEvent` is not a check

Moved to [A check that reads React state from inside `onEvent` is not a check](./plugins/settings-and-editor-writes.md#a-check-that-reads-react-state-from-inside-onevent-is-not-a-check).

## A plugin's `fetch` goes through the grant, and the CSP still denies the frame

Moved to [A plugin's `fetch` goes through the grant, and the CSP still denies the frame](./plugins/fetch-and-bridge.md#a-plugins-fetch-goes-through-the-grant-and-the-csp-still-denies-the-frame).

## A plugin's suggestions cross the `WebView` bridge, and the guest asks nothing until told there is somebody to ask

Moved to [A plugin's suggestions cross the `WebView` bridge, and the guest asks nothing until told there is somebody to ask](./plugins/fetch-and-bridge.md#a-plugins-suggestions-cross-the-webview-bridge-and-the-guest-asks-nothing-until-told-there-is-somebody-to-ask).

## A plugin row answers "is it on"; everything else is one press away

Moved to [A plugin row answers "is it on"; everything else is one press away](./plugins/fetch-and-bridge.md#a-plugin-row-answers-is-it-on-everything-else-is-one-press-away).

## The section is hidden, the machinery is not

Moved to [The section is hidden, the machinery is not](./plugins/fetch-and-bridge.md#the-section-is-hidden-the-machinery-is-not).
