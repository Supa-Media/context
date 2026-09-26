# The mobile app and the console

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### The note count is measured, stamped, and allowed to be a floor

Moved to [The note count is measured, stamped, and allowed to be a floor](./app-and-console/native-app-shell.md#the-note-count-is-measured-stamped-and-allowed-to-be-a-floor).

### One runtime version, pinned, and native deps gated behind it

Moved to [One runtime version, pinned, and native deps gated behind it](./app-and-console/native-app-shell.md#one-runtime-version-pinned-and-native-deps-gated-behind-it).

### The native baseline was chosen once, before the first build

Moved to [The native baseline was chosen once, before the first build](./app-and-console/native-app-shell.md#the-native-baseline-was-chosen-once-before-the-first-build).

### The iOS editor is the web editor, in a WebView, from a committed bundle

Moved to [The iOS editor is the web editor, in a WebView, from a committed bundle](./app-and-console/native-app-shell.md#the-ios-editor-is-the-web-editor-in-a-webview-from-a-committed-bundle).

### Every react-native-web `View` is a stacking context, so a `zIndex` is local

Moved to [Every react-native-web `View` is a stacking context, so a `zIndex` is local](./app-and-console/native-app-shell.md#every-react-native-web-view-is-a-stacking-context-so-a-zindex-is-local).

### There are two palettes, and a screen may not hold either one

Moved to [There are two palettes, and a screen may not hold either one](./app-and-console/native-app-shell.md#there-are-two-palettes-and-a-screen-may-not-hold-either-one).

### The web shell is `public/index.html`, because `+html.tsx` is a static-rendering file

Moved to [The web shell is `public/index.html`, because `+html.tsx` is a static-rendering file](./app-and-console/design-tokens-and-interaction.md#the-web-shell-is-publicindexhtml-because-htmltsx-is-a-static-rendering-file).

### Hue is meaning in this product, so the palette rations it

Moved to [Hue is meaning in this product, so the palette rations it](./app-and-console/design-tokens-and-interaction.md#hue-is-meaning-in-this-product-so-the-palette-rations-it).

### Nine sizes, two densities, and no literal font size anywhere

Moved to [Nine sizes, two densities, and no literal font size anywhere](./app-and-console/design-tokens-and-interaction.md#nine-sizes-two-densities-and-no-literal-font-size-anywhere).

### One interface face, and `display` kept as a role with no face of its own

Moved to [One interface face, and `display` kept as a role with no face of its own](./app-and-console/design-tokens-and-interaction.md#one-interface-face-and-display-kept-as-a-role-with-no-face-of-its-own).

### A long press has two signals, because the platform is watching the finger too

Moved to [A long press has two signals, because the platform is watching the finger too](./app-and-console/design-tokens-and-interaction.md#a-long-press-has-two-signals-because-the-platform-is-watching-the-finger-too).

### A launch is not a screen, and an empty list is not an empty account

Moved to [A launch is not a screen, and an empty list is not an empty account](./app-and-console/design-tokens-and-interaction.md#a-launch-is-not-a-screen-and-an-empty-list-is-not-an-empty-account).

### An absence is a claim, and a claim needs an answer

Moved to [An absence is a claim, and a claim needs an answer](./app-and-console/design-tokens-and-interaction.md#an-absence-is-a-claim-and-a-claim-needs-an-answer).

### Offline is a queue and a cache, and a conflict is parked rather than resolved

Moved to [Offline is a queue and a cache, and a conflict is parked rather than resolved](./app-and-console/offline-conflicts-and-startup.md#offline-is-a-queue-and-a-cache-and-a-conflict-is-parked-rather-than-resolved).

### A cold start with no network is the case the offline layer was built for

Moved to [A cold start with no network is the case the offline layer was built for](./app-and-console/offline-conflicts-and-startup.md#a-cold-start-with-no-network-is-the-case-the-offline-layer-was-built-for).

### On the web the app has to be able to *start* offline, which is a service worker

Moved to [On the web the app has to be able to *start* offline, which is a service worker](./app-and-console/offline-conflicts-and-startup.md#on-the-web-the-app-has-to-be-able-to-start-offline-which-is-a-service-worker).

### A reconnection empties every queue, not the one on screen

Moved to [A reconnection empties every queue, not the one on screen](./app-and-console/offline-conflicts-and-startup.md#a-reconnection-empties-every-queue-not-the-one-on-screen).

### The offline mirror is fed by a privacy-filtered manifest, a batched read, and a create that cannot clobber

Moved to [The offline mirror is fed by a privacy-filtered manifest, a batched read, and a create that cannot clobber](./app-and-console/offline-mirror-and-tree.md#the-offline-mirror-is-fed-by-a-privacy-filtered-manifest-a-batched-read-and-a-create-that-cannot-clobber).

### Every note on the device: the mirror

Moved to [Every note on the device: the mirror](./app-and-console/offline-mirror-and-tree.md#every-note-on-the-device-the-mirror).

### The file tree is drawn from the mirror's metadata, so a folder opens without a request

Moved to [The file tree is drawn from the mirror's metadata, so a folder opens without a request](./app-and-console/offline-mirror-and-tree.md#the-file-tree-is-drawn-from-the-mirrors-metadata-so-a-folder-opens-without-a-request).

### Somebody else's change reaches an open tree as a hint per audience, never as the change

Moved to [Somebody else's change reaches an open tree as a hint per audience, never as the change](./app-and-console/offline-mirror-and-tree.md#somebody-elses-change-reaches-an-open-tree-as-a-hint-per-audience-never-as-the-change).

### Offline is more than saving: create, rename, move, delete

Moved to [Offline is more than saving: create, rename, move, delete](./app-and-console/offline-mutations-and-team-links.md#offline-is-more-than-saving-create-rename-move-delete).

### A team link's note survives the console's own cold start, and the login gate

Moved to [A team link's note survives the console's own cold start, and the login gate](./app-and-console/offline-mutations-and-team-links.md#a-team-links-note-survives-the-consoles-own-cold-start-and-the-login-gate).

### A folder page is a page, and a folder is acted on like a note

Moved to [A folder page is a page, and a folder is acted on like a note](./app-and-console/mobile-navigation-shell.md#a-folder-page-is-a-page-and-a-folder-is-acted-on-like-a-note).

### A folder's placeholder is not a row

Moved to [A folder's placeholder is not a row](./app-and-console/mobile-navigation-shell.md#a-folders-placeholder-is-not-a-row).

### A phone gets a path bar, which is half of the line that was deleted

Moved to [A phone gets a path bar, which is half of the line that was deleted](./app-and-console/mobile-navigation-shell.md#a-phone-gets-a-path-bar-which-is-half-of-the-line-that-was-deleted).

### The contexts moved into the scroller, because navigation is not a verb

Moved to [The contexts moved into the scroller, because navigation is not a verb](./app-and-console/mobile-navigation-shell.md#the-contexts-moved-into-the-scroller-because-navigation-is-not-a-verb).

### A phone has no left panel, so the one thing its footer said had to move

Moved to [A phone has no left panel, so the one thing its footer said had to move](./app-and-console/mobile-navigation-shell.md#a-phone-has-no-left-panel-so-the-one-thing-its-footer-said-had-to-move).

### A copy is one press, and it is confirmed outside the modal

Moved to [A copy is one press, and it is confirmed outside the modal](./app-and-console/mobile-navigation-shell.md#a-copy-is-one-press-and-it-is-confirmed-outside-the-modal).

### A write from outside the file browser has to say so

Moved to [A write from outside the file browser has to say so](./app-and-console/mobile-navigation-shell.md#a-write-from-outside-the-file-browser-has-to-say-so).

### A copy on the device is bounded by who read it, when, and whether the server said no

Moved to [A copy on the device is bounded by who read it, when, and whether the server said no](./app-and-console/mobile-navigation-shell.md#a-copy-on-the-device-is-bounded-by-who-read-it-when-and-whether-the-server-said-no).

### Making a workspace is its own flow, not onboarding with a flag

Moved to [Making a workspace is its own flow, not onboarding with a flag](./app-and-console/workspace-creation-and-rail.md#making-a-workspace-is-its-own-flow-not-onboarding-with-a-flag).

### Two name fields for a shared workspace, one for a personal one

Moved to [Two name fields for a shared workspace, one for a personal one](./app-and-console/workspace-creation-and-rail.md#two-name-fields-for-a-shared-workspace-one-for-a-personal-one).

### The layout presets are company-shaped, and PARA is not the default

Moved to [The layout presets are company-shaped, and PARA is not the default](./app-and-console/workspace-creation-and-rail.md#the-layout-presets-are-company-shaped-and-para-is-not-the-default).

### Invitations are queued, and a partial send keeps its successes

Moved to [Invitations are queued, and a partial send keeps its successes](./app-and-console/workspace-creation-and-rail.md#invitations-are-queued-and-a-partial-send-keeps-its-successes).

### The rail's "New workspace" entry is a verb, and the claim entry is a gap

Moved to [The rail's "New workspace" entry is a verb, and the claim entry is a gap](./app-and-console/workspace-creation-and-rail.md#the-rails-new-workspace-entry-is-a-verb-and-the-claim-entry-is-a-gap).

### The rail is one list, with the personal workspace pinned to the top

Moved to [The rail is one list, with the personal workspace pinned to the top](./app-and-console/workspace-creation-and-rail.md#the-rail-is-one-list-with-the-personal-workspace-pinned-to-the-top).

### The URL is a mirror of the open note, and the phone's copy of it is a pointer

Moved to [The URL is a mirror of the open note, and the phone's copy of it is a pointer](./app-and-console/links-and-routing.md#the-url-is-a-mirror-of-the-open-note-and-the-phones-copy-of-it-is-a-pointer).

### A URL is a context and a note, and half of one is not an instruction

Moved to [A URL is a context and a note, and half of one is not an instruction](./app-and-console/links-and-routing.md#a-url-is-a-context-and-a-note-and-half-of-one-is-not-an-instruction).

### A note link is a path with a keyword in front, because a scheme has a host

Moved to [A note link is a path with a keyword in front, because a scheme has a host](./app-and-console/links-and-routing.md#a-note-link-is-a-path-with-a-keyword-in-front-because-a-scheme-has-a-host).

### A reference follows the note it points at, and a link is something you follow

Moved to [A reference follows the note it points at, and a link is something you follow](./app-and-console/links-and-routing.md#a-reference-follows-the-note-it-points-at-and-a-link-is-something-you-follow).

### A web link opens on a click, and only a web scheme opens

Moved to [A web link opens on a click, and only a web scheme opens](./app-and-console/links-and-routing.md#a-web-link-opens-on-a-click-and-only-a-web-scheme-opens).

### A route with no way in is a route nobody has

Moved to [A route with no way in is a route nobody has](./app-and-console/links-and-routing.md#a-route-with-no-way-in-is-a-route-nobody-has).

### A context pill's target is not its mark

Moved to [A context pill's target is not its mark](./app-and-console/links-and-routing.md#a-context-pills-target-is-not-its-mark).

### The palette is a navigator, the search page is a place, and one row joins them

Moved to [The palette is a navigator, the search page is a place, and one row joins them](./app-and-console/search-and-autosave.md#the-palette-is-a-navigator-the-search-page-is-a-place-and-one-row-joins-them).

### The search page's state is its URL, and that is a trade taken on purpose

Moved to [The search page's state is its URL, and that is a trade taken on purpose](./app-and-console/search-and-autosave.md#the-search-pages-state-is-its-url-and-that-is-a-trade-taken-on-purpose).

### Four ways to have no results, and each is a different sentence

Moved to [Four ways to have no results, and each is a different sentence](./app-and-console/search-and-autosave.md#four-ways-to-have-no-results-and-each-is-a-different-sentence).

### Search is in the app's navigation, and it disappears only on a measured zero

Moved to [Search is in the app's navigation, and it disappears only on a measured zero](./app-and-console/search-and-autosave.md#search-is-in-the-apps-navigation-and-it-disappears-only-on-a-measured-zero).

### The console autosaves, and the prompt that is left is about a decision

Moved to [The console autosaves, and the prompt that is left is about a decision](./app-and-console/search-and-autosave.md#the-console-autosaves-and-the-prompt-that-is-left-is-about-a-decision).

### Reassurance is a chip in the top bar; a decision is a button over the note

Moved to [Reassurance is a chip in the top bar; a decision is a button over the note](./app-and-console/search-and-autosave.md#reassurance-is-a-chip-in-the-top-bar-a-decision-is-a-button-over-the-note).

### The breadcrumb is the whole path, and its head is a real way up

Moved to [The breadcrumb is the whole path, and its head is a real way up](./app-and-console/breadcrumb-and-navigation.md#the-breadcrumb-is-the-whole-path-and-its-head-is-a-real-way-up).

### A link key on the accessory bar, reversing the decision that dropped it

Moved to [A link key on the accessory bar, reversing the decision that dropped it](./app-and-console/breadcrumb-and-navigation.md#a-link-key-on-the-accessory-bar-reversing-the-decision-that-dropped-it).

### The communications console reads through `FileBrowser`, not a new tool

Moved to [The communications console reads through `FileBrowser`, not a new tool](./app-and-console/communications-console.md#the-communications-console-reads-through-filebrowser-not-a-new-tool).

### The compact corner was two controls, and one of them was a silent sign-out

Moved to [The compact corner was two controls, and one of them was a silent sign-out](./app-and-console/communications-console.md#the-compact-corner-was-two-controls-and-one-of-them-was-a-silent-sign-out).

### The breadcrumb head stopped being a switcher pill when it moved rows

Moved to [The breadcrumb head stopped being a switcher pill when it moved rows](./app-and-console/communications-console.md#the-breadcrumb-head-stopped-being-a-switcher-pill-when-it-moved-rows).

### A diagram lives in the note, and the browser is the only thing that makes it safe

Moved to [A diagram lives in the note, and the browser is the only thing that makes it safe](./app-and-console/diagrams-recent-and-sharing.md#a-diagram-lives-in-the-note-and-the-browser-is-the-only-thing-that-makes-it-safe).

### A phone gets Recent, because it could never get a second tab

Moved to [A phone gets Recent, because it could never get a second tab](./app-and-console/diagrams-recent-and-sharing.md#a-phone-gets-recent-because-it-could-never-get-a-second-tab).

### The share sheet is one control, and the padlock beside it is gone

Moved to [The share sheet is one control, and the padlock beside it is gone](./app-and-console/diagrams-recent-and-sharing.md#the-share-sheet-is-one-control-and-the-padlock-beside-it-is-gone).

### Storage starts with ownership, then offers existing notes

Moved to [Storage starts with ownership, then offers existing notes](./app-and-console/storage-onboarding-and-tables.md#storage-starts-with-ownership-then-offers-existing-notes).

### A connected account is one card, and its consequence is armed

Moved to [A connected account is one card, and its consequence is armed](./app-and-console/storage-onboarding-and-tables.md#a-connected-account-is-one-card-and-its-consequence-is-armed).

### Reading mode is the whole rule for a block that replaces its own source

Moved to [Reading mode is the whole rule for a block that replaces its own source](./app-and-console/storage-onboarding-and-tables.md#reading-mode-is-the-whole-rule-for-a-block-that-replaces-its-own-source).

### A grid is edited in place, and the unit that reveals is the cell

Moved to [A grid is edited in place, and the unit that reveals is the cell](./app-and-console/storage-onboarding-and-tables.md#a-grid-is-edited-in-place-and-the-unit-that-reveals-is-the-cell).

### A control on a table belongs to the row or the column it acts on

Moved to [A control on a table belongs to the row or the column it acts on](./app-and-console/storage-onboarding-and-tables.md#a-control-on-a-table-belongs-to-the-row-or-the-column-it-acts-on).

### A note may declare the mode it opens in, and the person still outranks it

Moved to [A note may declare the mode it opens in, and the person still outranks it](./app-and-console/note-editing-surface.md#a-note-may-declare-the-mode-it-opens-in-and-the-person-still-outranks-it).

### The `--lp-*` palette is a contract between two hosts, and a missing one fails silently

Moved to [The `--lp-*` palette is a contract between two hosts, and a missing one fails silently](./app-and-console/note-editing-surface.md#the---lp--palette-is-a-contract-between-two-hosts-and-a-missing-one-fails-silently).

### One save status, and a control only where pressing it does something

Moved to [One save status, and a control only where pressing it does something](./app-and-console/note-editing-surface.md#one-save-status-and-a-control-only-where-pressing-it-does-something).

### The browser-reachable console is the console, at every density

Moved to [The browser-reachable console is the console, at every density](./app-and-console/note-editing-surface.md#the-browser-reachable-console-is-the-console-at-every-density).

### The note is a measured column, and the demo note stopped faking one

Moved to [The note is a measured column, and the demo note stopped faking one](./app-and-console/note-editing-surface.md#the-note-is-a-measured-column-and-the-demo-note-stopped-faking-one).

### An icon reaches for a path only when a rectangle cannot hold one weight

Moved to [An icon reaches for a path only when a rectangle cannot hold one weight](./app-and-console/note-editing-surface.md#an-icon-reaches-for-a-path-only-when-a-rectangle-cannot-hold-one-weight).

### The read toggle's glyph is the act, so the accent fill is gone

Moved to [The read toggle's glyph is the act, so the accent fill is gone](./app-and-console/note-editing-surface.md#the-read-toggles-glyph-is-the-act-so-the-accent-fill-is-gone).

### Properties are edited in the panel, one line at a time

Moved to [Properties are edited in the panel, one line at a time](./app-and-console/note-editing-surface.md#properties-are-edited-in-the-panel-one-line-at-a-time).

### The staff console is shaped for ten customers, and its figures count rows

Moved to [The staff console is shaped for ten customers, and its figures count rows](./app-and-console/staff-console-and-panels.md#the-staff-console-is-shaped-for-ten-customers-and-its-figures-count-rows).

### Both left panels fold, and the seam between them is the control

Moved to [Both left panels fold, and the seam between them is the control](./app-and-console/staff-console-and-panels.md#both-left-panels-fold-and-the-seam-between-them-is-the-control).

### Bold is a toggle, ⌘B belongs to the note, and the right-click menu is the web's alone

Moved to [Bold is a toggle, ⌘B belongs to the note, and the right-click menu is the web's alone](./app-and-console/staff-console-and-panels.md#bold-is-a-toggle-b-belongs-to-the-note-and-the-right-click-menu-is-the-webs-alone).

## A callout is a box, and `[!type]` never reaches the reader

Moved to [A callout is a box, and `[!type]` never reaches the reader](./app-and-console/callouts-plugins-and-rail-fold.md#a-callout-is-a-box-and-type-never-reaches-the-reader).

## A plugin row's switch is the press it replaced, and a choice never becomes one

Moved to [A plugin row's switch is the press it replaced, and a choice never becomes one](./app-and-console/callouts-plugins-and-rail-fold.md#a-plugin-rows-switch-is-the-press-it-replaced-and-a-choice-never-becomes-one).

## The rail folds into the switcher, and the column it occupied goes to the note

Moved to [The rail folds into the switcher, and the column it occupied goes to the note](./app-and-console/callouts-plugins-and-rail-fold.md#the-rail-folds-into-the-switcher-and-the-column-it-occupied-goes-to-the-note).

### What it reverses, and what it only moves

Moved to [What it reverses, and what it only moves](./app-and-console/callouts-plugins-and-rail-fold.md#what-it-reverses-and-what-it-only-moves).

### What the fold cost, and where it was paid

Moved to [What the fold cost, and where it was paid](./app-and-console/callouts-plugins-and-rail-fold.md#what-the-fold-cost-and-where-it-was-paid).

## A picture of the application does not invert with the page it sits on

Moved to [A picture of the application does not invert with the page it sits on](./app-and-console/callouts-plugins-and-rail-fold.md#a-picture-of-the-application-does-not-invert-with-the-page-it-sits-on).

## A sort number is filing, so the console draws the name and keeps the number

Moved to [A sort number is filing, so the console draws the name and keeps the number](./app-and-console/callouts-plugins-and-rail-fold.md#a-sort-number-is-filing-so-the-console-draws-the-name-and-keeps-the-number).

## A folder row says what differs, so `0-inbox` gets no count

Moved to [A folder row says what differs, so `0-inbox` gets no count](./app-and-console/folder-rows-and-settings.md#a-folder-row-says-what-differs-so-0-inbox-gets-no-count).

## The workspaces come back as a row at the foot of the tree, not as a column

Moved to [The workspaces come back as a row at the foot of the tree, not as a column](./app-and-console/folder-rows-and-settings.md#the-workspaces-come-back-as-a-row-at-the-foot-of-the-tree-not-as-a-column).

### Why this one, and what the other four cost

Moved to [Why this one, and what the other four cost](./app-and-console/folder-rows-and-settings.md#why-this-one-and-what-the-other-four-cost).

### What the row costs, and where it is paid

Moved to [What the row costs, and where it is paid](./app-and-console/folder-rows-and-settings.md#what-the-row-costs-and-where-it-is-paid).

### "Move to…" is one dialog, and the other context is a destination rather than a mode

Moved to ["Move to…" is one dialog, and the other context is a destination rather than a mode](./app-and-console/folder-rows-and-settings.md#move-to-is-one-dialog-and-the-other-context-is-a-destination-rather-than-a-mode).

### Settings is seven rows, and a row has to earn its place

Moved to [Settings is seven rows, and a row has to earn its place](./app-and-console/folder-rows-and-settings.md#settings-is-seven-rows-and-a-row-has-to-earn-its-place).

### A pasted image is a width in the note and a file in the bucket, and nothing else

Moved to [A pasted image is a width in the note and a file in the bucket, and nothing else](./app-and-console/folder-rows-and-settings.md#a-pasted-image-is-a-width-in-the-note-and-a-file-in-the-bucket-and-nothing-else).

## A status wears a chip; a band is for what you have not been told

Moved to [A status wears a chip; a band is for what you have not been told](./app-and-console/workspace-identity-and-status.md#a-status-wears-a-chip-a-band-is-for-what-you-have-not-been-told).

## A workspace can wear a face, and the letter is what it falls back to

Moved to [A workspace can wear a face, and the letter is what it falls back to](./app-and-console/workspace-identity-and-status.md#a-workspace-can-wear-a-face-and-the-letter-is-what-it-falls-back-to).

### The read path takes no object name, and that is the security argument

Moved to [The read path takes no object name, and that is the security argument](./app-and-console/workspace-identity-and-status.md#the-read-path-takes-no-object-name-and-that-is-the-security-argument).

### The emoji rule is structural, and the list is ours

Moved to [The emoji rule is structural, and the list is ours](./app-and-console/workspace-identity-and-status.md#the-emoji-rule-is-structural-and-the-list-is-ours).

### Drawing a mark must not need a backend

Moved to [Drawing a mark must not need a backend](./app-and-console/workspace-identity-and-status.md#drawing-a-mark-must-not-need-a-backend).

### What is not built, stated rather than implied

Moved to [What is not built, stated rather than implied](./app-and-console/workspace-identity-and-status.md#what-is-not-built-stated-rather-than-implied).

## The allowed-sender list stays beside the address it gates

Moved to [The allowed-sender list stays beside the address it gates](./app-and-console/sidebar-tree-and-testing.md#the-allowed-sender-list-stays-beside-the-address-it-gates).

## The tree is drawn from the press, and `privacy.md` is what it may not guess

Moved to [The tree is drawn from the press, and `privacy.md` is what it may not guess](./app-and-console/sidebar-tree-and-testing.md#the-tree-is-drawn-from-the-press-and-privacymd-is-what-it-may-not-guess).

## What the sidebar can do to a folder, the listing can do to it too

Moved to [What the sidebar can do to a folder, the listing can do to it too](./app-and-console/sidebar-tree-and-testing.md#what-the-sidebar-can-do-to-a-folder-the-listing-can-do-to-it-too).

### The sort control was a third instance, and it had nothing to point at

Moved to [The sort control was a third instance, and it had nothing to point at](./app-and-console/sidebar-tree-and-testing.md#the-sort-control-was-a-third-instance-and-it-had-nothing-to-point-at).

### The evidence is the drawn tree, because a hook's state is not a screen

Moved to [The evidence is the drawn tree, because a hook's state is not a screen](./app-and-console/sidebar-tree-and-testing.md#the-evidence-is-the-drawn-tree-because-a-hooks-state-is-not-a-screen).

### The corner makes five things, and one of them needs a key (2026-09-19)

Moved to [The corner makes five things, and one of them needs a key (2026-09-19)](./app-and-console/sidebar-tree-and-testing.md#the-corner-makes-five-things-and-one-of-them-needs-a-key-2026-09-19).

### A control mounted by nobody passes every test of itself

Moved to [A control mounted by nobody passes every test of itself](./app-and-console/sidebar-tree-and-testing.md#a-control-mounted-by-nobody-passes-every-test-of-itself).

### A fixture that cannot show the thing under review is reporting on itself

Moved to [A fixture that cannot show the thing under review is reporting on itself](./app-and-console/sidebar-tree-and-testing.md#a-fixture-that-cannot-show-the-thing-under-review-is-reporting-on-itself).

## Nothing is named before it is written, and the phone's `+` is the only key

Moved to [Nothing is named before it is written, and the phone's `+` is the only key](./app-and-console/quick-create-and-activity-feed.md#nothing-is-named-before-it-is-written-and-the-phones-is-the-only-key).

### A new note is never a dialog

Moved to [A new note is never a dialog](./app-and-console/quick-create-and-activity-feed.md#a-new-note-is-never-a-dialog).

### The phone's bottom row is six keys, and the `+` is all of them

Moved to [The phone's bottom row is six keys, and the `+` is all of them](./app-and-console/quick-create-and-activity-feed.md#the-phones-bottom-row-is-six-keys-and-the-is-all-of-them).

### A phone can ask its context a question, and could not before (2026-09-19)

Moved to [A phone can ask its context a question, and could not before (2026-09-19)](./app-and-console/quick-create-and-activity-feed.md#a-phone-can-ask-its-context-a-question-and-could-not-before-2026-09-19).

### The feed is a file, and the console is a viewing layer over it

Moved to [The feed is a file, and the console is a viewing layer over it](./app-and-console/quick-create-and-activity-feed.md#the-feed-is-a-file-and-the-console-is-a-viewing-layer-over-it).

## A share card wears the app's palette, and leads with the workspace

Moved to [A share card wears the app's palette, and leads with the workspace](./app-and-console/share-cards-and-collab-room.md#a-share-card-wears-the-apps-palette-and-leads-with-the-workspace).

### The workspace leads and the domain is a footnote

Moved to [The workspace leads and the domain is a footnote](./app-and-console/share-cards-and-collab-room.md#the-workspace-leads-and-the-domain-is-a-footnote).

### The chip is tied to the listing, not to the row

Moved to [The chip is tied to the listing, not to the row](./app-and-console/share-cards-and-collab-room.md#the-chip-is-tied-to-the-listing-not-to-the-row).

### What a "simplification" would cost

Moved to [What a "simplification" would cost](./app-and-console/share-cards-and-collab-room.md#what-a-simplification-would-cost).

### One image, not two

Moved to [One image, not two](./app-and-console/share-cards-and-collab-room.md#one-image-not-two).

### The static card's pipeline is a script now, because the old one was unrunnable

Moved to [The static card's pipeline is a script now, because the old one was unrunnable](./app-and-console/share-cards-and-collab-room.md#the-static-cards-pipeline-is-a-script-now-because-the-old-one-was-unrunnable).

## The room binds to a document it agrees with, and a different note unbinds first

Moved to [The room binds to a document it agrees with, and a different note unbinds first](./app-and-console/share-cards-and-collab-room.md#the-room-binds-to-a-document-it-agrees-with-and-a-different-note-unbinds-first).

### A different note is the `notePath` effect's, not the `value` effect's

Moved to [A different note is the `notePath` effect's, not the `value` effect's](./app-and-console/share-cards-and-collab-room.md#a-different-note-is-the-notepath-effects-not-the-value-effects).

### A binding needs the same text on both sides, so an empty room is waited on

Moved to [A binding needs the same text on both sides, so an empty room is waited on](./app-and-console/share-cards-and-collab-room.md#a-binding-needs-the-same-text-on-both-sides-so-an-empty-room-is-waited-on).

### What a "simplification" would cost

Moved to [What a "simplification" would cost](./app-and-console/share-cards-and-collab-room.md#what-a-simplification-would-cost-1).

## Several rows are one operation, and a pick is what the keyboard acts on

Moved to [Several rows are one operation, and a pick is what the keyboard acts on](./app-and-console/share-cards-and-collab-room.md#several-rows-are-one-operation-and-a-pick-is-what-the-keyboard-acts-on).

## No UI ships without a design audit first (2026-09-23)

Moved to [No UI ships without a design audit first (2026-09-23)](./app-and-console/share-cards-and-collab-room.md#no-ui-ships-without-a-design-audit-first-2026-09-23).

### The first run is two screens, and the rest is a checklist in the console (2026-09-25)

Moved to [The first run is two screens, and the rest is a checklist in the console](./app-and-console/first-run.md#the-first-run-is-two-screens-and-the-rest-is-a-checklist-in-the-console-2026-09-25).

### An action row is primary first, and the way out sits beside it (2026-09-25)

Moved to [An action row is primary first, and the way out sits beside it](./app-and-console/design-tokens-and-interaction.md#an-action-row-is-primary-first-and-the-way-out-sits-beside-it-2026-09-25).
