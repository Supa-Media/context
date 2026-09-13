# The mobile app and the console

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### The note count is measured, stamped, and allowed to be a floor

For two issues running (#20, #25) the console printed facts about somebody's
bucket that nothing had measured: "1,284 notes across all", "2.4 GB in your own
bucket", "Reachable — 1,284 objects" — over a live bucket holding six. The fix
then was to delete the tiles, because there was no honest number available. The
tile is back, and four things are what make it safe.

**It counts notes, not objects.** `.history/` on a context connected before
snapshots stopped holds every revision of every file: tens of thousands of
objects standing for a few hundred notes. An object count wearing the label
"your notes" is the original bug with a measurement attached — and it stays
wrong for every such bucket, none of which get smaller on their own.

**The walk is delimited at the root, then flat inside each real folder.** Not
an optimisation. A flat listing returns `.history/…` first, because `.` sorts
before every digit and letter, so a flat walk with any page budget spends it
inside the history and reports **zero notes for the largest contexts there
are** — the same trap `hasExistingContext` documents, and the first version of
the test for it was vacuous because the seeded history fit inside the budget.
Sabotaging the delimiter is what found that.

**Absent is not zero, at every layer.** `countNotes` returns `null` rather than
throwing or reporting `0`; `recordVerification` leaves the previous count
standing when a probe brings none; `totalNotes` returns `null` when nothing has
been counted and the console renders no tile rather than an em dash. A `0`
anywhere on that path means "this person has no notes", and a listing that
failed partway would be saying it about somebody's life's work.

**A floor is never printed as a total.** The walk is bounded — it runs against
a bucket we do not own, on their request quota — so `noteCountTruncated` travels
with the number, and a total is also a floor when a context that *has* a bucket
has not been walked. Both render `1,284+`. A precise-looking number that is not
the truth is #25 with a measurement in front of it.

`noteCountedAt` is stored separately from `lastVerifiedAt` for the same family
of reasons: a verification can succeed and learn nothing about the contents, and
dating a stale count from a fresh probe is a quieter version of inventing it.
Nothing re-counts on a schedule, so the storage card prints the count's own date
beside it rather than letting a months-old number read as current.

Three more places the absence has to survive, each of which was wrong first:

- **A rebind clears it.** A rebind points at a different bucket, so a count
  carried across is a number about somewhere else. Left standing it produced
  `status: "error"` beside a confident total for a bucket nothing had reached.
- **Loading is not "no bucket".** `totalNotes` takes the binding, `null` for a
  context with no bucket, and `undefined` for one whose query has not landed.
  Collapsing the last two made every first paint print an *exact* total that
  was missing a whole bucket's notes.
- **The status write does not wait on the walk.** `recordNoteCount` is its own
  internal mutation, called after `recordVerification`. Folded together, up to
  forty sequential LIST round trips sat inside the window where the binding
  still read `unverified`, and an action that died mid-walk left a good bucket
  permanently unverified over a number nobody was waiting for.

And one thing a single `try` got wrong: the folder prefixes fed back into
`store.list` are **names the customer chose**, and the adapter's
`assertSafePrefix` throws on a backslash, a control character or a `.`/`..`
segment. Under one outer catch, a single oddly named folder silently suppressed
the count for that whole bucket forever. Each folder is walked in its own `try`
now, and one that will not walk makes the total a floor.

### One runtime version, pinned, and native deps gated behind it

A Supa Media convention rather than this app's decision, and it governs how
everything ships: **every app in the estate pins a single runtime version and
delivers almost all changes over the air.** An older app carries whatever number
it was pinned at years ago (togather is in the 1.0.2x range); a new one starts
at `1.0.0` and stays there. Nobody wants to maintain a runtime per client
version, so nobody creates one.

`app.config.js` said `runtimeVersion: { policy: "appVersion" }`, which reads as
harmless and is the trap. That policy makes the runtime track the `version`
field, so **the first App Store release that bumps `1.0.0` to `1.0.1` forks the
runtime.** Every install still on 1.0.0 lands on an orphaned one: `eas update`
keeps publishing, those clients keep polling, and nothing reaches them again.
No error, no log, no crash — they simply stop updating. It is now the literal
`"1.0.0"`, so the marketing version can move as often as the store wants it to
and the runtime does not follow.

**What that buys is one update channel reaching every install ever shipped.
What it costs is the assumption that an update's JS can rely on the native
modules it was built against** — that bundle will land on clients built months
earlier. So the two halves are one policy:

- `native-deps.json` `core` is the baseline every build has and may be imported
  statically. Anything added afterwards goes in `gated`, is imported
  **dynamically behind a runtime check**, and must degrade to a real fallback
  rather than throwing. `supa-framework.test.js` runs the framework's scanner
  (`tests.nativeImports`) so a static import of a gated dependency fails CI
  instead of crashing somebody's phone.
- The repo already has the shape of the fallback in its platform splits:
  `useUnsavedGuard`'s native half is a documented no-op, and `writeClipboard`
  returned `false` on native for as long as there was no module to call rather
  than claiming "Copied" over one. An absent capability is reported honestly;
  it is never faked. (That one is no longer absent — see below.)

**The second enforcer was inert for the life of the repo, and the fix is why
`native-deps.json` keeps the shape it has.** `@supa-media/linter`'s preset turns
`no-ungated-native-import` on at `"error"`; the rule builds its gated set by
iterating the file as a package -> classification **map**, returns an empty
visitor when that set is empty, and this repo writes the `core`/`gated` **array**
dialect that `@supa-media/testing`'s scanner requires and that its own error
message prescribes. Two packages of one framework disagreeing about one file's
format, silently, in the direction where the check reports nothing. Measured
with `react-native` moved into `gated`: `eslint .` found **0** while the scanner
found **77**. Bridged, the same experiment reports 77 from both and lint fails.

The arrays stay. Reformatting the file into the map dialect to satisfy the rule
trades one guard for the other — measured, the scanner then reports all 51 deps
unclassified and scans nothing — and keeping both dialects in one file is one
list authored twice. So `eslint.native-deps.js` derives the map from the arrays
on every lint run and passes it through the rule's own `nativeDepsPath` option,
which is the only configuration `meta.schema` offers. Upstream's matching logic
runs unmodified, so this is a bridge and not a second implementation of the
rule — and the reach it restores is real rather than duplicated. **The two are
complementary in both directions and neither is a superset**, which is the part
to get right, because this is where somebody decides whether one can stand in
for the other. Measured over one file holding all five shapes: the rule sees a
plain import, a sub-path import (`dep/inner`) and an unguarded top-level
`require()`, because it visits `ImportDeclaration` and `CallExpression`; the
scanner sees a plain import and both re-export forms (`export { C } from`,
`export * from`), because its regex matches `…from "spec"` — but its exact
`Set.has` cannot see a sub-path and it never looks at `require()`. Barrel files
are routine in an Expo app, so neither half is academic. Both also flag
type-only imports, which TypeScript erases; that false positive is inherited
rather than introduced, and arrives twice the day a dependency is gated.

`__tests__/nativeImportGuard.test.js` proves the rule *fires* — resolving is
what `lintRuns.test.ts` already asserted, and resolving was never the problem —
and pins the upstream defect, so the day the rule learns the array dialect that
test fails and says to delete the bridge. **The real fix belongs upstream**, in
the rule, next to the parser defect this file's neighbour already records.

**What this closed is a hole in the future, not one in the present**, and that
distinction is worth keeping straight. `gated` is empty, so the rule reports
nothing today whether it is bridged or not, and no ungated import has ever
slipped past. What was actually wrong is that the guard standing between the
first gated dependency and a bundle that crashes an old phone had never been
run — it would have been reached for on the day it mattered and would silently
have said nothing. The value delivered is that it is now checked, in the sense
this file means by "a guard nobody has checked is not a guard", and the day a
dependency needs gating is not the day to find out.

`__tests__/runtimeVersion.test.js` asserts both halves together, because either
one alone is a bug and both fail silently. The version half is asserted as a
*property* — the runtime does not move when `version` does — rather than as two
strings that happen to read `1.0.0` today, which the policy this replaced would
also satisfy.

**The one legitimate reason to change the string** is a native change no gate
can paper over, such as an Expo SDK upgrade that moves the ABI. Bumping it then
strands every existing install on its current JS until people update through
the store; that is the real cost of the upgrade and belongs in the PR that does
it, stated. Bumping it for any other reason — or restoring the `appVersion`
policy because it looks tidier — is how the estate ends up with a runtime per
release.

### The native baseline was chosen once, before the first build

The corollary of the pin, and it has already been spent. Because
`runtimeVersion` never moves and every change ships over the air, **the set of
native modules in the first binary is the set the app has**, and the only
moment that set was free to choose was before that binary existed. An OTA
bundle cannot add a native module; it can only find one already there.

So the first build deliberately installed far more than the app used: 51
packages in `native-deps.json` `core`, covering files and attachments, image
and media capture, gestures/reanimated/svg/webview, OAuth browser flows,
local and Apple authentication, and the small system modules. Most of them are
imported nowhere. That is the point — the cost of carrying an unused module is
binary size, and the cost of missing one is a new build plus a reinstall by
every user.

**Info.plist permission strings are part of the baseline for the same reason.**
A usage string is as native as the module it belongs to, and a feature built
later against a missing one does not degrade — iOS terminates the app the
moment it asks. They are declared in the config-plugin blocks in
`app.config.js`, never duplicated into `ios.infoPlist`, so each permission has
one source of truth. Nothing requests any of them yet.

Two consequences worth stating:

- **`core` is now genuinely an inventory, not just a permission list**, because
  everything in it is installed. `gated` is empty and is where anything added
  *after* the first build must go — dynamically imported, behind a runtime
  check, with an honest fallback.
- Several documented "deliberate native gaps" are no longer blocked by a
  missing dependency, only by nobody having written the code:
  `fonts.ts` being a no-op (expo-font) and `useUnsavedGuard` (async-storage).
  Each is a project, not a config change — but the native half is paid for.
  **`writeClipboard` has been spent**: it calls `expo-clipboard` now, which is
  a static import needing no gate and no `runtimeVersion` bump precisely
  because it is in `core`. What forced it was the share dialog learning to
  *say* what happened: an honest permanent "no" nobody displayed became
  "Couldn't reach the clipboard" in front of somebody in the app, and reporting
  an absent capability is right only while it is genuinely absent.
  **The fourth one has been spent**: iOS Live Preview is built, on the
  `react-native-webview` the baseline was carrying for exactly this. See below.

### The iOS editor is the web editor, in a WebView, from a committed bundle

CodeMirror is a DOM library, so `apps/mobile` ships two hosts for one editor:
`LiveEditor.web.tsx` mounts it in a `<div>`, `LiveEditor.tsx` mounts it inside a
`WebView` over a five-message JSON bridge. The configuration itself — keymap,
read-only facets, update listener — is `editorSetup.ts`, imported by both,
because a read-only rule fixed on one surface and not the other is the failure
this arrangement exists to prevent. `LiveEditor.tsx`'s header argued at length
that a WebView would be worse than the gap; which halves of that argument
expired and which one still stands is recorded there rather than deleted.

Three things about it are decisions rather than implementation:

- **The bundle is committed, not fetched and not built at deploy time.**
  `webview/bundle.generated.ts` is ~500kb of minified CodeMirror produced by
  `scripts/build-editor-bundle.mjs`. Fetching it is out — the app works offline
  and the note lives in a bucket the customer owns — and building it during
  `expo export` is out because `runtimeVersion` is pinned, every change ships
  over the air, and an OTA bundle that needed a build step nobody ran would be a
  blank editor on a phone. The document's own CSP is `default-src 'none'`, so
  "local, not remote" is structural rather than a promise. The cost is a
  generated artifact in the tree; `__tests__/editorBundle.test.ts` hashes every
  source that went into it and pins every package version it was built from, so
  a stale bundle fails CI with the command to run.
- **`@codemirror/*` must never be imported from the native path.** The editor
  reaches the phone as a *string*. An import in `LiveEditor.tsx`,
  `webview/host.ts` or `webview/protocol.ts` would carry it twice and put a DOM
  library in the React Native module graph, which is what `livePreview.ts`'s own
  header calls out as having broken native rendering twice in the sibling app.
  Asserted rather than assumed, in the same test.
- **`EditorState.readOnly` is not sufficient either**, which is the second
  chapter of the trap PR #158 fixed. It is what the *commands* consult and most
  of them do — but it is a convention, and `@codemirror/commands` breaks it
  itself: `insertNewline` replaces the selection without looking. `editability()`
  therefore also sets an `EditorState.changeFilter`, and the only document change
  a read-only note accepts is one annotated `externalDoc` — the app putting a
  different note in front of the reader, which is why `privacy.md` still opens.
  That annotation is also what stops *opening* a note reporting itself as an
  edit of it.

### Every react-native-web `View` is a stacking context, so a `zIndex` is local

`react-native-web/dist/exports/View/index.js` puts `position: relative` and
**`z-index: 0`** in the base style of every `View`. So each one opens a stacking
context, and a `zIndex` set anywhere inside it is an ordering *among that
element's own descendants* — it says nothing about the rest of the screen. What
decides whether a thing paints over a thing somewhere else is the z-index of
their nearest common ancestors, all of which sit at `0` and therefore fall back
to "later sibling wins".

This has now cost two features, in the two available directions. `AppFrame.tsx`
records the first in its own words: the accessory bar "cannot simply paint over"
the bottom toolbar because "their `zIndex`es are compared in different stacking
contexts and the toolbar wins whatever either of them asks for" — so the panels
are *ordered in the tree* instead, and the one place that needs the opposite
pays for it with an explicit `zIndex` and a comment saying why. The second is
issue #197: the rail's context menu asked for `zIndex: 30`, got it, and still
drew under the next rail group, because the 30 was spent inside its own anchor.

Two consequences worth having in hand before reaching for a number:

- **Raising the element you can see is almost never the fix.** The fix is to
  find the level at which the two things are actually siblings, and raise the
  ancestor on the winning side. Raising anything lower is a no-op that looks
  like a change.
- **Paint order and hit-testing are one mechanism, not two.** The browser
  hit-tests in paint order, so the element drawn on top is the element that
  takes the click — measured, not assumed (`__tests__/contextMenu.test.ts`
  records the `elementFromPoint` runs). That is why a z-index fix cannot leave
  the visual half right and the pointer half wrong; it is also why a fix that
  reorders the *tree* instead has to be checked against reading order and tab
  order, which is the trade `AppFrame.tsx` took.

Neither of these can be seen by a test that renders to a string, and jsdom lays
nothing out and hit-tests nothing. What is assertable in CI is the declaration:
walk from the raised element to the nearest clipping ancestor and check that at
every level it out-ranks its later siblings. A checker of that shape asserts it
found *nothing*, so it needs a self-test, per "A guard nobody has checked is not
a guard" — the first version of the one in `contextMenu.test.ts` stopped its
walk at the first element and went green against the bug it was written for.

### There are two palettes, and a screen may not hold either one

`app.config.js` says `userInterfaceStyle: "automatic"`, and that is now true:
`features/design/tokens.ts` exports `darkColors` (the signed-off mockup) and
`lightColors` (designed against it), and a subtree draws in whichever
`useColorScheme()` reports. `resolveScheme` treats only an explicit `"light"` as
light, so a platform that will not say lands on dark — the app's own ground.

**The rule that keeps it working:** no module may hold a palette. There is no
`colors` export to import, because `StyleSheet.create` at module scope closes
over its values at module load, and a screen built that way can never change
appearance — no re-render rebuilds it. So a stylesheet is a *function of* a
palette:

```ts
const makeStyles = (colors: Colors) => StyleSheet.create({ … });

export function Panel() {
  const styles = useThemedStyles(makeStyles);
}
```

The parameter is named `colors` and the result `styles` everywhere, so
converting a stylesheet touches two lines and leaves every `colors.x` and
`styles.x` alone. The same trap catches smaller things and they get the same
treatment: a `Record<Tone, string>` map, a default parameter value
(`color = colors.text2` is evaluated in the parameter list, before any hook has
run), a `<style>` element injected once into the document. Non-React code takes
a `Colors` as an argument.

Both palettes declare the same keys — `lightColors: Colors` makes a missing one
a compile error rather than a black-on-black surface — and the light one's
contrast is asserted in `__tests__/theme.test.ts`, not claimed in a comment.
Writing those assertions first caught four tokens that looked right and measured
under AA. The elevation tokens are *re-ranked* between the two rather than
inverted, because in a light world elevation and interaction move in opposite
directions; `tokens.ts` says which token does which job.

The shell cannot ask React — it is a static document and paints the page before
any app code runs — so it carries the two grounds as literals under a
`prefers-color-scheme` query, pinned against the palettes by
`__tests__/htmlShell.test.ts`. Which file that is, and why it moved, is the
next section.

### The web shell is `public/index.html`, because `+html.tsx` is a static-rendering file

The shell lived in `app/+html.tsx` for the whole life of the web app, painted
both grounds under a `prefers-color-scheme` query, linked the three type
families, and set `referrer: no-referrer` so the sign-in code in an invitation
URL is never handed to Google Fonts. It was tested. **None of it ever reached a
browser.**

`+html.tsx` is part of Expo Router's *static rendering*: it wraps each route's
HTML when `expo.web.output` is `"static"` or `"server"`. This app's `output` is
unset, which means `"single"` — a single-page export, whose document
`@expo/cli` builds in `createTemplateHtmlAsync` from `public/index.html` when
one exists and from its own stock template when one does not. That function
never looks at `+html.tsx`. There was no `public/`, so every visitor got the
stock template: no ground colour on `html`/`body`, no fonts, no referrer
policy.

What that cost is measurable, and was measured against a real
`expo export -p web` driven by headless Chromium at 20 Mbps: `/console/@name`
painted **pure white for 1.9 seconds** — fetch, parse and run 3.3 MB of
JavaScript — and then the app mounted and repainted the viewport `#050506`. A
white-to-black flash on every load and every refresh, on every URL, for every
dark-mode visitor; light-mode visitors got the mirror of it on any screen whose
first surface is not white. It was reported as "an ugly flicker" and it is not
a rendering bug in the app at all: the app was not on screen yet.

So the shell is now `public/index.html` — the file that single-page output
actually reads — and `+html.tsx` is deleted rather than left as a second copy
to drift. Three things follow, and each is a test:

- **The suite must read the file that ships.** `htmlShell.test.ts` asserted the
  palette against `+html.tsx` and was green for as long as the site was
  flashing. It now reads `public/index.html`, asserts `web.output` is still
  single, and fails if `app/+html.tsx` comes back — a shell in a file the
  bundler ignores is a shell nobody sees.
- **Expo fills this file in, so its substitution targets are unique.**
  `%LANG_ISO_CODE%`, the title placeholder, the closing head tag and
  `<div id="root">` are each the target of a plain `String.replace`, which
  takes the *first* match. Writing this explanation into the file proved the
  point immediately: the favicon link Expo inserts before the closing head tag
  landed inside the paragraph describing where Expo inserts it, and the export
  shipped with no favicon. The long form belongs here; the file keeps a
  pointer.
- **The head link carries `id="context-fonts"`,** which is what
  `ensureFontsLoaded` looks for. Without it that function cannot see the link
  already in the head and appends a second one on every web load.

The accepted cost is that a render-blocking stylesheet on a third-party host is
now on the critical path: if Google Fonts is slow, the app's mount waits on it.
That was the original intent — type at first paint rather than a swap — and the
shell's ground still paints immediately either way, so the failure mode is a
late app on the right colour rather than a flash of the wrong one.

**None of this makes the 1.9 seconds shorter.** The bundle is 3.3 MB
uncompressed, 880 kB gzipped, and until it has run there is no console. What
changed is that the wait is now the app's own ground instead of the browser's
white. Splitting that bundle is a separate piece of work and a real one.

### A long press has two signals, because the platform is watching the finger too

The gesture shipped, its tests passed, and on a phone it did nothing.

The timer is the obvious implementation and it is correct: touch down on a
link, hold `LONG_PRESS_MS`, ask the host. Driven as real touch events in
headless Chromium under touch emulation it fires exactly as written. **On iOS
it fired approximately never**, and the reason is that the page is not the only
thing watching the finger: WebKit's own long-press recogniser — the one that
raises the selection magnifier over editable text — claims a stationary touch
and tells the page by sending `touchcancel`. The handler treated that as *give
up*. The gesture was being cancelled by the very thing that had recognised it.

So a long press arrives two ways and either one is the press:

- **the timer**, for every browser that leaves the touch alone; and
- **`contextmenu`**, which is the platform *reporting* a long press rather than
  silently taking it.

`contextmenu` is honoured only while one of our touch gestures is live, and
that is the load-bearing half of the rule: the same event is a right-click on a
pointer device, and answering that with "open this note?" would take the
browser's menu away from every note on a desktop. The handler reads whether a
touch of ours is pending, never the event.

And `touchcancel` no longer cancels a finger that has not moved — the timer is
left to run, which is what turns WebKit's interruption into the press it was
recognising. A scroll has already drifted past the slop by then, and a cancel
that arrives inside `PRESS_CANCEL_FLOOR_MS` is something interrupting a touch
that had not become anything yet, so it is still dropped. `.cm-note-link` also
carries `-webkit-touch-callout: none`, scoped to the link span so the rest of
the note keeps every selection affordance it has.

Two signals cannot become two dialogs and no flag says so: `press` cancels the
pending gesture on its way out, so whichever signal arrives first takes the
timer with it. A first draft carried an `emitted` boolean as well, and
sabotaging it changed no test's outcome — it was guarding a case `cancel` had
already closed, which is the only evidence that matters about a guard.

What a simplification of this costs: restoring the one-signal version puts the
feature back to working everywhere except the platform it was asked for.
`__tests__/editorLinks.test.ts` drives the WebKit sequence — `touchstart`, then
`touchcancel` at 300ms with the finger still on the link — and each of the four
rules fails its own test and only its own when reversed.

### A launch is not a screen, and an empty list is not an empty account

A native cold launch, filmed: the splash for four hundred milliseconds, a full
second of white, **the Map for a single frame**, white again, then the note.
Five states to reach one note, and two of them were wrong rather than merely
slow.

**The Map frame was a decision reversed on evidence.** The version above of
this file answered a blank cold-launch pane by drawing the Map whenever
`contexts` was empty, reasoning that "the Map is what this route draws anyway
until the list arrives". Wrong twice. For somebody who has contexts the Map is a
screen they are about to be redirected out of, so drawing it is a transition
that exists only to be undone — a flicker by construction, whatever it says. And
what it said was a picture of an account with nothing in it: "0 reachable", "0
connected", a lone "You" node, "0 in your context", "0 AI clients connected".
Every number counted a list whose first round trip was outstanding.

So `landingStep` takes `listed`, and answers `wait` until the workspace list has
actually arrived. The Map is then what it always meant — the pane for an account
that really can reach nothing — and the counts around the console follow the
same rule as `ConsoleData.storage`: the "N reachable" chip, the Map's "N
connected" pill and the stat tiles are **absent, not zero**, until the list has
answered. `stats` already worked this way for the note total ("the tile is
absent, not zero, until something has walked at least one bucket"); the other
two tiles simply had not been held to it.

The blank that reversal restores is not a new state: the console layout's chrome
is up around it, and the same quiet pane is there a moment later while the note
is read. Waiting adds no transition rather than adding a wrong one.

**The white second was the launch image being dismissed too early.** Expo hides
it when the JavaScript bundle finishes evaluating; the app has nothing to draw
until `useConvexAuth` has restored the stored token and opened its socket, which
is a network round trip later, and `(app)/_layout` renders `null` for all of it.
Two different questions, and the default answers the easier one. `splash.ts`
holds the launch image past the bundle and releases it when the session
resolves — one transition instead of two with a sheet of white between them.

It is bounded by `SPLASH_DEADLINE_MS`, and that is not belt-and-braces: what is
being waited on is a network round trip, so offline `isLoading` stays true for
as long as the socket keeps retrying and an unbounded hold is a permanent launch
image. The release lives in the root layout rather than in `(app)` because a
launch to `/login`, to an invitation or to the landing page must not sit behind
a splash until the deadline.

What a simplification of either costs: drawing the Map for an unresolved list
puts a picture of an empty account back on the way to somebody's notes, and
dropping the deadline turns a plane journey into an app that will not start.
`consoleLanding.test.ts`, `lastPlace.test.ts`, `emptyConsoleStats.test.ts` and
`splashHold.test.ts` each fail on their own rule and only theirs.

The harness in `emptyConsoleStats.test.ts` had the same confusion written into
it, which is why it stayed green through all of this: it mounted a client that
never resolves a query and called that "exactly the state a brand-new account is
in". It is the state a *loading* console is in. A fixture that cannot tell the
two apart cannot catch a bug that is exactly their difference.

### An absence is a claim, and a claim needs an answer

Three states, not two, wherever the console says something is missing. Filmed
on a phone refreshing a note, the console spent the first half-second telling
the truth about nothing:

- **"No bucket is connected to this context yet"**, with a *Connect a bucket*
  button, across the Browse pane of a context whose bucket has been connected
  for months — and "no bucket connected" in the chrome beside it.
- **"Choose a note to read or edit it"**, over a URL that had already chosen
  one, for about a quarter of a second.

Neither condition was wrong about what it tested. Both were wrong about what
the value *meant*.

`ConsoleData.storage` was `ConsoleStorage | null`, and `null` was doing two
jobs: "this context has no bucket" and "the binding subscription has not
answered". The guard against the second was `!data.loading` — and `loading` is
the **workspace list**, a different query, which lands first. The binding is
only added to the query spec once a context is selected, so it is necessarily a
round trip behind the thing that was guarding it. `storage` is
`ConsoleStorage | null | undefined` now, `undefined` means *ask again in a
moment*, and the four places that used to read an absence off it — the Browse
banner, the top-bar pill, the phone's binding line, the settings pane — each
check which one they are holding. `storagePillLabel` still answers `null` to
both, because its one caller that needs no check is the status bar, which
*omits* a segment rather than printing a claim.

The third of those read "the phone's tree detail" when this was written, and it
was the file tree's footer. A phone has no file tree; the same line is the foot
of the **context root page** now (`files/contextFoot.ts`, drawn by
`FolderView`). That moves where it is drawn and changes nothing about the
three-state read, which is why it is corrected here rather than re-argued.

The empty state is the same shape one layer down. `selectedPath` moves the
instant somebody picks a note; the body is a Convex action away and a folder's
listing is another, and in between `entryAt` has nothing to answer with — a
state indistinguishable from an empty console unless the browser says so. The
first fix for this named only the gap *before* `select` was called
(`pendingNote`), which closed about a tenth of a second and left the longer
quarter-second untouched, because `pendingNote` goes `null` at exactly the
moment the second gap opens. `FileBrowser.opening` is the browser's own answer
to "the selection has not arrived yet", and the pane draws nothing while either
is set.

**`opening` is not "a path is selected".** It clears on a failed read, and that
is load-bearing rather than tidy: the pane is blank while it is set, so a flag
that survived a refusal would leave somebody on an empty region under an error
notice with nothing telling them what to do next — a worse screen than the
flicker, and one no render test of the pane can catch, because the pane is not
what fails to clear it. `__tests__/openingNote.test.ts` drives the real hook
and pins all three transitions; sabotaging each one fails that test and only
that test.

What a simplification of this costs: collapse either field back to two values
and the console goes back to accusing people of having no bucket, and telling
somebody opening a note to open a note. The tests that fail are
`storageUnknown.test.ts` (every case has its `null` control beside it, so
deleting the claim outright fails too) and the four "choose a note" cases in
`browseShare.test.ts`.

`opening` clearing is not the only thing a stale read must not do. `openNote`
closes over `workspaceId` with no generation of its own, and `useFileBrowser`
is one instance for the whole console — so a read still in flight when
somebody switches context, opens a second note before the first lands, or
`deselect`s before either resolves, used to answer regardless: note A's body
under context B's chrome, or note B's request settled by note A's text.
`openRun`, the same generation-counter shape `saveRuns`/`operationRun` already
use for a write and a toolbar operation, is bumped on a context switch, on
every new `openNote`, and on `deselect`, and `openNote` compares its own
generation before every `dispatch` and `setNotice` rather than trusting
whichever answer arrives first. **A read answers the request that made it, or
nobody.** `__tests__/openNoteRace.test.ts` drives all three shapes against the
real hook; dropping the comparison fails exactly those three and nothing else.

### Offline is a queue and a cache, and a conflict is parked rather than resolved

The console holds a customer's notes and is used on laptops and phones, so
losing the connection is an ordinary Tuesday rather than an edge case. What made
that expensive is a property of the stack rather than a missing feature:
`listFiles`, `readNote` and `writeNote` are Convex **actions**, and
`ConvexReactClient.action()` has no client-side timeout — offline they neither
resolve nor reject. So the tree sat empty forever, and Save sat in `saving` for
thirty seconds before saying "we don't know whether that save landed" about a
save that certainly had not.

`features/offline` is the answer, and the decisions in it are the ones a tidy-up
would reverse.

**The cache is a disposable derivative and the queue is not.** Notes and
listings are copies of the customer's files (non-negotiable #3), so they are
bounded — thirty days and 200 entries, oldest first — and deleting all of them
loses nothing but round trips. A **draft** and a **queued write** are text a
person typed that has never reached the bucket; they are never swept, never
bounded, and leave only by being written to the bucket or by that person letting
them go. `sweep()` is the eviction path and it cannot see either kind. An
eviction that could is data loss wearing the word "cache".

**A queued write is the same conditional write the Save button makes, made
later.** It carries the etag the draft was typed against and goes through
`writeNote` with `expectedEtag`, so it inherits the server's
`onlyIf: { etagMatches }` where the bucket has one and its read-compare where it
does not, and the same `CONFLICT` with the same `currentEtag` when somebody got
there first. There is no second write path and no "force" flag anywhere in the
drain. A drain that dropped `expectedEtag` to get things through would be
last-write-wins with extra steps, and would look like a bug fix.

**`enqueue` never advances `baseEtag`.** Superseding a queued write takes the
newer *text* only. Taking a fresher etag — from a background reload, from a
listing refresh — would silently turn "replace the version I read" into "replace
whatever is there now", which is a clobber performed by a code path nobody
pressed.

#### The conflict decision

When the etag has moved by the time a write is made — the queue draining, or an
ordinary Save — the write is **parked**: nothing is written, the text is kept
untouched, and it waits for a person. It is never retried automatically:
automatic retry of a conflict is last-write-wins on a timer.

**Three answers, all of them in the app, and nothing reaches the bucket until
one is chosen** (decided by the owner, 2026-08-31):

- **Keep theirs** — discard the local draft and load the bucket's version. The
  only path in the console that destroys somebody's typing, and it writes
  nothing at all. Refused, rather than offered and blind, while the bucket's
  version has not been read: adopting a version nobody has seen is a coin toss.
- **Keep mine** — write the draft over the version they were just shown,
  conditionally on it.
- **Merge** — a genuine three-way merge of the two, **shown for review and
  editable before anything is saved**. The person is approving text, not
  picking a strategy.

Whichever is chosen, the save that follows is the *same* conditional write the
Save button makes, against the etag the review actually read the bucket at. A
third client writing in between comes back as a fresh conflict with fresh
content, and this whole surface reappears — it is never forced through. There
is no `force` flag anywhere in this feature.

##### The merge is real, and it is refused rather than faked

A three-way merge needs a common ancestor, and this feature already keeps one:
the read cache holds the note's body at the etag the draft was typed against.
That etag is carried explicitly (`EditorState.draftBase`,
`RestoredDraft.baseEtag`) because nothing downstream can recover it — `etag` is what the next
save is checked against and it moves, while the ancestor does not.

`offerMerge` will only call a cached body an ancestor when **its etag matches
the draft's base**. Where it does not — the note did not exist, the cache was
swept, the copy moved on, the bucket has not been read, the three versions are
too far apart to align — **the Merge control is not drawn at all**, and the
reason is a sentence on the screen. A two-way diff presented as an informed
proposal would be a guess wearing a merge's clothes; the console's whole
disclosure discipline is that an absent capability is reported, never faked.

`features/offline/merge.ts` is diff3, written here rather than installed:
`runtimeVersion` is pinned and a new dependency in `apps/mobile` is not worth a
small, well-understood algorithm. Three properties of it are load-bearing and
tested (`__tests__/merge3.test.ts`): edits are **ranges of the base**, so a
deletion here and an edit three lines down are not a whole-file conflict; a
line is content plus the terminator it arrived with, compared on content
alone, so a file Obsidian-on-Windows rewrote to CRLF is not a conflict on every
line and a file with no trailing newline still has none afterwards; and
"too far apart to align" answers `null` rather than a worse merge.

Two alternatives were considered and rejected, and the reasoning matters
because each looks simpler:

- **Last-write-wins.** Unacceptable. The bucket is also open in Obsidian and
  written by AI clients, so "somebody else saved while you were typing" is the
  normal case here, not a corner. Silently discarding one side of it is the one
  thing this product cannot do.
- **A conflict copy in the bucket** (`foo (conflict 2026-08-31).md` beside the
  original, Dropbox's answer). **Rejected by the owner**, and this is now a rule
  rather than an open question. It has one real advantage — the typing survives
  the *device* being lost, which parking does not — and it costs more than it is
  worth: writing a file the customer did not ask for into storage we are a guest
  in crosses non-negotiable #1; the on-bucket layout is a stable format rather
  than an internal detail (#3), so adding a filename convention to it is a
  breaking change; and the file would then litter their Obsidian vault, their
  search index, and every `list_notes` an AI client makes. Do not reintroduce it
  as a default, a setting, or a fallback.

**Blocking the editor is still refused, and the resolver does not do it.** While
a note is in conflict the *editor region* is the resolution surface — two
versions, three answers, and an editable proposal do not fit in a strip, and a
strip that opened a modal would be two places to make one decision. The tree,
the tabs and the rail are outside that region, so somebody on a train can still
read and edit every other note; what they cannot do is pretend the decision was
made. `NoteEditor`'s older two-button conflict panel is superseded by this and
is now unreachable from `BrowsePane`.

**The local draft survives until the moment a choice succeeds.** The queued
write is not dropped when the conflict is answered — only when the write that
answers it lands — so an app killed mid-decision comes back with both the
conflict and the draft. The merge proposal itself is deliberately *not* written
down: until somebody presses save it exists only in front of them, which is the
literal form of "nothing is written until you choose", and the draft it was
built from is safe in the queue the whole time.

**Answering a conflict moves the read cache onto the version that was shown,
before the write.** Not optimism — the bucket really did hold that body at that
etag, and the cache mirrors the bucket — and it is what keeps a *second* round
mergeable: the ancestor of the text somebody just approved is precisely the
version they approved it against.

**"Keep mine" overwrites, and says so.** This used to read "nothing is lost by
either answer", on the strength of a `.history/` snapshot before every write.
Nothing snapshots now — version history is the customer's own object versioning,
which we cannot see — so the choice says "unless you turned on versioning at your
storage provider, the version it replaces is gone" and lets them decide knowing
that. A conflict dialog that overstates what it keeps is worse than one that
asks plainly.

**A draft is conflict-checked before it is ever sent.** A draft typed and never
saved carries its base etag. If the note has moved on by the time it is
reopened, it is restored **as a conflict** rather than as ordinary unsaved
changes — otherwise the console silently arms a Save over a version nobody has
seen. That is the same choice a refused save offers, given before the write
instead of after it.

**Retries are bounded and the classifier is an allowlist.** Only enumerated
transient codes (`STORAGE_FAILED`, `UNKNOWN`, `PRIVACY_MANIFEST_BUSY`) are
retried; every other code — including one added next year — parks the entry and
says so. The other direction is the expensive one: an unrecognised refusal
retried on every reconnection forever, against somebody's paid-for request
quota, for a write that was never going to succeed. Six failures across six
separate reconnections parks it too.

#### Where conflict detection is genuinely unavailable

A queued write on a bucket that cannot do conditional writes (B2, Wasabi, and
anything the connect-time probe catches lying) is checked by read-compare, the
same as an online save there — the delay does not widen the read-to-write race,
because the compare happens at drain time. What the delay *does* change is how
likely a conflict is at all: an edit typed on a train and sent an hour later has
had an hour in which somebody's Obsidian could sync. So the queue's own line
says it, in `copy.ts`, driven by the binding's real `capabilities.conditionalWrite`
— not by the provider's claim, which S3Store declares `true` for every
S3-compatible endpoint including the ones that ignore `If-Match`. Reported,
never faked, and never silently dropped.

#### Where it runs, and what it promises

**Shared, not native-only** — a deliberate divergence from the Togather ADR
this borrowed its shape from, where every offline module is native-only with a
`.web.ts` no-op. Web is this product's primary surface and ships daily, and a
closed tab loses a draft exactly as an OS reclaiming an app does. Only the
storage primitive is split: `store.web.ts` is `localStorage`, probed with a real
write because every failure mode (Private Browsing, blocked site data, a full
bucket) is a throw rather than a missing property.

`store.ts` is `@react-native-async-storage/async-storage`, which is `core` in
`native-deps.json` — the baseline every build has — so it is a static import
with no `NativeModules` gate and no `runtimeVersion` bump. **`durable` stays on
the `KeyValueStore` interface even though both real implementations now answer
`true`**, and that is not vestigial: a browser blocking site data falls back to
memory at runtime, and every sentence about the queue is written to change with
the boolean rather than to assume it. Removing it would mean the console
promising a queue survives a restart on the one machine where it does not.

**Sign-out wipes everything this feature holds**, queue included. Note text is
the customer's private content and a signed-out browser has no business holding
a readable copy; a queue that survived would drain into whoever signs in next on
that machine. `signOutWarning` is the last moment anybody can be told.

#### What a person sees

Three states, all in the status strip, which already exists to carry exactly
this kind of fact:

- **Offline** — `warn`, and absent while online *and* while the platform has
  not said. A chip that flashes on every cold load, or sits there permanently on
  a browser with no `navigator.onLine`, is a chip people stop seeing.
- **"3 notes waiting to sync"** — `warn`, with what the store can actually
  promise and, on a weak bucket, what the check is worth.
- **"2 notes need you"** — `crit`, outranking the pending count because a
  pending write sorts itself out and a conflicted one never will, and **naming
  the notes**: a count with no way to find out which two cannot be acted on.

The open note carries its own: `Queued` (`warn`, never `ok` — the bucket is the
only thing this product treats as real), `Cached copy` with the copy's age, and
— for a conflict — the whole editor region, given over to the two versions and
the three answers. Pictures of both palettes are in `docs/design/conflict/`,
written by `__tests__/conflictShots.render.ts`.

### A team link's note survives the console's own cold start, and the login gate

`teamShareLink` returns the **readable** URL — `/console/@seyi?note=…` — and the
whole reason it is that rather than `/s/<token>` is that the address says what
it points at. Following one landed on the context's empty "choose a note"
screen, twice over, for two unrelated reasons. Both were invisible to every
existing test because both are about a *cold* start, and every test exercised
the warm path.

**The route's effect ran before the file browser had changed context.**
`useFileBrowser` forgets its previous context — listings, expansion, selection,
the open note — in an effect owned by the console **layout**, and React runs a
*route's* effects before its parent's. So in the one commit where
`selectedContextId` goes from `null` to the workspace the URL names, the route
selected the note and the layout cleared it microseconds later. The route had
already recorded the URL as honoured, so nothing retried.

`FileBrowser.contextId` is the fix and it is deliberately **not** derived from
the `workspaceId` prop: it is set *inside* the reset, so it moves one commit
later than the prop does, and that lag is the entire signal. Deriving it is the
tidy-up that reads as equivalent and silently restores the bug.
`useLinkedNote` waits for it to name the context it is acting on — which is
also the only version that is *correct* rather than merely working, since a
selection made before the reset is made against the previous context's state.

**And the sign-in the link triggers dropped the query — twice, for two
different reasons, and the second one is the interesting one.** The `(app)` gate
first carried `usePathname()` into `/login?next=…`, and expo-router documents
that hook as returning the location *without search parameters*. Nothing about
the redirect rule was wrong — `safeNextRoute` passes a query through untouched —
so no test of it could have seen this.

The obvious repair, `useUnstableGlobalHref()`, was **also wrong, and shipped**.
That hook does not read the URL; it re-serializes one from React Navigation's
state, and `routeInfo.ts` says in its own words that the state "maybe
incomplete" when React Navigation "didn't render the entire tree (e.g it was
interrupted in a layout)". **This gate is that interruption**: refusing a
signed-out visitor means returning a `<Redirect>` instead of its `<Stack>`, so
nothing below the group ever renders and the rest of the route is left sitting
in `params.screen` / `params.params`. Measured live, following
`/console/@seyi?note=3-resources%2F…md` signed out reconstructed as
`/console/@seyi?slug=%40seyi` — the `note` the link exists for **gone**, and
`[slug]`, which belongs in the path, re-emitted as a query parameter.

So the rule is: **a gate reads the URL, never a reconstruction of it.**
`attemptedHrefFrom` takes `window.location` where there is one, which on the web
is the document's real URL — not derived from anything, unable to drop a query
parameter and unable to invent one. React Native has a `window` and no
`window.location`, so native falls back to the router's answer: the same
fallback `shouldHandleCodeHere` already makes, and the narrower case, since a
native deep link has no browser URL to read. Reaching the real URL requires a
*rooted* pathname and nothing else, because a half-built value narrowed by
`safeNextRoute` loses the note quietly instead of loudly.

Two links in this product carry their meaning in the query and can be recovered
by nothing else: `/authorize?request_id=…` and this one. A gate that reads a
pathname — or a reconstruction — where a person followed an href strands both.

**And the same defect a third time, from the other side: the app must not
navigate back to that link either.** The gate's `next` was right; what lost the
note was `router.replace(next)` from `/login`. Measured in Chromium against the
real router, that hop lands in two stages:

    t+1500ms   /console/@seyi?slug=%40seyi
    t+3000ms   /console/@seyi?slug=%40seyi&note=3-resources%2F…md

The first is the URL somebody reported being left on, and whether the second
ever arrives depends on how the rest of the tree settles — which is not
something a link's correctness may rest on. Same cause as above: the URL is
re-serialized from a state that is still being built.

`landAfterSignIn` therefore does a **real navigation** on the web —
`window.location.replace(next)`, which sets the URL byte-for-byte, has no state
to re-serialize, and cannot drop a parameter. The app then cold-loads at that
address with a session already in storage, which is exactly the signed-in cold
start `useLinkedNote` was built for and which is verified working: the
signed-out case becomes the case that already works rather than a second one to
keep correct. The same probe then lands in one hop with the note intact.

Both places that navigate to `next` go through it — `LoginScreen.verifyCode`
and the `(auth)` gate — because they race, and whichever wins decides whether
the link survives. Native keeps the router's navigation: there is no page to
reload, and the tree below the gate is already mounted after an in-app sign-in.

The cost is one page load after entering a code, on the one navigation where a
person is already waiting for a round trip. Set against a link that silently
loses what it points at, it was not a close call — but it is a real cost, and
"tidying" it back to `router.replace` restores a bug three fixes deep.

### A folder page is a page, and a folder is acted on like a note

Two things a folder link exposed, once one could actually be followed.

**The folder's own listing was thrown away by the root's.** `select` fetches a
folder's listing when it does not have one — which is exactly what following a
team link to a folder does — and `useFileBrowser`'s per-context load finished by
*replacing* the whole listings map with `{ "": root }`. That request is started
first and can land second, because a folder's listing is the smaller one, so the
folder page sat on "Loading…" and nothing retried: the only way back was
expanding that folder in the side panel, which asks again. `takeRootListing`
merges instead. That is safe rather than lenient — forgetting the previous
context is done by the reset at the top of the same effect, before any request
goes out — and the wholesale replace is the tidy-up that reads as equivalent.

**And a folder drew its own pair of controls.** A "Share…" pill in the heading
and a full-width "Make this folder private" beneath it were the first two things
on a folder screen, offering the same two capabilities a *note* offers through a
different pair, in a different place. They are one pair now — a lock and a
share, in the frame's trailing group on a phone and in `BrowsePane`'s note head
on a pointer — and `FolderView` draws neither. What a share *means* still
differs by kind and that stays `ShareDialog`'s to say: `createShare` has no
folder form, so a folder gets the team link.

The lock draws the state a thing **is in** and its label names the state it
moves to, and the disagreement is deliberate: an unlabelled 20pt target can only
show what is true, while a label is read aloud before the press and is worth
more as a verb. Making them agree in either direction loses one of the two
facts. The visibility *sentence* stays on the folder page — it says what `team`
means for the notes inside, which is the one thing a padlock cannot.

### A phone gets a path bar, which is half of the line that was deleted

`BrowsePane`'s own comment argued the breadcrumb off a phone at length, and the
argument is right about one thing and wrong about the other. Right about
**naming**: the note titles itself inside its own text, the visibility is a
Properties row, and a path pinned above the document is a second band of chrome
under a bar that already floats there. Wrong about **navigation**: a folder page
reached by a team link had no route to its parent at all, and the only way to
another folder was the drawer — the one surface a phone makes hardest to reach.
Deleting the row took both halves because they were one row.

`Breadcrumb`'s `pathOnly` is the half that navigates, and it is subtractive
rather than a second design — the same segments and the same press targets,
minus what a phone already says:

- **No leaf.** The next line down is the note's inline title or the folder's
  heading, so a trailing segment is the same words twice.
- **No visibility chip.** A note carries it as a Properties row and a folder
  states it in a sentence directly beneath, both fuller than the brief chip.
- **The context is not a segment, it is the button in front of them.** It was a
  monospace segment, pressable, on the argument that it is not a label but the
  way *up* — without it the bar bottoms out one level short of home. That
  argument survives; what carries it changed.

  **This shipped wrong once and the record of that is the point.** The first
  answer was to *delete* the segment, on the reasoning that the strip above
  already named the context. That removed the duplication and the way up
  together: a top-level folder has no ancestors, so the path row was empty and
  nothing on the screen led back to the root of your own context. A thing that
  is in two places is moved to one, not removed from both — see *The context you
  are in moved to the breadcrumb* below.
- **And it scrolls horizontally.** `3-resources/books/reading-notes/…` is wider
  than 390pt within three segments; wrapping makes the band a variable number of
  rows and ellipsising leaves the segment you are standing next to unreadable.
  `ContextStrip`'s rule, one row down: nothing truncates, the row gets longer,
  the scroll absorbs it.

A top-level folder therefore draws no *segments* — its ancestors are empty — and
the row is the context button alone, which is exactly right: that button is the
folder above it. `FolderView` still takes a `contextLabel` for the root, which
is the one folder with no name of its own: a context's root folder *is* the
context.

**It is built once and handed to two surfaces**, because a note and a folder
scroll in different containers on a phone: `NoteEditor` owns its own scroller so
`NoteAccessory` can anchor to the region rather than ride away with the content,
so anything that must scroll with a note is passed *in* (`pathBar`, beside
`notices`) rather than drawn around it. Two copies of that line is how a control
ends up on one surface and missing from the other — which is what happened while
this was being written, and the note branch simply had no bar.

It scrolls away with the document rather than being pinned: it answers a
question people ask on arrival, and a permanent band costs a line of every note
forever.

**And the drawer this section argues against is now gone entirely**, which
makes the path bar the *only* way between folders on a phone rather than the
better of two. Nothing above changes: every reason it was built is still a
reason, and the one sentence that has stopped being true is "the only way to
another folder was the drawer". The section below is what that removal cost
elsewhere.

### The contexts moved into the scroller, because navigation is not a verb

The context strip was a slot in the phone's floating top bar. Two things about
that arrangement were reported from a phone by the person using it, and they
are one decision:

**A floating bar means the document runs behind it, and navigation has not
earned that.** The frame's shape at `compact` is deliberate — a full-bleed
document with chrome lying over both ends, so the first line can be scrolled out
from under the top and the last out from under the toolbar. The bottom toolbar
earns its place there because its keys are verbs about the note in front of you,
and a verb you cannot reach is a verb you do not have. A row of context pills is
not a verb about anything: it lay across the twentieth line of somebody's note
at every scroll position, with no scroll position that clears it. "The top
workspaces should scroll with the note; to change workspace I should have to
scroll up."

**And it said the context twice.** The strip named the current context one line
above a breadcrumb whose first segment named it again — on a 390pt screen, two
of the few rows it has.

So the contexts went to where the path already was. `features/console/NavBand.tsx`
is the band: the contexts on top, the path under them, both inside whatever
scroller the surface owns — `BrowsePane`'s on a note or a folder,
`EditorRegion`'s on Map, Connections and Settings. It scrolls away with the
document and comes back by scrolling up, which is what was asked for. The
duplication is gone because the band names the context in exactly one place, the
lit pill, and the path below starts at the first folder.

Three consequences that are decisions rather than placement:

- **The context you are in moved to the breadcrumb, and the strip is what you
  can switch *to*.** `stripOrder` drops the current context; `CurrentContextPill`
  draws it at the head of the path row, as the same pill object, and pressing it
  opens the context's **root** (`browseHref`, never `contextHrefFrom` — "where
  you last were" in the context you are standing in is where you are). One name,
  one place, and the press does something.

  The owner's description is the specification, and it is quoted in `NavBand`
  because the first implementation got it backwards: *"the button for that
  workspace should essentially move to the breadcrumb… that workspace button
  removes from the workspace column, but is put in the breadcrumbs column. So
  I'm still able to get to the root."*

  Three consequences. The strip has no lit pill and nothing on it is
  `aria-selected`, because every pill goes somewhere you are not. `stripEntries`
  draws the row at one entry rather than two, since none of them is a label any
  more — and somebody with one workspace and no others now gets **no** strip and
  their name at the head of the path, which is the better trade. And the
  long-press menu moved with the pill: context Settings is reached on a phone
  through that menu and nowhere else, so leaving it behind would have taken
  `/console/[slug]/settings` off the phone entirely.
- **Row two is one scroller.** The button and the segments are one line — *this
  context, then this folder* — and two scrollers would let the button sit still
  while its own path slid out from under it. So `NavBand` owns the `ScrollView`
  and `Breadcrumb.pathOnly` returns bare segments into it. It carries the
  strip's falloff for the strip's reason, and that was found in a browser rather
  than by a test: a deep path overflows this row far more often than the
  contexts overflow the one above, so the row that needed the fade most was the
  one that shipped without it.
- **The strip is built by the layout and passed down, not rebuilt at the leaf.**
  It needs the context list, the recently-visited log and the router, and it has
  to be drawn two levels below. A second one assembled where it is drawn is two
  copies of a control, which is how one of them ends up with a handler the other
  does not have — the failure `NoteEditor.pathBar` already exists to prevent one
  layer down. It travels as a `ReactNode` through a context (`NavBandProvider`).
- **The band pays the horizontal gutter for both of its rows, and the caller
  decides the number.** The strip took the top bar's `space.x3` while it lived
  there and had no padding of its own; dropped into a scroller it sat flush
  against the glass, a row of pills a quarter-inch to the left of the note under
  it. Which number is right depends on what the band is above and only the
  caller knows — `layout.readingMargin` over a document, nothing at all inside a
  pane whose content container already pays one — so `Breadcrumb.barPath` gives
  its own up and takes the band's.
- **The frame's top row is two slots now, not three.** The account mark stays
  pinned at the leading edge because it is the product's only sign-out and a
  control you have to scroll to find is one somebody concludes is missing; the
  trailing capsule is untouched, because the scope and Share act on what is on
  screen and were never navigation. `appFrameRender.test.ts` asserts the pair
  and their order; `consoleChrome.test.ts` asserts that the strip is on the
  screen and inside the band rather than in the bar.

What did **not** change is the landmark: the strip is still the phone's single
`role="navigation"`, labelled `Contexts`, and the bottom row is still a toolbar.
Moving a landmark down the tree does not remove it, and
`consoleChrome.test.ts` still counts exactly one on a mounted phone console.

### A phone has no left panel, so the one thing its footer said had to move

The rail sheet, the file-tree drawer, both toggles and their scrim are gone at
`compact`; navigation is a context strip (in the scroller, above the path — see
the section above) and a seven-key bottom row, neither of which has to be
summoned. `features/app/frame.ts` carries the
whole of that decision and amends its own paragraphs in place.

What that removal cost is one line, and it is worth naming because deleting it
with the panel would have been silent. The tree's footer read
`R2 · workspace · 62% indexed · 12 notes, 8 folders` — the storage binding, how much
of the context is in the hosted index, and how much of the tree has actually
been read — and its own comment recorded *why it was on a phone at all*: at
`compact` the frame draws a bottom toolbar and **no status strip**, so without
it the only way to learn how far a backfill had got was to open settings, which
is precisely the state that made a stuck backfill and a working one look
identical for hours. Two of those three facts had no other route on that
density at all.

**It is the foot of the context root page now**, composed by
`features/console/files/contextFoot.ts` and drawn by `FolderView`. Four things
about that are decisions rather than placement:

- **The root page and not every folder page.** The three facts are about the
  *context*, and the root is the one folder page that **is** the context —
  `FolderView` already took a `contextLabel` for exactly that. `loadedCounts`
  counts every listing that has been read rather than the open folder's, so
  under a subfolder's own rows the same numbers would be read as a count *of*
  that subfolder: accurate, misread, and worse than absent. A caption repeated
  under forty pages is chrome.
- **Compact only.** A pointer layout says all three already — the bucket and
  the tier are the top bar's chips, the percentage is the status strip's
  segment, the counts are the tree's own foot — and a second copy under the
  listing is the same facts twice on the density that never lost them.
- **One composer, and the words still come from `describeIndexProgress`.**
  That function is the owner-only gate as well as the phrasing: `notesIndexed`
  and `notesPending` are `undefined` for a member because the index counts
  private notes they cannot read, and a percentage is that total divided (see
  [search](./search.md), *The backfill percentage is derived*). Composing a
  figure at this call site instead is the natural shape of a second
  implementation and it hands a member exactly what the server withheld —
  measured, it reddens both member cases, the `off` case and two owner
  wordings.
- **Each of the three parts is omitted rather than filled in, and the three
  absences mean different things.** `undefined` storage is "the binding has not
  answered" and says nothing; `null` storage is "no bucket connected" and is a
  claim worth making; a `null` index figure is a member, an `off` context or an
  unanswered status and draws nothing at all — not a dash, not a `0%`. The
  counts are always drawn, because "Nothing read yet" is true of an unexpanded
  tree and an empty string is not.

**And the page it sits on had to become reachable.** With no tree, a phone
landing on `/console/@slug` with no `?note=` drew "Choose a note to read or edit
it. Right-click any row — or press and hold on a phone" — a sentence naming a
gesture with nothing on the screen to perform it on, and no route to a single
note in the context. `BrowsePane` draws the context's own root folder there
instead, at `compact` only, as a **render fallback and not a `select("")`**: a
selection written there would be a third writer of the relationship
`useNoteAddress` owns two directions of, and `noteAddress.ts` exists because
that relationship oscillates when more than one thing drives it. A pointer
layout keeps its empty state, where "choose a note" names a tree that is on the
screen.

**The navigation landmark moved with them too, and for a while it did not
arrive.** `AppFrame` declares `role="navigation"` on exactly two things, the
rail column and the rail sheet, and neither is rendered at `compact`. The
assertion that a phone had one was written about the sheet and was deleted with
it, so a phone-width browser window had **zero** `<nav>` landmarks: every pill
and every key kept a real `aria-label`, and a screen-reader user rotoring by
landmark — or anything that jumps to `<nav>` — could not find the navigation at
all. Labelling each control and being able to find the group of them are
different capabilities, and the second one was lost silently.

The **context strip** carries it: `role="navigation"`, labelled `Contexts`
rather than the rail's `Console`, which needs no disambiguation because the two
are never on screen together. The **bottom row deliberately does not** — it
stays `role="toolbar"`, named `Console actions`. Six of its seven keys are verbs
about the open note, and calling a row of verbs "navigation" because one
destination sits at the end of it behind a separator makes the landmark mean
less rather than more. `contextStrip.test.ts` holds the declaration and
`consoleChrome.test.ts` counts the landmarks on a mounted phone console —
exactly one, and not the toolbar — because a component that declares a role
correctly while the density renders none of it is the failure this replaces.

**Sign-out moved with the panels and had to grow.** It is the only sign-out
control in the product; it was at the foot of the rail, which a phone can no
longer reach, and it is now the pinned account slot at the leading end of the
top row — since the contexts left that row, the only thing in it at that end. The mark stays `layout.accountAvatar` (34) and the pressable around it
is `layout.minTouchTarget` — it had been padding by 4, so the target was 34 and
under the floor, and the row's width budget in `tokens.ts` and `AppFrame` was
written against the mark rather than the target. Both are corrected there.

What a simplification of any of this costs, and the tests that fail:
`indexProgressSurfaces.test.ts` carries the sabotage table for the figure
itself, `noteChrome.test.ts` follows each of the four things the tree's footer
carried to where it went, `storageUnknown.test.ts` holds the three-valued
binding on this new surface — a guard that measured **zero** failures until
those three cases were written for it — and `consoleChrome.test.ts` holds the
strip, the bottom row and sign-out's 44pt.

### A copy is one press, and it is confirmed outside the modal

Copy link on a share put nothing on the clipboard and said nothing about it,
on iOS. The cause is a rule about *when*: Safari grants the clipboard to a call
made inside the user activation a press starts, and the dialog awaited a round
trip — minting the share row — before writing. That spends the activation, the
write is refused, the caller correctly declines to claim a copy it did not make,
and the button silently stays "Copy link".

So **minting and copying are one call** (`FileBrowser.copyShareLink`), and
`copyDeferred` is what makes that possible: `ClipboardItem` accepts a *Promise*
for its data, so the write is issued inside the gesture and the round trip
settles inside it. Browsers without that form throw on construction and fall
back to awaiting and writing — which is safe, because they are the ones that do
not enforce the window. Splitting it back into "await a URL, then write it" is
the tidy-up that restores the bug, and it restores it **on one browser only**,
which is why the test asserts the *order* rather than the clipboard's contents:
both versions leave the same text on the same clipboard everywhere else.

**A copy is invisible, so it is confirmed where the confirmation outlives it.**
The dialog used to relabel its own button "Copied" and stay open, which puts the
only evidence inside a modal the person has just finished with and then throws
it away when they close it. A successful copy closes the dialog and raises the
pane's notice; a failed one keeps the dialog open and the notice carries the
URL, because the clipboard is the only part that did not work and the person
still wants the link. On native there is no clipboard at all, so that is the
whole feature there rather than an edge case.

The `execCommand` fallback also had to be fixed to work on the platform it
exists for: `readonly` plus `select()` is the recipe every snippet shows and the
one iOS ignores — it refuses to select a read-only field, so the copy takes
whatever was selected before, usually nothing.

### A write from outside the file browser has to say so

The console refreshes a folder whenever **it** writes into one — `save`,
`create`, `move`, `archive` each end with `refresh([parentPath(path)])`. Every
one of those is the browser changing the bucket and telling itself, which worked
for exactly as long as the browser was the only thing that wrote.

A meeting is the first write in this product that reaches the same bucket from
somewhere else. It went unannounced, and the symptom is the shape that makes
this a decision rather than a fix: **the phone that had already read the folder
was the one that did not show the note.** A client that had never opened
`0-inbox/meetings` fetched it on the way in and drew the meeting immediately;
the device that recorded it kept the listing it was holding. "After saving the
meeting it did not show up on the mobile app, but it showed up on the web app."
Nothing was lost — the note was in the customer's bucket the whole time — which
is precisely why nothing surfaced it.

`features/console/files/bucketWrites.ts` is the seam, and it is a bus rather
than a call for a reason in each direction. **The console must not know that
meetings exist**: it is a file browser over a bucket, and the second outside
writer must not need a second branch in it. **The meetings gateway must not hold
a console hook**: it runs from a screen the console does not own. Both import a
module that knows about neither.

Four things about it are decisions:

- **It carries the workspace and the path, and never the text.** This is a
  signal that a listing is stale, not a second channel for note bodies — a
  subscriber taking content from here would hold a copy the cache never saw, at
  a clearance nobody checked ([*A copy on the device is bounded by who read it*](#a-copy-on-the-device-is-bounded-by-who-read-it-when-and-whether-the-server-said-no)).
- **The reader checks the workspace.** One device is signed into several
  contexts and `useFileBrowser` is mounted for one of them; the same folder path
  is a different folder in a different bucket.
- **It refreshes the parent and every ancestor already held, not the parent
  alone.** A write into a folder that did not exist changes its *grandparent*
  too, and that is the ordinary case rather than the exotic one: the first
  meeting anybody records creates `0-inbox/meetings` under the `0-inbox` they
  are looking at, so a parent-only refresh fixed the second meeting and none of
  the first — the same symptom one level up. Held rather than all, because a
  refresh of a folder nothing has asked for is a request whose answer nothing
  draws; and the root is prepended by hand, because `ancestorsOf` starts at the
  first segment and never yields it.
- **It announces after the write resolves.** An announcement of a write that
  then failed makes every listener reload a folder to learn nothing, and raises
  the console's own "the file list did not reload" notice about an operation
  that never happened.
- **Nothing is buffered or replayed.** A console that mounts *after* the write
  reads the folder fresh on the way in; replaying would make it reload a folder
  it has just loaded.

The checks are `a meeting landing in a folder the console is holding reloads
that folder`, `a write to another context refreshes nothing here`,
`a meeting note announces the folder it landed in`, and `a write that failed
announces nothing` — the first two sabotage-tested against the effect and
against its workspace guard separately.

### A copy on the device is bounded by who read it, when, and whether the server said no

Three rules sit under the queue and the cache, and each of them was reachable
as a working exploit in the first version of that feature. They are separate
because they fail separately: fixing any one of them leaves the other two.

**A cached copy carries the clearance it was read at, in the key.** Every note
and listing on the device is a copy of an answer `scopeForRole` had already
filtered — an owner reads at `private`, everybody else is narrowed to `team`.
Membership is a row in the control plane that an owner changes from another
machine, and nothing on this device hears about it: `forgetContextCopies` fires
when a context *leaves* your list, and a demotion does not. So the clearance is
a segment of the key (`scopedKeyFor` in `features/offline/keys.ts`), not a field
beside the value — a demoted session builds a different key, misses, and takes a
round trip. A field would need a comparison at every read, and a comparison is
something a later call site can forget. `keyFor` is typed to `UnscopedKind`, so
filing a copy under no clearance at all is a compile error rather than a review
note.

`readableAt` is the direction and the direction is the security property:
`private` may read a `team` copy, `team` may never read a `private` one. Adding
`"private"` to the `team` answer is the one-line way to put the leak back;
losing the widening costs an owner a cache miss, which is the right way round.
Only `note` and `listing` are scoped. A draft and the queue are the person's own
typing, carry no clearance, and keying them by one would orphan unsent work on a
demotion — `waitingOnDevice` would still count edits the console could then
neither show nor drain.

**A refusal is never overruled by a copy.** The read paths fall back to the
device when a read fails, and the `catch` they sat on could not tell a captive
portal from a removed membership — so a revoked grant became a cache hit, with
an age stamp under it that made it read as considered. `isServerRefusal`
(`features/console/files/browser.ts`) splits the two on the same shape check
`toFileError` already uses: a `ConvexError` carrying `{ code, message }` is the
only thing this server produces deliberately, and anything else is transport and
may not deny somebody their own copy. **`OVERRIDABLE_STORAGE_CODES` is a list of
codes safe to override, never a list of codes that are denials** — an unknown
code is treated as a refusal, so a denial added next year is closed by default.
The inverted list reads the same and fails the opposite way.
`STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE` are on it because they are raised
*before* `executeOperation`, after membership and role, so nothing was refused —
a person whose bucket is down is exactly who an offline copy is for.
`apps/convex/__tests__/storageCodePosition.test.ts` reads the allow-list out of
the console and pins that premise where it lives, because it is a fact about the
server asserted in another app.

**The sign-out clear is a barrier, not a moment.** `forgetEverything` had no
production caller at all for one release, and wiring it is only half the fix: a
`remove()` loop deletes the keys that exist while it runs, and every writer in
the offline layer is fire-and-forget over an async store fed by Convex actions
with no client-side timeout. The measured result was a private note body back in
`localStorage` *after* sign-out. So `endSession()` in `features/offline/epoch.ts`
is bumped **before** anything is removed, each mount captures the number once,
and every writer — and the drain — drops work from a session that has ended. It
re-arms by itself on the next mount, because a barrier that has to be lowered by
hand is one that stays raised the day somebody forgets. The clear never blocks
(being unable to end a session is worse than a cache that outlives one) and
never absorbs: it is bounded by a deadline, because a wedged bridge never
settles and a `catch` has nothing to catch, and it re-lists what it owns
afterwards rather than trusting its own removals. Leaving a context clears it
**on the server's answer, never on the request** — `leaveWorkspace` answers
`{ left: false }` for a row it did not find, and clearing on the press would
discard the copies of a context the person still has.

### Making a workspace is its own flow, not onboarding with a flag

Four of the five screens rhyme with `/welcome`'s, which is exactly why it is
tempting and exactly why it is wrong. Three things differ, and each one turns a
shared implementation into a screen that lies to one of its two audiences:

1. **A workspace is not the thing you may only have one of.** Onboarding has no
   way back and is not re-runnable: step 1 claims a name out of a namespace with
   no release path, and `createWorkspace` writes exactly one personal context.
   `resolveWelcomeRoute` exists to enforce that. A person may own several
   workspaces, so there is no gate, Back means something up to the claim, and
   the copy does not borrow "there is no way back".
2. **A workspace has no capture address.** Only a personal context gets an
   ingestion alias. The onboarding name step's most consequential element is a
   live panel showing the three things the name becomes, one of which is
   `name@context.lc` — and here it would promise a mailbox that will never
   receive anything. `workspaceNameConsequences` returns two entries, and a test
   asserts the third is absent rather than trusting that nobody re-adds it.
3. **A workspace nobody else is in is pointless.** Onboarding ends on "point
   your tools at it". This ends on inviting people, which is the only step whose
   absence makes the whole flow a no-op — and it therefore survives a failed
   storage probe, where onboarding correctly drops its remaining steps. An
   invitation is a control-plane row and writes nothing to a bucket; a workspace
   whose storage is not sorted out is exactly the one whose members need to know
   it exists. What it must not do is imply the context is ready, which is a
   caveat on the screen rather than a silence.

What is genuinely shared is imported, not copied: `validateName` (through
`../onboarding/name`), the folder editor and its validator, `StorageChoice`,
`parseInvitee`, and the role vocabulary. The rule is the one `onboarding/name.ts`
already states — a drifted copy of a validation rule shows a green tick in front
of a refusal.

### Two name fields for a shared workspace, one for a personal one

A person's handle and a person's label are usually the same word, so onboarding
asks once and uses the answer for both. An organisation's are not: "Acme
Engineering" is what it is called and `acme-eng` is what fits in
`@acme-eng/1-projects/note.md`. One field gets you a handle nobody can read or a
label nobody can type.

The handle follows the label until it is touched, and then stops permanently for
that session. A suggestion that keeps overwriting is how a *permanent* name gets
claimed that nobody chose — somebody goes back to fix a typo in the label and
the handle silently changes under them. `slugSuggestion` is pure and its output
is fed through `nameStatus` like any typed string; it is never assumed valid.

### The layout presets are company-shaped, and PARA is not the default

PARA sorts one person's work by how permanent it is. That is the right question
for a workspace and the wrong one for a company, whose context is sorted by who owns
a thing and which outside party it concerns — a team handed `1-projects` /
`2-areas` / `3-resources` files nothing into them. So `/workspace/new` defaults
to a **Company** preset (inbox, projects, teams, handbook, customers, archive),
offers **Client work** for organisations whose work is sorted by client first
(a flat `1-projects` collides across three clients on day one), and keeps PARA
third for teams that already use it.

Two properties matter more than the folder names, which are a guess and are
meant to be edited:

- **A preset is a starting value for the folder editor, not a mode.** Choosing
  "Company" and renaming `4-customers` is the common case. Every preset except
  PARA travels to `applyStructure` as `custom` with its rows, so nothing
  downstream knows which button was pressed.
- **The descriptions are load-bearing.** Each becomes that folder's `README.md`
  and its line in `index.md`, verbatim, which is what a connected AI client reads
  to decide where a note belongs. A vague description produces a folder that
  fills with everything. They are written in the third person, because a
  workspace has no single reader and `index.md` addressed to "you" reads as
  somebody else's file to everyone but its author.

A test runs every preset through the control plane's own `validateCustomFolders`
and `toFolderSpecs`: a preset shipping a folder the mutation would refuse is a
button whose only outcome is an error.

### Invitations are queued, and a partial send keeps its successes

`inviteMember` is rate limited per account, so a box that fires on each press is
the shape most likely to meet the limit and least likely to say which of five
people it got to. Queueing also matches what the step is for — it is four
colleagues and a typo, and a typo is cheaper to fix before it is a live
invitation than after.

The send is sequential and per-invitation. A failure does not discard the ones
that went: those invitations exist, and re-sending one supersedes a live row. So
the queue is replaced by exactly what failed, both halves are reported, and the
flow does not advance until the box is empty or the person skips.

Two things this screen may never do, both inherited rather than invented:

- **Say whether the invitee exists.** Refusals are about the *shape* of the
  string, which is a fact about the string and could not have been about who
  holds it. Anybody with an account has an invite box; one that answered would
  enumerate the user base.
- **Imply anybody has access yet.** An invitation is an offer, and until it is
  answered the workspace has one member. The last screen says "outstanding",
  never "invited" and never a headcount — a "4 people invited" on a screen
  somebody screenshots is read as "4 people can read this".

### The rail's "New workspace" entry is a verb, and the claim entry is a gap

They sit in the same group and are two flags rather than one, because they are
true at different times and are drawn differently on purpose. "Claim your @name"
is a *gap in the list* — it is for somebody who arrived through an invitation and
has no reason to suspect the product does anything else, it is drawn accented so
it cannot be missed, and it stops existing the moment it is used. "New workspace"
is an ordinary verb that is true from the first session and stays true, so an
accent on it would be an advertisement on every screen forever. It goes last,
under the claim entry, in the group where its result will appear.

Nothing client-side gates it. How many workspaces one account may own is
`MAX_WORKSPACES_PER_USER`, enforced inside `createWorkspace`'s transaction, and a
second copy in the rail would be the copy that is wrong after a deploy — hiding
the entry from somebody under the limit, or showing a screen that refuses. The
refusal is rendered on the step where the person can act on it.

### The rail is one list, with the personal workspace pinned to the top

Two groupings preceded this one, and both were answering *whose notes am I about
to open?* with structure. The first grouped on **ownership** — "Yours" over
everything where your role was `owner`, "Shared with you" over the rest. The
second grouped on **kind**, heading the groups with the product's two nouns of
the time, **Workspaces** and **Workspaces**.

The second grouping died with the noun. The owner retired "brain" (2026-09-13,
[vocabulary-and-workspaces](./vocabulary-and-workspaces.md)): a brain is a
workspace one person owns, so both groups are workspaces and a heading over each
is a division with nothing left to divide — two words for one noun, drawn as
structure, at exactly the moment somebody is learning what the product calls
things.

So: **one group, headed Workspaces**, and everything the split was carrying
carried by cheaper devices that were already there.

- **The pin.** `isOwnWorkspace` requires a personal context you own, and that
  row leads the list — always, ahead of any order the control plane sent.
  Exactly one row can ever satisfy it, because `createWorkspace` writes one
  personal context per person and there is no transfer path, which is what makes
  a pin the right shape and a section the wrong one.
- **The mark.** That row keeps its quiet `yours` label and its selected
  treatment. It is a label rather than a badge because the row it marks is the
  one the person recognises fastest anyway: it only has to settle the question,
  not raise it.
- **The handle.** `@sayo` already says whose the other personal contexts are.
  That was true under both groupings and is the reason neither ever needed a
  heading to say it.

Ownership of a *shared* workspace stays unmarked. It is shared by construction;
what differs is your role in it, which is three states on the members card
rather than one bit in a switcher.

**The pin is a pin, not a sort.** Everything after the pinned row keeps the
order the control plane sent. Re-ordering somebody's list on their behalf is a
decision the rail is not making, and a stable list is what makes muscle memory
work.

**The claim entry takes the pinned slot, and the create entry the foot.** They
stay two flags rather than one because they are true at different times and are
drawn differently. "Claim your @name" is the *gap where the pinned row would
be* — it is exactly the placeholder for it — drawn accented because the person
it is for arrived through somebody else's invitation and has no reason to
suspect the product does anything else, and gone forever the moment it is used.
`railGroup` refuses to offer it beside the row it stands in for, so the two can
never be drawn together even if the gate that offers it changes. "New workspace"
goes last, drawn quietly because it is a permanent verb and an accent on it
would be an advertisement on every screen of every session; it is also the only
offer for somebody in no shared workspace yet, which is how a person who has
only ever had their own finds out shared ones exist.

**The group is unconditional**, where each of the two used to survive an empty
list only while it still had something to offer. With one group there is nothing
its absence could say, and it is where "Nothing here yet" lands for an account
with nothing at all.

*What a "simplification" costs:* sorting the list without the pin, or folding
the claim entry into the ordinary run, puts somebody's own workspace wherever
its slug falls in the alphabet and puts the one accented offer in the middle of
a scroll. *The tests that fail if it is reversed:* `railGroup.test.ts` —
`pins your own personal workspace to the top, whatever order it arrived in`,
`never coexists with the workspace it stands in for`, and `says nothing about
workspaces` — and, on the rendered glass, `consoleIdentityChrome.test.ts` —
`the viewer's own workspace is drawn first, whatever order it arrived in` and
`an invited-only account sees the claim entry in the pinned top slot`.

**The one thing this regrouping made easy to get wrong, and the rename that
stops it.** `ContextRowMenu` took a `shared` prop, filled in from whether the
row sat under "Shared with you", and used it to decide whether to offer
**Leave**. Under the old grouping that was the right answer by coincidence:
that section was exactly `role !== "owner"`. Under kind-based grouping every
workspace is "shared" and some of them are yours, so a section-derived answer
offers Leave on a workspace you own and the press comes back
`OWNER_CANNOT_LEAVE`. The prop is now `canLeave` and takes the role — the fact
the server actually enforces — and `__tests__/contextMenu.test.ts` mounts a
workspace the viewer owns and asserts the item is absent. Re-deriving it from
the section fails that test.

### The URL is a mirror of the open note, and the phone's copy of it is a pointer

`?note=` opened the note it named and nothing wrote it back. So the address bar
told the truth for as long as it took somebody to tap a second note, and every
refresh after that landed them on "Choose a note to read or edit it" over the
context they were already in. A reload, a hard reload, a bookmark and a copied
address all gave a link to a **context**, from somebody looking at a **note**.

**The fix is not a store.** A URL is already durable, already shareable, already
survives a process restart and already has a Back button attached. What it was
missing is that it was an *instruction* rather than a *mirror*: read once, never
written. `useNoteAddress` makes it both directions, and nothing is saved on the
web at all.

Three things about that are not obvious and are load-bearing.

**Both directions are one hook.** The obvious shape — leave the link hook alone,
add a "write the selection into the URL" hook beside it — oscillates through the
router: tapping note B sets `?note=B`, the link hook sees a `note` it has not
applied and calls `select("B")` on the note already open, and `select` is not
idempotent, so every tap costs a second `readNote` and is indistinguishable from
a link being followed. One owner of the relationship, or the two halves take
turns undoing each other.

**The rule is a pure function** (`noteAddress.ts`), because a two-way sync's
failure mode is not a wrong pixel but an infinite loop, and neither the router
nor the file browser can be mounted to find one. Its test drives every start
state to a fixed point and requires each to settle in at most one action.

**A URL that changed wins; otherwise the selection wins** — including when the
URL merely *lost* its note. There is no "close the note" for that to be
expressing: `select` takes a path and the file browser has no deselect, so
obeying it would leave the address bar disagreeing with the screen, which is the
state the whole thing exists to end. A URL with no note over a console with one
open is stale, and is re-addressed.

The write goes through `useNavigation`'s `setParams` and never `useRouter`'s.
Not stylistic: `router.setParams` lands on whatever route is **focused**, and
settings is pushed over Browse while leaving it mounted — so the open note being
deleted while the sheet is up would write `?note=` onto
`/console/@slug/settings`.

**A phone has no address bar, so it gets one record and `/console` reads it.**
Backgrounding survives on its own; a cold relaunch starts at `/` and had nothing
to go on. `/console` is therefore the one URL in the app allowed to *restore*
rather than describe — `/console/@seyi?note=…` means that note and nothing else,
but bare `/console` means "wherever I was", and on a relaunched phone it is the
only URL there is. It is read on the web too, where it answers the same question
for a bookmark of `/console` and for the first screen after signing in.

What the record holds is a context slug and a bucket path. Identifiers, not
content: no note text, no etag, no draft, no credential — asserted on the
serialized record rather than on the interface, because the interface is what a
future field gets added to. **It is a destination and never an authorization**:
restoring navigates to a console URL gated exactly as a typed one is, a context
the account cannot reach is ignored rather than followed, and everything read
back off the device goes out through the same `safeNotePath` a URL does. Sign-out
takes it, stale-version records included, and `forgetLocalCopies` verifies that
rather than assuming it.

A simplification of this that would cost something specific: giving `/console`
two answers instead of three. The device is asked asynchronously on every
platform, so there is a commit before the answer arrives; folding it into "draw
the Map" paints the constellation and then redirects out of it, which is the
exact flash `/console` stopped being the Map to remove.
`consoleLanding.test.ts`'s "the Map is never mounted on the way through" is the
test that fails.

### A URL is a context and a note, and half of one is not an instruction

"I'll change between workspaces and it will say file not found." Reported from a
phone against the feature above, a week after it shipped, and the mirror was
doing exactly what it was written to do.

**A switch moves the URL first.** The rail replaces the address with
`/console/@supa`, the phone's strip with `/console/@supa?note=<the path that
context was last left at>`, and only then does the console layout select the
context the URL names, and only then does `useFileBrowser` reset under it —
parent effects after the route's, which is the same ordering `FileBrowser.contextId`
already exists for. For those commits the console holds two honest values about
two different places: the note comes from the **new** address and the open note
belongs to the **old** context.

`nextAddressStep` was given only the first of those, and paired it with the
context out of the console's own state. So the rule reached its last clause —
"a URL that merely lost its note is stale, and is re-addressed" — and wrote
`@seyi`'s note onto `/console/@supa`. That URL then read back as a link into a
context that has never had that file, `select` opened it, and the editor said
*That file does not exist* to somebody who had pressed a workspace. On a phone
it was worse than a wrong address: the strip carries the *new* context's note,
so the same commit called `select` on one context's path while the browser was
still pointed at the other's bucket.

**And it did not stop at the address bar.** `/console/@:slug` records where
somebody is so that a cold relaunch and the strip can come back to it, and it
builds that record out of the URL. Handed a URL that had just been given the
wrong note, it filed `@seyi`'s path under `@supa`'s slug — on the device, where
the next navigation does not correct it. Every later switch to `@supa` restored
a path `@supa` has never had. That is why the complaint was about switching
*between* workspaces rather than about one bad navigation.

So `urlContextId` is an input to the rule, and nothing is reconciled until the
URL, the console and the file browser all name the same context. Three things
about that are decisions:

- **The URL's context, resolved against the list, and not the slug.** The rule
  compares ids because that is what the other two sides are; `contextIdForSlug`
  answers `null` for a slug the account cannot reach *and* for one whose list
  has not landed, because both mean *do not act on this address yet* — and
  telling them apart is `resolveContextRoute`'s job, which is the one place that
  decides whether a dead link redirects.
- **A deep link is not a switch.** `/console/@supa?note=…` typed, pasted, or
  redirected from `/note/@supa/…` names `@supa` from its first commit, so it is
  never the mismatched pair: it waits for the console to catch up and then opens
  exactly what it names. The distinction is not "did the context change" — it is
  *whose* context the note in this address belongs to.
- **The record needs no second guard, because both halves come from the URL.**
  `placeFor` takes the addressed note rather than the browser's selection, and
  the slug beside it comes from the same address in the same commit, so the pair
  cannot name two places unless the address itself is wrong. Adding an "and the
  browser has arrived" flag was tried and reverted: measured, it changed nothing
  a test could observe (the write it suppresses is repeated a commit later with
  the same values), and a guard nobody has checked is not a guard.

`v3` of the log's key is the other half of the fix and is a purge rather than a
shape change. A poisoned entry cannot be told from a good one without a round
trip to somebody's bucket — it is a real path under a real slug, and the only
thing wrong with it is which context it names — so devices that already carry
one are given a fresh file. It costs one navigation per context, which is what
losing this record has always cost.

`noteAddress.test.ts` drives the rule and `linkedNote.test.ts` the wiring
against the real `useFileBrowser`; `contextSwitchRecord.test.ts` mounts the
route and asserts the device, and reversing the rule puts `@seyi`'s note in
`@supa`'s entry there — the reported bug, in a store, in a test. What still
happens on purpose: a `?note=` naming a file the context genuinely does not have
lands on the editor's own refusal and stays there, which is where a stale link,
a note deleted from another device, and a hand-typed path all land.

### A note link is a path with a keyword in front, because a scheme has a host

`context://note/@supa/1-projects/context-lc-file-page-persistence/overview.md`
— generated by ChatGPT, followed on iOS on 2026-09-03 — opened the app and
rendered Expo Router's built-in **Unmatched Route** screen. Nothing matched
`note/…`, so the first thing the product said to somebody arriving from another
tool was a routing error.

**The console's own address is a bad thing for anything else to produce.**
`/console/@supa?note=<encoded path>` is a fine URL for a browser: the note rides
in a query parameter, percent-encoded whole. It is a bad one to *write* — a
client has to know to encode the slashes, and a reader cannot see the note's
name. What clients actually reach for, given a registered scheme, is the shape
that reads like a path. So that shape is a grammar rather than a guess:
`/note/@slug/<path>`, one parser, one builder.

**The first segment is the literal keyword `note`, and that is the decision.**
On native the path a route is matched against comes from expo-router's
`extractExactPathFromURL`, which builds `new URL(url)` and concatenates
`res.host + res.pathname` — so the segment after `//` is parsed as a **host**,
and a host is normalised: lowercased, punycoded if it is not ASCII. A fixed
ASCII keyword survives that untouched. `context://@supa/x.md` — the shape
without the keyword — would put a customer's chosen name through host
normalisation, and a `@` in a host position is not something to hand to a URL
parser at all. The keyword also disambiguates the grammar for people: without a
fixed first segment, `note/1-projects/foo.md` and a context genuinely called
`1-projects` are the same string.

That reasoning is a claim about somebody else's library, so it is a test rather
than a comment: `noteLink.test.ts` imports expo-router's own extractor and
asserts it, and an expo upgrade that changes the rule fails there rather than on
a phone.

**`/console/@slug?note=…` stays canonical; `/note/@slug/<path>` is a link
format.** The link route redirects rather than rendering the note, which is what
keeps signing in and coming back, an unaccepted invitation, and a context that
is not yours as the console's existing answers rather than three
re-implementations of them — and what puts the copyable, bookmarkable,
reloadable URL in the address bar. It sits outside `(app)` so the `next` that
survives sign-in is the canonical URL and not the link.

**Decoding happens before validation, and every external path shares one rule.**
`%2e%2e` is not `..` until it is decoded, and `safeNotePath` is looking for
`..`. The `?note=` query, this grammar, and the record read back off a device
all go through it, because each of them ends up as a path in a request to
somebody's bucket and each of them can be hand-edited or forged.

**There is deliberately no builder for the `context://` form.** Nothing in the
app emits one — the thing that hands people links to notes is the gateway — and
a writer with no caller is a second implementation of the grammar checked only
by a test asserting our copy agrees with itself. When the gateway starts
emitting links, the grammar moves to `packages/shared` and gets its writer
there.

**And `+not-found.tsx` exists so the built-in screen never ships again.**
Declaring the route is the whole of that: `getNavigationConfig` installs Expo
Router's development aid only when the app has not declared one. It recovers a
note link that arrived in a shape the real route did not match, and otherwise
says plainly that the link went nowhere and offers the one destination that is
always meaningful. It does not echo the path back — that is somebody's note
name, and it came from outside.

### A reference follows the note it points at, and a link is something you follow

Two halves of one rule, asked for in one sentence: "when the name is updated
references to it are also updated automatically when using context.lc directly
or using the mcp … by default the reference always changes when things are
moved or renamed."

Neither half existed. Moving or renaming a note left every link to it pointing
at a path that no longer resolved, silently — so the person who tidied a folder
was the one who broke their own workspace — and `[[../../2-products/x/overview]]`
rendered as that exact string, in an app whose notes are mostly links to each
other.

**The rewrite is a default with no flag.** `move_note`, `move_notes`,
`move_folder` and `archive_note` in the gateway, and `movePath` in the control
plane, rewrite the links and report how many they changed. Archiving is
included because retiring a note is not deleting it: a link into `4-archive/`
tells the truth about where the thing went, and the alternative is a bucket
where archiving breaks every reference into it, which is how people learn not
to archive.

Four things about the rewrite are decisions, and each one is a way to get it
visibly wrong:

**Relative links are recomputed, not substituted.** When a folder moves, a link
*inside* it pointing *outside* it needs a different number of `../`. A rewriter
that only swapped the moved paths breaks every one of them while reporting
success — which is why the moved notes are rewritten too, not only the notes
pointing at them.

**A link is re-expressed the way it was written.** Relative stays relative,
rooted stays rooted. Normalising would mean a move that reformats notes it was
not asked to touch, in files the customer also opens in Obsidian and syncs to
their own machine.

**A bare `[[overview]]` is rewritten only when exactly one note answers to that
name.** Obsidian's shortest-path-wins rule is not implemented here and must not
be guessed at: a link that still resolves the way it always did beats one this
code decided the meaning of.

**Code is not a link.** A fenced block or a code span containing `[[example]]`
is documentation *about* a link, and these notes are full of them.

The walk stops at what the caller can see — `move_folder`'s existing rule, and
the one that is easiest to talk yourself out of, because the gateway holds a
credential that could repair a private note's links on behalf of a team caller.
It does not, and the counts reported back are counts over the visible surface
only, because a count over notes the caller cannot list is an inference
channel. The residual is real and stated rather than hidden: after a team
caller's move, links inside private notes are stale until an owner moves
something. An owner sees everything.

A bucket too large to walk for one move reports the rewrite as **not done**
rather than as partial. A partial rewrite announcing success leaves a person
believing their links were fixed.

The rewrite takes no `.history/` snapshot, and that is the current rule rather
than an omission: it landed the same week version history became the customer's
object versioning, and a snapshot here alone would put back the write
amplification that decision measured for every other write path.

**Two copies of the engine, and a test that pins them.** The boundary that
forces it is not the obvious one: `fileOps.ts` already reaches into
`../../../mcp/src/search/*.js`, so the control plane *can* import the gateway.
What forces it is the other two edges — the gateway cannot import
`@context/shared` (dependency-free by rule, and `check-gateway-imports.mjs`
requires relative specifiers), and the mobile app cannot import the gateway
(Metro is configured with `sharedPackages: ["@context/shared"]`). The control
plane takes the shared copy rather than the gateway's, which puts a rename made
in the console and a link drawn by the console on one engine.
`apps/convex/__tests__/linkParity.test.ts` runs both over one deliberately
awkward corpus and requires identical answers, with a floor on how many of them
rewrote anything — a corpus that changed nothing would pass by comparing `null`
to `null`.

**Following a link is ⌘-click, and a plain click still places the caret.** This
is an editor, and a mistyped path lives *inside* a link; an implementation that
followed a plain click reads as working and has made those characters
unreachable. A modifier is invisible, so hovering names the note and the chord.
On a phone it is a long press, and the press **asks** rather than navigating: a
press is also how a selection starts, and what it would replace is the note in
front of somebody, possibly holding an unsaved draft.

**The editor does not check that a link's target exists**, and that is forced
rather than lazy: the tree loads folder by folder, so the console knows the
notes somebody has expanded and nothing about the rest. Requiring existence
would render a link into an unexpanded folder — the normal case — as plain
prose. Following a link to a note that is not there lands on the editor's own
"that file does not exist", which is the answer Obsidian gives.

What a simplification would cost, and the test that catches it: dropping the
`canSee` filter is two failures in `linkRewrite.test.ts`; substituting instead
of recomputing relative links is one there and three in the gateway's
`links.test.mjs`; following a plain click is one in `editorLinks.test.ts`; and
letting the two engines drift is two in `linkParity.test.ts`.

### A route with no way in is a route nobody has

Twice this product has shipped a complete, tested, working feature that nothing
in the app could reach, and the second time it cost somebody a recording.

Meeting capture arrived with a list screen, a live screen and a working
recorder, and no `href`, no `router.push`, no button and no rail entry anywhere
outside `features/meetings/` — the honest answer to "how do I record a meeting"
was "type the URL". The fix was a row at the head of the console's rail. Then a
phone lost its rail (*A phone has no left panel*, above; `regionsFor` answers
`rail: "hidden"` at compact), and `/meetings` went straight back to unreachable
on the one density that records meetings. A review said so before the merge. It
merged. A person then recorded a meeting on their phone, ended it, and had
nothing to open: the file was intact on the device and the list that held it had
no route into it.

**This class is invisible to every test a screen has**, which is why it keeps
shipping. A screen's tests are about what it draws once you are on it, and not
one of them asks how you got there — so a feature that nobody can reach passes
all of them, in full, forever. Nor is it caught by a reviewer reading a diff:
the second occurrence was a *deletion* in one file (the rail at compact) whose
consequence lived in another (a `push` nothing else made).

So the guard is about the set rather than about any one route.
`features/app/reachability.ts` lists every route under `app/(app)/` with the
surfaces that navigate to it and the densities each of those is drawn at, and
`__tests__/routeReachability.test.ts` enumerates the route files off the
filesystem and requires four things: the two lists agree exactly, every
reachable route is covered at all three densities, every claim's evidence is
still present in the file it names, and no compact claim rests on the rail —
that last one read off `regionsFor` rather than off a comment, so the day a
density gets a rail back it stops being a rule instead of stopping being true.

Four decisions in that shape, each of which could have gone the other way:

**Enumerated from the filesystem, never from a list.** A registry that also
supplied the routes would be one list checked against itself, and a route added
without an entry is precisely the case being caught. Expo Router builds its tree
from the file system; so does this.

**Density is a set union, not a boolean.** The two surfaces that replaced the
phone's rail each cover part of the range — the context strip and the bottom row
are `compact`, the rail is `medium` and `wide` — so "reachable" collapses the
distinction that the whole defect lived inside. `/meetings at compact` is the
string the failing test prints, and it is the exact sentence nobody wrote in
2026-08.

**A claim carries evidence, so it rots loudly.** Each entry point names the file
that draws it and the strings that have to be in it. Delete the navigation and
the claim stops matching; a list of prose would have gone on describing a wiring
that was no longer there, which is what the rail's row did for the length of a
release.

**And an exemption is stated in the route's own file as well as on the list.**
`/admin` is deliberately URL-only — it is platform-wide rather than about any
one context, so a strip pill or a rail row would say it belongs to whichever
workspace is selected — and it is the precedent for the exception list rather than
an invention of one. A reason that lived only in the registry is a reason the
next person editing that route never reads.

What the guard cannot do is lay a screen out: jsdom hit-tests nothing, so "the
control is on the glass at that width" stays with the mounted tests each surface
already has (`consoleChrome.test.ts`, `meetingsFlow.test.ts`,
`meetingsEntry.test.ts`, `railGroup.test.ts`). What is genuinely new is the
*completeness* claim, which none of those can make.

It also carries its own guard, per [testing](./testing.md)'s one rule: every
assertion in the file quantifies over the walk's result, so an enumerator that
returned `[]` would satisfy all of them. `the walk finds the routes it is
supposed to be checking` is the self-test, and emptying the enumerator is one of
the six sabotages recorded in the file's header. The one worth knowing is the
first: deleting the row that closes this incident fails `a claim names a file
that still contains the wiring`, and deleting the registry claim with it fails
`every route is reachable at every density, or says why not`.

This is the same shape as `features/app/frame.ts`'s *what is deliberately kept
although no density reaches it* — a list whose entire worth is that something
reads it — and the two sit beside each other for that reason.

### A context pill's target is not its mark

The workspace strip is a phone's **only** route between contexts — no rail, no
drawer, no menu, no keymap — so `contextStrip.test.ts` holds every pill to
`minTouchTarget` and says what a target under the floor costs: navigation
somebody misses and concludes is broken.

Then the owner asked for the pills "smaller and squarer", so more workspaces are
on screen at once, which is the edit that guard exists to refuse. Both are
right, and they are only compatible because they are about two different
objects: the **pressable** is what a thumb hits and the **mark** is what an eye
reads. That is `accountAvatar`'s own rule — "what a thumb hits is the pressable
around it, and the caller pads to the floor" — which this surface had never
applied, because the pill was both.

So the pressable stays `minTouchTarget` and draws nothing, and the mark inside
it is `layout.stripPill` on `radii.md`. The height was never the constraint on
how many fit: the horizontal saving is the padding and the row's gap, and that
is where "more of them fit" is actually paid. `radii.md` rather than
`radii.pill` is the "squarer" half — a stadium reads as a button, a rounded
rectangle reads as a tab, which is what this is.

The two halves fail separately, which is the point of separating them: drawing
the mark at the target's height fails only the new check, and shrinking the
target instead of the mark fails both.

**Still open, and deliberately not taken here: the strip does not scroll away.**
The same review asked for it — the pills are pinned while the content moves and
*"it looks pretty ugly"*. That is not a `ContextStrip` change: at `compact` the
frame floats its bars over a full-bleed document and every screen pays for them
in content padding (`surfacePadding`), so making the top row scroll means either
moving it inside a scroller the frame does not own, or plumbing a scroll offset
out of every routed surface into the frame. Both are frame-wide and touch every
console screen; neither is worth guessing at from a phone recording. What is
already true is that content scrolls *under* the bar rather than being pushed by
it, which is the reference's own behaviour — so what is being asked for is a
hide-on-scroll, and it wants its own decision.

### The palette is a navigator, the search page is a place, and one row joins them

The command palette answers *"take me to that note"*: ten rows, no scrolling,
gone the moment you press Enter. It is very good at that and it is the wrong
shape for the other question people bring to a set of notes — *"what do we know
about the review cycle"* — where the reader has no destination in mind, needs to
read several results next to each other, will narrow the scope halfway through,
and will open one, read it, and come back. Every one of those wants a URL, and
none of them survives an overlay that closes on the first press.

So `/console/search` exists and the overlay keeps its ten rows. What joins them
is one row at the bottom of the palette's own list.

**A row, not a button in the chrome.** The chrome is not on the path a keyboard
takes: a "See all results" button beside the input is reachable by a mouse and
invisible to the arrows, which is the same defect as a control drawn where a
phone cannot see it. As the last row it is in the one flat list that `selected`,
the wrap-around and the scroll arithmetic all walk — ↑ from the top reaches it
in one keystroke, and with nothing matching it is the only row there is, which
is exactly when "Enter opens the search page" is unambiguously what somebody
meant. **Enter elsewhere still opens the highlighted note.** The obvious wrong
implementation makes Enter always open the page; it looks correct until somebody
presses ↓, which is why `paletteRender.test.ts` moves the highlight before it
presses Enter.

The synthetic row is intercepted inside the palette rather than handed to
`onChoose`. A palette that leaked its own sentinel id to callers would have
every caller writing the same guard, and the one that forgot would try to open a
note named after it.

**The handoff carries the query and deliberately not the scope.** The palette
searched the context you are standing in; the page defaults to every context you
can reach, because that is the question the page is for. Narrowing back to one
is a chip away and lands in the URL when you do it.

### The search page's state is its URL, and that is a trade taken on purpose

`/console/search?q=review%20cycle&in=seyi,lk`. The route holds no state of its
own: the pane reads the query and the scope as props and writes them back
through the router. Typing `replace`s and changing the scope `push`es — pushing
a history entry per keystroke would make Back a way to delete letters, while
going back to the previous scope is a real thing to want.

The cost is that the words somebody typed are in browser history, in anything
they paste, and in any referrer a link from the page sends. It is worth it: a
search page that cannot be reloaded, linked, or returned to after opening a
result is a modal wearing a URL, and those are three of the four things people
do with one. What makes the trade defensible is that it is bounded to text a
person deliberately typed into a visible field — the *cursor* beside it carries
a fingerprint of the query and never the query, because nobody reads a cursor
and nobody chose to put one anywhere. See `docs/decisions/search.md`.

**The scope is slugs and never workspace ids.** `?in=seyi,lk` is the console's
own public addressing, the same as `/console/@seyi`, and a URL somebody may
paste into a chat should not carry database identifiers. It also degrades
usefully: a slug the recipient cannot reach resolves to nothing on their side,
exactly as the server drops an id they cannot search, so a shared link narrows
to whatever the reader can actually see rather than erroring.

### Four ways to have no results, and each is a different sentence

A page that spans several contexts has more ways to be empty than a palette
does, and collapsing them is how a search tells somebody their notes are not
there when nothing looked:

- **Nothing is searchable** — no context this person can reach has fast search
  on. `eligibleCount: 0` comes back from the server for exactly this, and it
  outranks even "type something to search", because there is nothing to type
  into. The copy points at the setting.
- **The scope was narrowed** to contexts that had nothing. Widening is one press
  away and the sentence says so.
- **Everything was searched and nothing matched** — the only case where "no
  matches" is true.
- **Part of it could not be reached** — results from four contexts and a timeout
  on the fifth, which is neither "no matches" nor a failed search. It is a
  partial answer with a retry beside the row that failed, and the retry is the
  same blended call narrowed to that one context, so it goes through the same
  authorization and the same filter.

A context whose index is still catching up gets its own line for the same reason
the palette has an `indexing` state: a blended list is where "this context said
nothing" is most easily misread as an answer, because the other contexts
answering makes the silence look like a result.

They are one enum in `features/console/search/results.ts` rather than a chain of
ternaries in the pane, so each case is named, tested, and a fifth cannot fall
silently into the "no matches" arm.

### Search is in the app's navigation, and it disappears only on a measured zero

It is app level rather than a context's, because the question spans contexts — a
Search *inside* a context would default its scope to that one, which is the
search that already lives behind the palette.

The row is drawn only where something would answer it: a person whose contexts
all have fast search off has a destination that can only apologise. But
`appSectionsFor(undefined)` **draws** the row, and that asymmetry is the rule.
The eligible count arrives from a Convex query a beat after the first paint, so
treating absence as zero would make Search flicker into existence on every load,
and a navigation item that appears late is one people learn not to look for. It
also keeps the demo console and the reachability registry honest: neither has a
live query behind it, and neither should have to fake one to draw the app's own
navigation.

### The console autosaves, and the prompt that is left is about a decision

The editor had one route from a draft to the customer's bucket — the Save
button, or ⌘S — and three separate interruptions arranged around it: a refusal
to open another note, a confirm before closing a tab, and the browser's
"leave site?" on every unsaved draft. The owner's words for that: *"it's
something people are used to already in every note taking app, so it's so
necessary, stop bugging people to save."*

**Two timers, and the second one is not decoration.** The draft is written
`AUTOSAVE_IDLE_MS` (2s) after it stops changing, and at latest
`AUTOSAVE_MAX_WAIT_MS` (15s) after the first edit of a burst, whichever comes
first. An idle-only debounce is the obvious design and it never fires for iOS
dictation, which inserts a partial result every few hundred milliseconds — a
dictated paragraph would sit unwritten for as long as somebody kept talking.
The ceiling is measured from the first edit and is not pushed back by later
ones, or it is a second debounce.

**The numbers are a cost decision, on somebody else's quota.** One save is a
Convex action → the gateway → one conditional PUT against the customer's bucket
plus a LIST to refresh the note's folder: two requests. At these intervals
ordinary composing costs about what the Save presses it replaces did, and
continuous input is bounded to four saves a minute. A save per keystroke is the
version of this feature that is not shippable, which is why the scheduler is a
module with its own tests rather than an effect.

**What autosave refuses is the whole safety argument** (`autosaves` in
`editor.ts`, asked again when the timer fires rather than trusted from when it
was armed):

- **`conflict`, never.** The draft is based on an etag somebody else has moved
  past. Writing it automatically is a refusal every two seconds against a
  bucket that does conditional writes, and a **silent clobber** against one
  that can only read-compare. The three answers in `ConflictResolver` stay the
  only way out, untouched.
- **`error`, once and no retry loop.** A save that failed for a reason nobody
  has read does not get retried every two seconds. It re-arms by itself the
  moment somebody types, because `edited` moves `error` back to `dirty` — what
  every editor does, and why there is no retry logic.
- **`queued`**, because the offline queue already holds the newest text and
  supersedes; and anything read-only, clean or already in flight.

**Every autosaved write is the same conditional write Save makes**, carrying
the etag the draft was typed against. There is no force flag, no unconditional
branch and no second write path in `useFileBrowser`. Relaxing this is how
autosave becomes the feature that quietly overwrote somebody's Obsidian.

**The scheduler hands back the path it was armed with, and the caller compares
it.** `autosaveNow` reads the text and etag off the editor, so a timer that
fired after a note switch without that comparison writes **the new note's text
to the old note's path, against the new note's etag** — a conditional write the
server has every reason to accept. The reachable sequence is not exotic: the
read for the next note is a round trip, and typing during it arms a timer for a
note that is about to be replaced.

**Allowing navigation during a save is what made the settlement path-aware.**
The editor reducer describes the *open* note, and until now nothing could leave
a note with a write in flight, so `saveSucceeded`, `saveFailed` and
`saveTimedOut` could be dispatched blind. Each is now gated on the editor still
holding the note the write was for — a late success would otherwise mark
another note's real draft clean against an etag it was never based on — and the
save generation and its timeout are keyed by path so two writes in the air
cannot discard each other's answers. A save that ends for a note nobody is
looking at reports itself in the notice line, naming the note and saying its
draft is on the device.

**`guardLeaving` keeps exactly one job: `needsDecision`.** A conflict and a
failed save are the states nothing writes for you, so they are the only ones
worth interrupting somebody for. Everything else is flushed on the way out:
`select` writes what is pending before the selection moves, closing a tab does
the same by path (`closeIntent`), and on web `visibilitychange`/`pagehide`
flush while `beforeunload` prompts only for the two. That last one makes the
prompt *better* rather than merely rarer — browsers increasingly decline to
show it for a page that always asks, so asking on every draft was spending the
browser's patience on the case that was never in danger.

**The flush is best-effort and is not the guarantee.** A write issued from a
page being torn down may not leave the machine. What makes a draft safe is
`features/offline`: every keystroke is on the device, and `restoreFor` puts it
back — as a conflict if the bucket moved on — when the note is reopened.

The copy follows the behaviour, because a status line that still says "Unsaved
changes" over a draft that is being written is the same nag in a smaller font:
"Saving soon" (quiet) → "Saving…" → "Saved in your bucket", and a resting
button that says "Saved" rather than offering a dim "Save". It still says
"Save" over a body read off the device, where "Saved" would vouch for a bucket
nothing has spoken to.

**What a reversal costs, and the tests that fail.** Dropping the ceiling loses
dictation entirely (`autosave.test.ts`); autosaving a conflict is a clobber
somebody was never shown (`autosaveEditor.test.ts`, twice over); dropping the
path comparison writes one note's words into another file
(`autosaveEditor.test.ts`, "a timer armed for one note cannot write into
another that is also dirty"); dropping the path check on a settlement marks a
real draft clean (`saveTimeout.test.ts`). One guard is recorded in
`autosaveEditor.test.ts` as *not* covered rather than quietly claimed:
`performSave` cancelling the timer it supersedes is redundant with the
fire-time `autosaves` check, and nothing can distinguish the two.

### The breadcrumb is the whole path, and its head is a real way up

Two screenshots from a phone, and one report:

> when you click on a workspace it puts it inside the breadcrumb. But clicking
> on the workspace name in the breadcrumb should take you to the root. Right now
> it doesn't do anything. It persists where it last was, which is good when
> you're going from one workspace to a new workspace, but not good for a
> breadcrumb. It doesn't even show the rest of the items, what path you're in.
> The UX there is pretty broken; you're not able to really navigate.

Three defects, and each of them is a decision recorded above being right about
its own case and wrong one step later.

#### 1. The lit pill did nothing, because there was no "close the note"

`CurrentContextPill` presses to `browseHref(slug)` — `/console/@seyi`, no
`?note=` — which is exactly what "open its root" means. **The URL is a mirror**
(above) then re-addressed the open note within the same tick, because
`noteAddress.ts` read a console URL that had lost its note as *stale* rather
than as an instruction, on this reasoning:

> there is no "close the note" for it to be expressing — `select` takes a path
> and the file browser has no deselect — so treating it as one would leave the
> address bar disagreeing with the screen.

Correct about the mechanism, and the cost was the one control on the screen
labelled as the way up doing nothing at all. So the missing verb is the fix
rather than the excuse: `FileBrowser.deselect` is `select`'s inverse — flush
autosave, ask `guardLeaving`, clear the selection, empty the editor, drop
`opening` — and the address rule becomes symmetric. **A URL that changed is a
navigation**, honoured whichever way it went: to a note it is a link, to nothing
it is a close.

The asymmetry that is left is the one doing the work. A URL that did *not*
change is not a navigation, whatever it says — somebody tapping a note at
`/console/@seyi` produces a commit where `note` is `null` and the selection has
moved, and reading that as a close would shut every note one commit after it
opened (`noteAddress.test.ts`, "a URL that never had a note does not close what
the person just opened").

Two consequences that are not obvious and are each held by a test:

- **A refused close puts the note back in the address**, where a refused
  `select` does not. A refused `select` leaves `?note=` naming the note somebody
  was going to, and a reload opens it — where they were headed anyway. A refused
  close leaves the address at the root with a conflicted note still open and
  unanswered, and the phone writes that address to the device: the next launch
  would come back to the root with the conflict gone from the screen and the
  draft still in the outbox.
- **Closing settings has to name the note behind it.** `SettingsPane` is pushed
  over Browse and leaves it mounted, and the route dismissed it with
  `router.replace(browseHref(slug))` — harmless while a bare console URL meant
  nothing, an instruction to close somebody's note now. `settingsClose.test.ts`
  exists to stop that being tidied back into the one-liner it was.

The device record needs no new machinery: `useRememberPlace` is fed the *URL's*
note (see **A URL is a context and a note**), so a press that clears `?note=`
files the context at its root by construction, and the relaunch after it does
not reopen what was just closed.

**Amendment: the first fix did not hold, because `router.replace` to the same
screen is a remount, not a no-op.** Everything above is right, `deselect` is
still the missing verb, and it shipped with `onOpenRoot={() =>
router.replace(browseHref(current.slug))}` in `_layout.tsx`. On a native
build the pill still did nothing — reported again, this time filmed on an
iPhone rather than described from a screenshot.

`router.replace` dispatches a React Navigation `REPLACE` action, and
`@react-navigation/routers`' `StackRouter` answers every `REPLACE` by calling
`createRouteFromAction`, which mints a route key from `` `${name}-${nanoid()}` ``
**unconditionally** — there is no branch that reuses the current key because
the params did not change. A fresh key remounts whatever that key names, and
what it names here is `ContextBrowseRoute` — not `_layout`, not
`ConsoleDataProvider`, not the `FileBrowser` instance underneath it, all of
which are mounted a layer up and do not move when a child's key changes.
`useNoteAddress`'s `seen` ref lives on the side that remounts. So the press
that was supposed to close the note instead: cleared the URL's `?note=`
(correct), remounted the hook watching it (not requested by anything in the
fix), reset `seen` to `null`, and handed `nextAddressStep` a "fresh" instance
holding a leftover selection — which it read as a cold load whose URL simply
had not caught up yet, and answered `address`, writing the note straight back
before the closed screen was ever visible. The round trip landed exactly
where it started, silently, once per press.

Nothing about the first fix's *reasoning* was wrong: `deselect` is still
exactly the missing verb, and the symmetric rule — a URL that changed is a
navigation, honoured whichever way it went — is still the right rule for a
URL that actually needs to *go* somewhere. What was wrong is that the pill's
press never needed to be a navigation at all: there is no route to leave and
none to arrive at, only a selection to clear in the browser standing above the
route. So the call site changed to `onOpenRoot={() => { data.files.deselect();
}}` — no `router` call, no `REPLACE` action, no remount, no `seen` reset,
identical on web (where this was never visibly broken; see below) and native.
`useNoteAddress` sees the selection change under an unchanged URL and takes
the same "address" step a tapped-closed tab already takes, and the address
lands one commit later with nothing in between for a remount to corrupt.

Because the *reason* the shipped fix broke — a `seen` reset while the browser
survives — is a property of `nextAddressStep` and not only of this one call
site, `noteAddress.ts`'s `fresh` branch no longer trusts the assumption the
remount violated ("the selection is empty by construction"). It now closes a
leftover selection instead of re-addressing it, which is provably safe rather
than merely reasonable: `useFileBrowser` clears `selectedPath` in the same
commit it adopts a new `contextId`, so a *genuinely* fresh instance can never
reach that branch holding a non-null selection in the first place — the
combination is unreachable except through exactly the remount this amendment
describes. `noteAddress.test.ts`'s "a fresh instance holding a leftover
selection closes it rather than re-addressing it" pins the new answer, and
`breadcrumbRoot.test.ts`'s "closes the open note even if the route remounts
under the press" reproduces the composed bug directly — a route remounted in
the same commit the URL drops its note — as a standing guard against a future
call site making the same round trip for the same reason.

**This is not native-only, and the source says so rather than a screenshot
from the field.** `expo-router`'s `<Slot/>` (`views/Navigator.js`) renders the
focused route as `descriptors[state.routes[state.index].key].render()`, and
that `render` — `@react-navigation/core`'s `useDescriptors.js`, one
implementation, no `.native.js`/`.web.js` split — wraps every screen's element
in `key: route.key` before handing it back. `StackRouter`'s `REPLACE` handler
mints that key from `` `${name}-${nanoid()}` `` unconditionally, with no
branch that reuses the current key when the params it carries are otherwise
identical. None of this is platform code: it is the same `@react-navigation/
core` and `@react-navigation/routers` packages under both the native-stack
view and the web bundle, and React's own reconciliation-by-`key` does not
special-case a browser. A changed key is a new element on every renderer React
has. So the remount is not a maybe to be masked by timing — it is a guaranteed
consequence of calling `router.replace` on this route on **any** platform this
app ships to, and the symptom it produces (the still-open note, because
`nextAddressStep` writes it straight back) is not a race either, so there is
no window in which a faster or slower browser would come out differently.

What is genuinely unverified is only whether anybody happened to *notice*: no
test in this repository mounts the real `expo-router` navigator against a
real browser history, and the owner's report came from a native build. Given
the mechanism, the honest expectation is that a web session pressing the same
pill hit the identical silent round trip and nobody was looking — not that
the web platform was ever exempt from it. Treat that absence of a web report
as absence of evidence, and not as license to reintroduce a `router.replace`
here on the reasoning that nobody saw it fail in a browser.

#### 2. The path stopped one segment short of where you were

**A phone gets a path bar** (above) argues the leaf away: the note names itself
inside the document, so a trailing segment says the same words twice. The rule
is real — `ShareScreen` was fixed for exactly it — and it was applied to the
wrong element. Both of the names it defers to are **inside the scroller**: they
are gone the moment somebody reads past the first screen, and the band is what
stays. Worse, it made `index.md` — every context's front page, and the first
note anybody opens — render as a lit pill and nothing else, over an open editor.
That is the second screenshot.

So the leaf is drawn, on both densities, and it is a **position rather than a
control**: pressing it would re-select what is already open. It says what the
note *calls itself* (`noteHeading`, the same ladder the inline title climbs)
and, falling back to the filename, drops the `.md` — filing, not a name, and the
same trim `noteHeading` already made.

The count of segments is capped and no label is ever shortened, which is
`ContextStrip`'s rule kept and its scope corrected. Nothing truncates is right
about **names** — `3-resour…` and `3-resour…` are two folders that look
identical on the control whose job is telling them apart. It is not an answer
for **depth**, because the segment that scrolls off the trailing edge is the
leaf. Past `MAX_FOLDER_CRUMBS` the middle elides to `…`, keeping the root folder
— the PARA bucket, where you go to start again — and the immediate parent, where
you go to step back. Nothing becomes unreachable: both are pressable, and the
root folder's listing is how anybody reached the hidden ones in the first place.

**Two, not three, and the number came out of a browser rather than out of the
argument.** Three was written first and then measured at 390pt with Playwright:
`3-resources/books/reading-notes/2026/the-lean-startup.md` elided to three
folders still put the leaf 137pt past the edge, and to two put it 27pt past.
Which is the honest conclusion — **a count cap cannot guarantee a fit**, because
segment names belong to the customer and no count is a width. What it buys is a
row that is *bounded* instead of one that grows with the tree, and the segment
it drops is the middle of the path, which is the part a breadcrumb is least read
for.

**Superseded, 2026-09-10.** The cap this argues for is gone — `MAX_FOLDER_CRUMBS`,
the "first, gap, last" reshaping, `crumbs.ts`'s `{ kind: "gap" }` crumb — deleted
along with the character budget it grew into (§4, below), because the constraint
both existed to solve was *width*, and width stopped being a constraint the day
row two of `NavBand` became a horizontal `ScrollView`: the owner's own words,
once that scroller existed to make the question worth asking again, were "I feel
like we shouldn't even show `...` ellipses, we should just show the full path but
allow a horizontal scroll." Removing the cap makes strictly **more** of the path
reachable than "two, not three" ever kept — every segment is its own pressable
target now, not only the root and the immediate parent a cap kept live — so the
reachability this section argues for is satisfied rather than reversed. What
expired is only the reason a cap was thought necessary at all; the measurements
below are kept as the record of why it once was one. See `crumbs.ts` and
`features/console/files/Breadcrumb.tsx`.

The row stays anchored at its **leading** edge when it does overflow, and that
is a choice about what may go off screen. The pill is a control — the way up,
and the thing this whole change is about — while the leaf is a statement the
document under it also makes. A control you cannot reach is worse than a fact
you have to scroll to, and `NavBand`'s trailing fade is what says there is
more.

`crumbs.ts` is one pure function and both renderers map over it, the pointer
layout passing `maxFolders: null` because it has the width for the whole path
and a chip beside it. That is the answer to "unify rather than duplicate": the
last time the two surfaces each decided for themselves what a segment was, one
of them dropped the leaf, then the context, and shipped.

#### 3. A switch must not draw the old context's path under the new one's pill

**A URL is a context and a note** (above) fixed the address and the device
record across a switch. The band has the same lag from the other end and needed
saying: everything else in `BrowsePane` is drawn from the file browser's own
state and stays internally consistent while the browser catches up — the
breadcrumb does not, because the pill at its head comes from the *console's*
selection and moves with the URL. Uncorrected it reads
`@supa / 3-resources / a-note-in-seyi`: one context's pill over another's path,
a sentence that has never been true, and exactly the "it persists where it last
was" in the report. `BrowsePane` draws the path only while
`files.contextId === data.selectedContextId`; until then the pill stands alone,
which is honest and is where the switch is going. Restoring the other context's
place is unchanged and is still the good half.

#### 4. A count cannot guarantee a fit, so a width budget does

**Superseded, 2026-09-10 — everything in this section is deleted.** `budget`,
`phoneRowBudget`, `CHAR_WIDTH_PX`, `SEPARATOR_CHARS`, the leaf's `fullLabel`,
`SLACK_PX` — all of it, along with the cap it topped up (§ above). The scroller
this section spent its whole argument working around answers "does the leaf
fit" for free, correctly, at every width and every font size, which a
pixel-width estimate could only ever approximate from one browser's rendering
of one font stack. Kept below as the record of why a budget seemed necessary at
the time and what it cost to get right; the sabotage table at the end of this
section is no longer a live guard, since the code and the tests it names do not
exist any more.

**Two, not three** (above) said the honest thing about `MAX_FOLDER_CRUMBS`: a
cap bounds the row, it does not fit it, because segment names are the
customer's and no count is a width. That honesty shipped as two screenshots —
`1-note-two-folders-deep.png` had the leaf's last two letters under the
trailing fade, and `5-deep-path-elided.png` cut "the-lean-startup" to
"the-lean-sta…" — on the one segment the whole row exists to state. "Scroll to
see the rest" is a real answer for a folder somebody mostly reads by shape; it
is not one for the note's own name.

So a caller that needs the fit guaranteed — today, only the phone's `pathOnly`
row — passes `crumbs.ts` a character `budget`, converted from the screen's own
width by `Breadcrumb`'s `phoneRowBudget`, and the leaf becomes the thing that
is protected rather than the thing that goes missing. Folders give way first,
and **from the front, one ancestor at a time**, rather than in one jump to a
bare `…`: the immediate parent is the folder worth keeping pressable
longest — it is where "step back" actually goes, which the pill in front of
this row does not reach — so it survives until the width genuinely has no room
even for it alone. Only when a single `…` standing for the whole path still
does not leave the leaf room is the leaf's own label shortened, and it is
shortened in the **middle** (`the-lean…tup`) rather than at an edge, so it
keeps both the word somebody typed and the word they would search for.

Every pixel constant this needs — the band's margin, the trailing fade, the
pill's own footprint, a flat safety margin — is named for the real style it
estimates rather than folded into one guess, and every one of them is biased to
**overestimate** the room the pill and the chrome take: a budget that thinks
the row has less space than it really does costs a folder that could have
stayed live, never a leaf that spills past the edge it was computed for. That
bias is not a preference, it was found the hard way — the first cut of this fix
priced a separator at one glyph and left the row 18pt over anyway, because
`NavBand`'s flex row puts a 6pt gap on *both* sides of every separator and
nothing had charged for it. `SEPARATOR_CHARS` (`crumbs.ts`) and `SLACK_PX`
(`Breadcrumb.tsx`) are that correction, kept as named constants rather than
folded back into `CHAR_WIDTH_PX` so the next person tuning this can tell which
piece moved.

#### The tests that fail if any of it is reversed

Sabotage record — each applied as a local edit, run, reverted. Counts are
failing tests.

    the URL that lost its note re-addressed (the shipped rule)          5
    `close` whenever the URL has no note (every note shuts on open)     1
    `deselect`'s refusal ignored by `useNoteAddress`                    2
    `deselect` without the unsaved-changes guard                        1
    the leaf dropped again (ancestors only)                            16
    no elision, the row just gets longer                                3
    `BrowsePane` drawing the previous context's path                    1
    settings closing to the bare console href                           1

`breadcrumbPath.test.ts` owns the pure path model, `breadcrumbRoot.test.ts` the
pill press end to end (it closes the note, the device stops remembering it, a
refused close comes back, and pressing *another* context still restores where
you were there), `noteChrome.test.ts` the rendered band, `linkedNote.test.ts`
the close against the real `useFileBrowser`, and `settingsClose.test.ts` the
one href a tidy-up would undo. `breadcrumbPath.test.ts`'s own "protecting the
leaf with a character budget" block carries the sabotages for §4 above — the
budget ignored past the cap, the leaf-truncation branch skipped, a leaf cut
from an edge instead of the middle — each a local edit to the width-budget
fallback, run and reverted, with the count in the test's own comment rather
than repeated here: the model they are against moves with `CHAR_WIDTH_PX` and
`SEPARATOR_CHARS`, and a number copied out here would drift from the one
somebody can actually reproduce.

**What is not covered here**: the numbers came from Chromium at 390x844 driving
the real components against the landing page's demo data, not from a device.
`phoneRowBudget`'s constants are estimates of real styles, checked against one
browser's rendering of one font stack — a different platform's font metrics
could still put the leaf a few points off from where this aims, which is why
every estimate in it is biased to assume *less* room than the real row has
rather than more. Whether that bias is generous enough on a 320pt phone, and
whether the trailing fade still reads as "there is more" once it is only ever
covering a folder and never the leaf, are questions for a phone in a hand — a
number to revisit, not an invariant. The screenshots that settled the original
count, and the ones that settled this fix, are attached to the pull requests
rather than committed: they are evidence for a decision, not a fixture anything
reads.

### A link key on the accessory bar, reversing the decision that dropped it

`NoteAccessory.tsx`'s own header used to argue, at length, against a wikilink
key: "it is Obsidian's wikilink key, and the `[ ]` beside it already covers the
one bracket pair that means something here." That was correct when it was
written and it is the sentence this section reverses — **A2** in the
editor-polish sweep, and the sweep is explicit that reversing a documented
decision needs the argument made again in the file rather than a quiet edit,
which is what this is.

**What changed underneath it, and why the same argument no longer holds.**
Three things were true when the key was dropped and none of them is true now:

- **A bare `[[name]]` did nothing.** `noteLinks.ts` drew a wikilink only once
  it resolved, and nothing resolved a bare name at all, so a key that inserted
  `[[]]` would have opened onto silence — the same failure mode F3 in the sweep
  names for typing one by hand. **L1** (the note-path index, `[[`-completion
  reusing the search index's own docmap) closed that: typing `[[` now offers
  every note the index knows about, on every density, which on a phone is
  close to every note in the bucket rather than the folder in front of you.
- **Links had no place in the phone's chrome at all.** *The phone gets a path
  bar* (above) is the section that put a breadcrumb back on a phone, and *A
  touch screen is told nothing about the gesture* (**L3**) is the section that
  gave a touch-followable link its own always-visible underline. Before both,
  a link on a phone was a bracket pair with no visual distinction and no way
  up if you followed one by accident. A `[[` key that opened onto that surface
  would have been a control pointed at a feature with nowhere to land.
- **The bracket-pair argument assumed one bracket key had to do both jobs.**
  `brackets` still draws the task checkbox — that has not changed and is not
  what this reverses — but "the one bracket pair that means something here"
  was true only because `[[` meant nothing yet. It is not an argument that a
  *second* key cannot exist; it was an argument that a second key had nothing
  to be *for*.

**What the reversal is, concretely.** A `link` key, inserting `[[]]` with the
caret placed between the brackets and the completion list opened immediately
— the same behaviour `linkComplete.ts` already gives a person who types `[[`
by hand, reached without typing two characters on a soft keyboard that makes
`[` two taps deep on most layouts. Placed beside `bullet` and `task`, the two
other keys `A1` established as "the thing a person writing notes in a hurry
actually reaches for" — a link to another note is exactly that category, not
adjacent to it.

**What this does not reverse.** The *reasons* Obsidian's own `tag` and
`attach` keys stay off the bar are untouched: this product still has no tag
model and no attachment upload from the console, and a key for either would
still be present and do nothing. This section is narrowly about the one key
whose absence was a fact about link resolution rather than a fact about the
product, and that fact changed.

The test that fails if this is reversed: `noteAccessory.test.ts`'s check that
the `link` key exists, inserts `[[]]` with the caret between the brackets, and
opens the completion — dropping any one of those three fails it and only it.

### The communications console reads through `FileBrowser`, not a new tool

`docs/decisions/communications.md` decided the on-bucket shape and the
gateway's `list_channel_days`/`read_channel_day`. The console's Inbox,
Channel, Channel-day and Contact pages read the **same bucket** through the
**same interface** every other console screen already uses —
`apps/mobile/features/console/files/browser.ts`'s `FileBrowser`, backed by
`listFiles`/`readNote` — rather than a fifth Convex action shaped around
these four views. Two members were added to that interface, both read-only
and both already the shape a demo and a real browser can each answer:

- **`ensureListing(path)`** — fetch a folder's listing into the cache without
  selecting it. The Inbox needs several folders at once (`0-inbox`,
  `0-inbox/email`, and every channel folder it finds) and none of them is "the
  folder somebody navigated into", which is the only case `select` already
  covered.
- **`readRaw(path)`** — a note's text and etag, without opening it in the
  editor. A channel-day's split parts and a contact's linked days are reads
  that are not "the open note", and routing them through `select`/`editor`
  would mean a `NoteEditor` momentarily holding a day's raw markdown on the
  way to `ChannelDayView` parsing it back out.

**Both promise nothing beyond what a listing or a read already promises.**
`ensureListing` is a cache-fill, not a subscription — a caller that wants a
fresh copy after a write already has `select`/`refresh` for that. `readRaw`
answers `null` for a path this scope cannot see, byte-identically to a path
that does not exist — the same non-negotiable `read_note` and
`read_channel_day` already hold the gateway to, now held by the console's own
read path rather than assumed to follow from it. `useDemoFileBrowser`
implements both against `tree.listings`/`tree.notes`, which are already
built whole and synchronously, so `ensureListing` is a no-op there and
`readRaw` never touches a network — the same "one interface, two
implementations" rule the rest of `browser.ts` documents.

**Why not a fifth Convex action instead.** `list_channel_days` and
`read_channel_day` exist because an MCP tool call is the unit an AI client
reasons in — a listing and a read of one note, message bodies withheld by
default because a model was not asked for them. The console is not an AI
client: it already has a general file browser that lists folders and reads
notes with `canSee` applied identically, and building a second, console-only
"list channel days" action would be two implementations of one visibility
rule with two chances to disagree about which paths a team caller may
enumerate. `discoverInboxChannels`, `collateChannelDays` and
`shapeChannelDay` (`features/console/communications/{inbox,channel,day}.ts`)
do the shaping this console needs entirely client-side, over listings and
reads the gateway already filtered — no index, nothing that can drift from
the bucket, the same property the Inbox landing page's own virtuality argues
for one layer up.

The check is `commsPaths.test.ts` and `commsInbox.test.ts`: every shaping
function is pure, fed `FileEntry[]`/`{text, etag}` shapes a fixture builds by
hand, with no `FileBrowser`, no Convex client and no bucket anywhere in the
test.

#### Meetings stays a generic folder; only the three messaging channels get a day view

`classifyCommsPath` routes `0-inbox/email/<slug>`, `0-inbox/google-chat` and
`0-inbox/imessage` to `ChannelView`/`ChannelDayView`, and deliberately answers
`null` for `0-inbox/meetings` — the ordinary `FolderView` keeps listing it.
**A channel-day note is one file standing for a whole day; a meeting note is
one file standing for one meeting**, and several can land on the same date
with nothing in common beyond it. Building a "day" view for meetings would
mean inventing a grouping nobody asked for — the scoping note's own tree
lists `meetings` beside the messaging channels as an Inbox *child*, for
recency, not as a second channel-day shape. `inbox.ts`'s `activeDatesFor`
reads a meeting's date off its filename (every meeting note begins
`YYYY-MM-DD-`, per `packages/meetings`'s own `MEETING_FILE`) for the same
reason the Inbox is virtual at all: reading every meeting's frontmatter just
to sort the landing page by date would spend a body-read this page exists to
avoid paying.

`0-inbox/contacts` is `null` from `classifyCommsPath` in the same way and for
a related reason: it is a row on the Inbox (`inbox.ts` treats `contacts` as a
fifth `InboxKind`, reading its recency off the listing's own `updatedAt`
rather than any content — a contact page is edited, not dated by a channel),
but the *folder* is a generic listing of contact pages. A nicer list —
showing each contact's own name rather than its filename slug — is a real
improvement and is deliberately not built here: it would need reading every
contact's frontmatter for a folder listing, which is the same cost this
whole page structure exists to avoid, and is a candidate for a small,
separate index the day it is worth one.

The check is `commsPaths.test.ts`'s `"meetings is never a comms route"` and
`channel.ts`'s own header, which states the asymmetry rather than leaving it
to be rediscovered as a gap.

#### A note's anchor is a query parameter, not a URL fragment

`noteHref(slug, path, anchor)` writes `/console/@slug?note=<path>&anchor=<id>`
— never a literal `#<id>` on the end of the URL, even though every wikilink
this product writes (`[[path#anchor]]`) and the decision that named this
routing contract both use `#` as the separator. The mismatch is deliberate:
`useLocalSearchParams` reads query parameters identically on web and native,
and Expo Router's linking config has no cross-platform contract for a bare
URL fragment the way a browser does — native has no address bar for one to
survive in at all. A query parameter is the shape `?note=` already uses for
exactly this reason, so the anchor rides the same mechanism rather than
inventing a second one that only works on web. `anchorFromQuery` is the read
side, deliberately as permissive as `noteFromQuery`: absent, empty or
whitespace all mean "no anchor", never a refusal — an anchor is never used to
address storage (only to find a heading already on the page), so it does not
need `safeNotePath`'s path-traversal refusals.

**This is the routing contract the task named "expose the anchor scroll as
the routing contract they can use."** A contact's activity link
(`ContactPageView`'s `onOpenActivity`) and a future per-anchor search result
call the identical function with the identical two arguments; there is
exactly one way in this console to say "open this note and scroll to this
place in it," and it is `noteHref`'s third argument.

**`useNoteUrl` clears `?anchor=` on every write, and this was a real bug
caught before it shipped rather than a defensive habit.** `setParams` merges
rather than replaces: following an activity link to `?note=A&anchor=X` and
then tapping an ordinary row to open note `B` — through `select`, never
through `noteHref` — left the address at `?note=B&anchor=X`, a stale anchor
for a message that is not even in `B`, read back the next time anybody
opened that URL. `useNoteUrl` is the *reconciliation* path (the browser's own
selection moved and the URL is catching up), which is never the path that
means to name an anchor, so it always writes `anchor: undefined` alongside
whatever `note` it writes. The check is `noteUrlAnchor.test.ts`.

#### A message body is rendered, never linkified

`ChannelDayView`'s messages render `**bold**`, `*italic*` and `` `code` ``
(`markdownInline.ts`'s `tokenizeInline`) and stop there — `[[wikilink]]` and
`[markdown](links)` inside a message body are shown as the literal characters
a sender typed, never turned into a pressable link. This is not an
unfinished feature; it is the read side of a defence `packages/communications`
already built and named: `note.js` fences every message body and explicitly
does **not** run it through `defangLinks`, because the body is meant to be
quoted verbatim inside the fence — "Bodies are deliberately NOT put through
this — they are quoted verbatim inside a fence," in that file's own words.
A sender's `[[.audit/anything]]` or a phishing `[click here](https://…)`
therefore survives in the rendered note exactly as written, and the fence
(plus the note's own preamble, addressed to any AI assistant reading it) is
what keeps every *other* reader from treating it as structure. A console
that turned that same bracket syntax back into a live, followable link would
be the one reader that undoes the fence — choosing where the owner's own
console navigates on a stranger's say-so, from the one field this product
puts the least trust in.

`tokenizeInline` enforces this structurally rather than by discipline: it has
no rule for `[`, `]`, `(` or `)` at all, so there is no code path in it that
could resolve a link even by accident. The check is
`commsMarkdownInline.test.ts`'s hostile-string cases — a wikilink and a
markdown link, tokenized and reassembled, come back byte-identical to the
input, with none of the resulting tokens carrying `bold`/`italic`/`code`.

#### `jest-environment-jsdom` has no `TextEncoder`, and this console's own import chain is what found it

`@context/communications`'s `note.js` and `anchors.js` each construct a
`TextEncoder` — one for the split planner's byte budget, one for the message
anchor hash. Real engines all have `TextEncoder` as a global; this
repository's `jest-environment-jsdom` does not, measured directly rather than
assumed (`typeof TextEncoder` under a bare `@jest-environment jsdom` file
answers `"undefined"`). That gap was invisible for the whole life of the
package, because nothing that imported it ever ran under jsdom — until
`BrowsePane` learned to import `@context/communications` transitively, at
which point **26 suites failed on a bare `ReferenceError`**, none of them
about anything this feature touches.

Two independent fixes, deliberately both kept rather than picking one:

- **`note.js`'s encoder is built lazily**, on first call to `utf8Length`
  rather than at module load. Parsing a day back — this console's own
  `parseChannelDayMessages` — never reaches it at all, so a reader that only
  imports the parser should never pay for, or crash on, a rendering concern
  it does not use. `test.mjs` asserts this at the source level, against every
  file in the package, so the same mistake in a file added later fails the
  package's own suite rather than whichever app happens to import it under
  jsdom first.
- **`apps/mobile/jest.setup.js` polyfills `TextEncoder`/`TextDecoder`** from
  `node:util` when the global is missing. This is closing a gap in the test
  double, not changing what the product runs against: every engine this app
  ships to — Safari, Chrome, the WebKit `apps/mobile/e2e/webkit` drives —
  already has both, so the fixture's own `messageAnchor` call in
  `placeholderData.ts` (needed so a contact's activity link and the message
  it names carry the *same* hash, not two numbers kept in sync by hand) is
  reaching for something every real reader of this code already has.

The lazy fix alone was not enough — `placeholderData.ts` computes a message
anchor eagerly, at fixture-build time, for reasons the fixture itself needs
— and the polyfill alone would have been enough on its own but leaves a
future rendering call inside `note.js` paying for a `TextEncoder` nothing
asked it to build. `commsImportUnderJsdom.test.ts` pins both: that the
package imports and parses under jsdom, and that the polyfill is what makes
`TextEncoder` present there at all.

#### An activity link's path has no `.md`, and the console puts it back at the one seam that needs it

`activityLink` (in `@context/communications`) writes `[[path#anchor|label]]`
with the `.md` stripped, because it is writing an Obsidian wikilink target
and a wikilink never carries the extension — the same convention every
wikilink in this product follows. `parseContactView` reads that convention
back faithfully: `ContactActivity.path` has no `.md`, and it should not,
because it is reporting what the page says. This console's own navigation is
not wikilink resolution, though — `files.select` and `noteHref` both work on
real bucket paths, and `isMarkdown`/`select`'s folder-or-file guess reads "no
`.md`" as "this must be a folder." Calling `onOpenActivity` with the raw
parsed path opened the *console's own root folder* instead of the linked
day — caught by the WebKit case rather than shipped, because
`commsInbox.test.ts`'s fixtures never exercise real navigation and nothing
about the shaping layer is wrong here. `ContactPageView` restores the suffix
with `ensureMarkdown` at the point it calls `onOpenActivity` — the one seam
between "how a link is written" and "how this console opens one" — rather
than changing what `parseContactView` reports, which stays a faithful read
of the page.

#### Connecting a mailbox is a flag; reading one that is already connected is not

`MAIL_CONNECT_ENABLED` (`features/console/communications/flags.ts`) gates the
Inbox's empty-state "Connect a mailbox" offer, off by default, on only via
`EXPO_PUBLIC_MAIL_CONNECT_ENABLED=1` at export time — the same
build-time-only shape `EXPO_PUBLIC_E2E_FIXTURE` already uses. This is
`docs/decisions/communications.md`'s *the Gmail restricted scope is Google's
decision*, read onto the one screen that would otherwise have to guess at it:
reading a mailbox needs `gmail.readonly`, and until Google's verification of
this product's use of that scope lands, the honest answer to "can I connect
one" is no — never a button that looks pressable and fails, and never a
button quietly hidden with no explanation, which is its own kind of dishonest
for a person who came looking for exactly this. The flag's docstring says so
in the same words a person reads on screen when it is off.

**The gate is on the connection, never on the rendering.** Every view this
change ships — the Inbox row, the Channel and Channel-day views, a contact's
activity links — reads whatever mailbox is already connected, by hand or on
a fixture, whether or not this flag is on. Flipping it later changes nothing
about any of those; it only changes whether the empty state's button does
something.

### The compact corner was two controls, and one of them was a silent sign-out

"the setting button should be merged with the person icon, right now all it
does is sign you out." `ConsoleRail.tsx`'s `AccountBlock` drew `compact` as a
gear and the avatar, 4pt apart, each its own 44×44 `PressRow` — and the
avatar's `onPress` was `onSignOut` directly. `useSignOutFlow.requestSignOut`
only raises `Confirm` when the device holds unsent edits; on a clean queue it
calls `signOutNow()` immediately. So the one control in that corner reachable
with **no confirmation at all** was also the one a thumb was most likely to
land on by a few points of error, next to a gear it looked just like.

The fix is not a confirmation dialog bolted onto the avatar — that is a third
answer to "what happens when I press this" competing with the two the corner
already gave conflicting cues about. It is one control: the avatar opens a
menu naming both actions, and choosing one is a second, separate press. Two
deliberate presses *is* the missing confirmation for the clean-queue case,
built out of the same mechanism the non-empty-queue case already uses
(a second gesture before anything happens), rather than a second, different
mechanism beside it. `useSignOutFlow`'s own `Confirm` dialog is untouched and
still fires for the non-empty case — this closes the gap on the other side of
that `if`, not the dialog itself.

**Drawn with `features/design/components/Menu.tsx` / `Menu.web.tsx`, not a
third menu idiom.** Those two files already are a disclosure menu component
— a title, danger rows, a Cancel row, a sheet on touch and a popover on a
pointer picked by `layout.narrowBreakpoint` — built for `Explorer.tsx`'s
right-click and long-press. They were typed to `menu.ts`'s `MenuActionId`,
the file tree's own closed action union, which made them look like "the file
menu's renderer" rather than what they actually are. Widening
`MenuActionId` itself to fit an account action was the tempting fix and the
wrong one: `Explorer.tsx`'s `runAction` switches on every member of that
union, so a case with nothing to do with files would have needed a branch
there forever, for a menu that file never draws. `MenuItem`/`MenuProps` are
generic in their own id (`Id extends string = MenuActionId`) instead —
default-typed so every existing file-menu call site is unchanged, and open to
a caller with its own two-item union. `MenuItem.testID` is the one other
addition, because `account-settings` / `account-sign-out` predate this menu
and are cited by name rather than by the `menu-item-<id>` convention every
other row uses; `MenuProps.titleDetail` is the other, because the sheet's
title had nowhere to put an email under a name until this needed one.

**The harm the two-control layout caused, restated for the record, because
it is also why `accountSettingsControl.test.ts`'s central claim did not
reverse.** That file used to assert "signing out and opening settings are
different intentions and must not share a control" — true, and it is still
true of the *compact* form now that both live behind one press. What made the
old layout dangerous was never that two things were reachable near each
other; it was that a coloured disc's only disambiguation from its neighbour
was an `aria-label` nobody speaking to a screen reads before landing a thumb
on it — one control, two possible unannounced outcomes depending on four
points of horizontal error. A menu with two rows that say "Settings…" and
"Sign out" in words is strictly *more* explicit than that pair of circles
ever was, which is why sharing a trigger is the fix rather than the
regression the old sentence would suggest on a literal reading.

**The full (non-`compact`) rail foot is untouched.** `rail-settings` and
`rail-sign-out` stay exactly as they were — two 28pt targets beside a name,
which is a rail foot with room, not a 44×44 corner with none. Merging them
too would be solving a problem that surface does not have.

#### The popover this menu draws had to learn to portal, on its first real caller

`Menu.web.tsx` existed before the account menu — `Explorer.tsx`'s right-click
and long-press were already drawing its `Sheet`/`Popover` pair, mounted the
same way: as a child of the tree's own root `View`, which is itself an earlier
sibling of the editor region in `AppFrame.tsx`'s `styles.body`. Nothing here
rules out the same defect already being live there — a menu anchored near the
right edge of a narrow explorer column has the same `MIN_WIDTH: 200` to spill
past the boundary with — it is simply not the call site that happened to get
measured against overlapping content first. `AccountMenuTrigger` is the one
that did: it sits at the foot of the rail, itself an earlier sibling of the
same editor region, and its popover has to spill out past the rail's own
(narrower still) width to show ~200pt of menu — straight into the editor
region's screen space, where this branch's own "Make private" / "Share…" pair
happened to be sitting.

That is exactly **Every react-native-web `View` is a stacking context** (above)
with a new subject. `Popover`'s box carried `position: fixed` and `zIndex:
1000` from the start, and both are true and irrelevant: they order this popover
among the *descendants* of whichever `View` it renders inside, because that
`View` carries RNW's base `position: relative; z-index: 0` like every other
one, and the editor region is a later sibling competing at the *parent's*
level, not this one's. `Sheet`, the touch presentation right above this in the
same file, never had the problem — it is a `Modal`, and `react-native-web`'s
`Modal` already portals to `document.body` for this exact reason, which is why
`SettingsOverlay` and every touch case in `settings.spec.ts` were never at
risk. `Popover` was the one presentation in this file that skipped `Modal`
and grew its own `position: fixed` box instead, so it was the one presentation
that still owed itself a portal.

Found by `settings.spec.ts`'s pointer-width case, not by anything in
`__tests__/`: jsdom lays nothing out, so no unit suite can see one region paint
over another, and `menuRender.test.ts`'s own popover queries already read from
`document.body` rather than the mount `container` — which happened to make
that file agnostic to whether the popover was portaled, so it stayed green on
both sides of this fix and proved nothing about it either way. Only a real
engine, hit-testing a real click at a real coordinate, produced a Chromium
timeout naming the actual culprit: "`<div>Make private</div>` … subtree
intercepts pointer events." `Popover` now renders through `createPortal(...,
document.body)`, the same escape `ModalPortal` already uses, so it stacks at
the true top level rather than within whichever `View` happens to be its
parent. `Sheet` is untouched — it already had this for free.

What a "simplification" of this costs: reverting to an inline `Popover` puts
this exact defect back — for the account menu, demonstrably, and possibly for
`Explorer.tsx`'s own context menu too, which nothing here has gone back to
verify one way or the other. The portal is a property of the component rather
than a fact about any one caller, which is the point of fixing it here instead
of working around it at the account menu's own call site.

### The breadcrumb head stopped being a switcher pill when it moved rows

"the button for @seyi is too big." Measured at 390×844: the head mark was
68.1×34 — 43% of that width chrome (8+8 padding, 6 gap, 7 dot) — carrying a
13px label beside an 11px leaf it sits on the same line as. It was also,
literally, the identical object **A context pill's target is not its mark**
(above) argues for: same `layout.stripPill` 34, same `radii.md`, same
`shadows.floating`, same `wsSwitch` 13px label. That section is not reversed
by this one — read again, it is an argument about the **switcher** pill,
made when the switcher and the breadcrumb's head were the same object worn
in two places, and it is still correct about that pill today. `stripPill`
keeps its height and its shadow untouched; `contextStrip.test.ts`'s two
positive controls for both stay green.

What changed is that the two stopped being the same object the moment
**The contexts moved into the scroller** (above) put them on two different
rows meaning two different things: row one is a list of places to switch
*to*, so each pill needs the full switcher target and a shadow to read as a
floating control while somebody scrolls past whatever is under it. Row two's
head is not a list — it is naming the one context you are already standing
in, beside the path to the note you are reading — and a control drawn
identically to the list above it reads as "this is also a place to switch
to", in the wrong colour. Two facts ("go there" and "you are here") drawn as
the same shape in two colours is weaker than the same shape used once and a
colour carrying the second fact alone.

So `Pill` gained a `head` variant rather than the breadcrumb growing a second
pill implementation — that file's own rule is that a second implementation
is how the strip and the breadcrumb come to disagree about what a context
looks like, and it was right the first time this was built. `head` differs
from the switcher mark in exactly the four ways that made it read as a
second switcher: `layout.crumbPill` (26) rather than `stripPill` (34), no
`boxShadow`, `radii.xs` rather than `radii.md`, and an 11px mono label
matching the leaf's own size and weight rather than `wsSwitch`'s 13px body
face — so colour (`accentDim`/`accentText`, unchanged) is what says "this is
the context", and the row reads as one line rather than two chrome weights
stacked on each other. The dot goes too: `toneForKind` exists to tell
contexts apart *in a list*, and a list of the one context you are standing
in has nothing left to tell apart.

**Dropping the shadow is itself a small instance of the same lesson**, worth
naming on its own: `pill`'s own docblock justified `shadows.floating` with
"the top row has no surface of its own… so anything on it that is not drawn
as an object has nothing behind it," which was true while this row floated in
`AppFrame`'s `topBarCompact`. **The contexts moved into the scroller** made
that premise stop being true for both rows — they now sit above the pane's
own surface — and the switcher pill keeps the shadow anyway, because it is
still read at a glance while scrolling past whatever is under it, which is
exactly the case a floating mark is for. The head has no such case: it does
not move independently of the text beside it, so the premise that used to
justify the shadow everywhere on this row now justifies it for only one of
the two pills on it.

**The target does not move, and this is not a second exception to
`minTouchTarget`.** `styles.target` stays `layout.minTouchTarget` on both
axes for `head` exactly as for the switcher — the mark shrank, the pressable
around it did not, which is `accountAvatar`'s rule applied to a case that
already had it half right (a smaller mark, a target that was already at the
floor because `styles.target` never depended on the mark's own size). A
two-character slug's head is still held at 44 by `minWidth`.

**The visible payoff is a few more characters of the note's own title.**
`Breadcrumb.tsx`'s `phoneRowBudget` estimates the pill's footprint to decide
how many characters the leaf may keep before it elides, and it was still
budgeting for the switcher pill's chrome and label size after this fix —
`pillChromePx` at `space.x2*2 + 6 + 8` (the padding, the gap, the dot) and
`pillLabelPx` at a 13px body glyph. Left uncorrected the leaf would still
truncate at the old, wider pill's width even though the real one had
shrunk — safe (the bias is to overestimate the room the pill takes, so the
error only ever costs a folder segment, never the leaf), but it would leave
on the table exactly the room this fix bought. `pillChromePx` is `6 * 2` now
(`layout.crumbPill`'s own padding, no dot, no gap for one) and `pillLabelPx`
is `contextLabel.length * 7.0` (11px mono, the leaf's own face).
`breadcrumbPath.test.ts`'s "a narrower head yields more leaf characters for
the same path" pins the direction of that difference against the real
`phoneRowBudget`, not a re-derived copy of it.

What a simplification of any of this costs: restoring the switcher's
`stripPill`/`shadows.floating`/`wsSwitch` sizing to the head puts the 68.1pt
mark back over an 11px leaf; dropping the dot's removal or the label's size
match puts the two-signals-for-one-fact problem back in a smaller box;
reverting `phoneRowBudget`'s constants leaves the leaf truncating at the old
pill's width forever, silently. `navBand.test.ts`'s "the head of the path is
quieter than the switcher above it" and `breadcrumbPath.test.ts`'s new case
each fail on their own piece of this and nothing else, and `contextStrip.
test.ts:518` — the strip pill's own 34pt — is the positive control that
proves the switcher itself was never touched.

### A diagram lives in the note, and the browser is the only thing that makes it safe

A fenced block tagged `html-preview` is drawn as the thing it describes, inside
an iframe whose `sandbox` attribute is empty. **The fence tag is the entire
convention** — no new file format, no frontmatter switch, no per-note setting,
nothing in `privacy.md`. `cat`, `git diff`, GitHub and Obsidian all still show a
labelled code block, which is non-negotiable #3 ("plain files stay canonical")
applied to something richer than a paragraph: the diagram is *in* the file,
portable and diffable, and the console merely draws it. The opposite of a
proprietary canvas format.

**The security model is one attribute, and it is not ours.** Anyone can email
`<name>@context.lc` — that is the ingestion design, not a gap in it — so a note
the console renders may have been written by a stranger, and the console holds a
live authenticated Convex connection. The threat was never HTML or CSS; it is
script execution inside that session. A bare `sandbox` denies everything the
frame could do, script execution included. `allow-scripts` is never added (it
runs the note's JavaScript, in an opaque origin that still reaches `fetch` and
`postMessage` to the parent); `allow-same-origin` is never added; the two
together are worse than either, because a frame that is both can reach
`parent.document` and take its own `sandbox` off.

**No sanitizer, deliberately.** Filtering tags and attributes ourselves is a
list to maintain against everyone who has ever got past one, and it buys nothing
the browser is not already enforcing for free, with no bypass surface of our
making. A second mechanism nobody tests is not defence in depth. `previewDocument`
therefore puts the fence's markup into the frame's document **verbatim**, and
`htmlPreviewFrame.test.ts` asserts that it does, so a well-meaning filter cannot
be added later without deleting a test that says why it must not be.

**The CSP is on the frame for a different reason than script.**
`default-src 'none'; style-src 'unsafe-inline'; img-src data:` is there because
`background:url(https://…)` needs no JavaScript at all: a fetch out of a note
somebody emailed you is a read receipt telling the sender the moment you opened
it, and which note. That is a real privacy leak with no script anywhere in it.
There is no `font-src`, because a webfont is a fetch like any other. Blocking
inline script is a side effect of `default-src 'none'`, not its purpose.

Two things the earlier draft of this design asked for are **deliberately not
built**, and this is the reversal rather than an omission: a **separate origin**
for the frame, and **owner-only rendering** (a note that arrived by ingestion
never drawing). Both were priced against a frame that runs script. A frame that
cannot run script has nothing to do with the console's origin — there is no code
in it to be same-origin *with* — and "only render what the owner wrote" would
have meant a provenance flag on every note, a rule in `privacy.md` that
non-negotiable #5 does not have room for, and a diagram that silently refuses to
draw with no way for the reader to tell why. Both come back the day scripts are
allowed, which is a different project.

**The reveal rule applies, and it needed `pointer-events: none` to.**
`livePreview.ts`'s central argument is that you cannot edit syntax you cannot
see, so a drawn diagram becomes its own fence again the instant the caret enters
it, exactly as `## Heading` does. The frame is a separate document and swallows
its own clicks, so without `pointer-events: none` on it there would be no
pointer route back to the source at all — you could look at the diagram and
never reach the markup that draws it, which is the "block editor with extra
steps" failure that file exists to avoid. The preview has nothing to interact
with anyway: no scripts, and a link in a bare-sandbox frame cannot navigate.

**The frame's height is a number, and that is an honest gap.** Sizing an iframe
to its content means script inside it reporting a height out, and script inside
it is the one thing this never allows; the frame is cross-origin by
construction, so the host cannot measure it either. So the box errs tall —
`620px`, capped at `80vh` — because a diagram drawn short leaves empty space and
a diagram drawn tall loses its bottom third, and only the second is a failure a
reader notices. `overflow: hidden` on the wrapper is not tidying: markup from a
stranger that escapes its box draws over the breadcrumb, the save state, a
privacy control.

**What the sabotage run actually showed**, recorded because it is not what was
expected. Each guard was broken in turn against a real engine:
`sandbox="allow-scripts"` with the CSP intact left "a script does not run"
**green** — the CSP refused the inline script on its own; the CSP opened with
`script-src 'unsafe-inline'` and `sandbox` left bare was **also green** — the
sandbox refused it on its own, which is the claim this feature rests on and is
now measured rather than assumed; **both broken together went red**, so that
case is not vacuous. The reading is that each guard has a case that fails when
*it* is removed — the attribute is asserted directly in
`htmlPreviewFrame.test.ts` and in `e2e/webkit/htmlPreview.spec.ts`, the CSP
directly beside it — rather than one case that stays green as long as either
survives.

What a simplification of any of this costs: adding `allow-scripts` puts a
stranger's JavaScript in a session holding a live Convex connection, and
`htmlPreviewFrame.test.ts`'s "carries a bare sandbox" plus the WebKit suite's
"the frame's sandbox is bare in the shipped page" both go red on it; dropping
the CSP restores the read receipt and takes "forbids every fetch a stylesheet
could make" with it; rendering every `html` fence rather than only the tagged
one makes every note that *quotes* markup start drawing it, and "a fence tagged
`html` is not a preview" fails; dropping the reveal check makes the fence
uneditable and "the caret entering the block gives the raw fence back" fails;
dropping `overflow: hidden` or `pointer-events: none` fails "the preview stays
inside the note's own column" and "tapping the diagram gives the raw fence back"
respectively — both measured in a browser, because **two layout defects shipped
past a fully green jsdom suite in the Premium work** and this is the same class.

**jsdom cannot test the part that matters, and saying so is the point.** jsdom
does not enforce iframe sandboxing at all and does not load `srcdoc`, so a jsdom
test asserting "the note's `<script>` did not run" would pass with
`allow-scripts` set. That is the exact false green
[`testing.md`](./testing.md) exists to name. The execution case lives in
`apps/mobile/e2e/webkit/htmlPreview.spec.ts` against a real engine; the jsdom
suite asserts only what it can actually see, which is the markup that was built.

### A phone gets Recent, because it could never get a second tab

The console's bottom toolbar carried a **tab count** — Obsidian's, Safari's and
Chrome's number in a rounded square — and a press raised an **Open notes**
sheet. Both were built carefully. Both were unreachable, and the owner's report
is the whole of the evidence: *"It's like there's only ever one open note. I've
tried so many times to get more open notes, and there's just not a way to do
it… how do you even close a note on mobile here?"*

He was right on both counts, and neither was a polish problem.

**Nothing on a phone could open a second tab.** The only verb that produces one
is `openInNewTab`, and it was gated twice over: `menu.ts` offered it to
`platform === "web"` only, and its sole host — the Explorer's row menu — is not
drawn at compact at all, where `frame.ts` answers `explorer: "hidden"`. Every
phone open therefore arrived through `useTabs` as a `preview`, and `tabs.ts`'s
`open()` makes a new preview *replace* the preview slot. One in, one out. The
count could only ever read `1`, which falsifies the control's own stated
affordance — "the number is the affordance, it is the only thing on the toolbar
that changes as you work". The single path to a second row was an accident:
`edited` pins a tab, so "Open notes" on a phone meant *notes you happened to
type into this session*.

**And the comment defending the gate had the causation backwards.** It read:
"touch has a tab switcher rather than a pointer with a middle button, so the
second item is web-and-file only." A switcher *displays* a set of tabs; it does
not produce one. The line withholding the only verb that produces one cited, as
its justification, the surface it was thereby leaving empty.

**Closing did nothing, and that was structural rather than a missing call.**
`without` leaves `activePath` null when the last tab goes, and `useTabs`' effect
only follows a non-null one — so the × emptied the strip and left the note in
the editor. The chrome updated and the thing it claimed to close was still on
screen; `‹` then brought it back, because history is a separate stack. This is
not a forgotten line. On a phone the note **is** the page, so closing it is a
navigation, and `tabs.ts` is deliberately built knowing nothing about
navigation. Two models of "which notes am I working with" on a 390pt screen, one
of which owned display without owning navigation.

**So the phone keeps the model it already had, and that model gets a list.**
`history.ts` was already there, already pure, already what `‹` and `›` read.
`recentPaths` is the same array walked backwards — deduplicated, capped at
`MAX_RECENT`, folders included, because history records the *selection* and
"back to the folder I was in" is a destination a phone reaches constantly.
`RecentSheet` draws it, marks where you are, and has no × on any row, because
there is nothing to close.

The decisive property is not parity with Obsidian: **a tab list on a phone is
empty exactly when you need it**, since you have to have curated it first, and a
recents list is never empty because using the app fills it.

Two placements follow from rules already written here rather than from taste.
The key is **dimmed in place, never absent** — `‹` and `›` live by that rule two
positions up, and the tab count's own defence for being conditional ("it is the
last item on the bar") was false: Save, a rule and the meeting key all sat after
it, so every one of them slid sideways the first time a note opened. And `‹`
**held** opens the same sheet, which is where every browser on every platform
keeps its history list; the hold is in the accessible name, because a gesture a
screen reader is never told about is one only sighted people have.

**What went with it.** `TabSwitcher.tsx`, `TabCountButton`, `tabCountLabel`, and
`BottomBarAction`'s `count` and `badge` — the number-in-a-square and the
corner badge both existed for that one key and had no other caller. `marker`
stays: Save still has something momentary to say. The unsaved dot is not
reproduced on Recent, and that is deliberate — the console autosaves at 2s idle
and a 15s ceiling, so "unsaved" resolves itself while you read it; what does not
resolve is `needsDecision` (a conflict, a failed save), which speaks in the
notice line. Desktop tabs are untouched, and `menu.ts`'s gate now says what it
always meant: a phone has no tab surface, so it is offered no tab verb.

**One latent bug fell out of the close fix.** `useTabs` opened a tab for any
non-null `editor.path`, and `""` — the bucket root, a folder — is not null. In
production `emptyEditor` uses `null` and nothing writes `""`, so the phantom
nameless row was invisible: the prune deleted it a commit later. With the
last-tab rule in place that flicker becomes a **deselect nobody asked for**, so
the `opened` effect now refuses `""` at the source.

What a simplification of any of this costs, and the test that fails:

- Deriving Recent from a second, non-truncating log beside `entries` buys back
  the rows a branch drops and re-creates the two-models problem this removed.
  The cost is stated in `recentPaths`' own comment and pinned by "a branch drops
  the forward tail here too, because it is one array".
- Asking `recentPaths(state).length > 0` instead of `hasSomewhereToGo` lights
  the key on the first note of every session, offering to take somebody where
  they already stand — "one entry, and it is where you already are, is nowhere
  to go" fails.
- Reverting the last-tab deselect returns the control that does nothing:
  "closing the last one deselects; closing one of two does not" fails. Writing
  it as `length === 0` rather than as a transition throws away a cold load's
  `?note=` — three tests fail, "a cold load with a note open does not deselect
  it" first.
- Dropping the `""` guard brings the phantom root tab back, and with it a
  deselect on landing: "the bucket root is not a note, so it opens no tab to
  close" fails.
- Dropping `hint` from the held gesture's accessible name, or the 400ms
  `delayLongPress`, fails "the hold is in the accessible name, not only in the
  handler" and "holding fires the second verb and not the first".

**The sabotage run.** Nine invariants broken one at a time against the real
suite; every one went red, and each in the test that names it — the two
`recentPaths` rules, `hasSomewhereToGo`, the last-tab deselect in both its
wrong shapes, the `""` guard, both halves of the hold, and the sheet's marking
of the current row. The one worth recording is #5: writing the deselect as
`if (!has)` rather than as a transition failed **four** tests rather than one,
which is the shape of a guard whose absence is load-bearing in more than the
case it was written for.

### The share sheet is one control, and the padlock beside it is gone

The owner, looking at the sheet on a phone: *"the lock and the share icon can
be collapsed, they're essentially the same thing… it's confusing how to make
groups, it's confusing how to revoke access… when I type names there's not even
an autocomplete."* Four complaints, one root cause, and one of them turned out
to be a safety bug rather than an annoyance.

**They were not merely similar — they overlapped on the dangerous state.** The
padlock cycled `private → team → anyone-with-a-link`, and that third position
minted exactly the share row (`audience: "anyone"`) the sheet's own "Create
link" button minted. One object, two mints, and nothing on screen relating
them. Because most notes are `team` already by folder inheritance, an ordinary
note sat **one tap on an unlabelled 20pt icon** away from a link needing no
account, with a glyph changing to a globe as the only feedback.

`scope.ts` had argued that widening should be one deliberate step at a time and
that `private → anyone` in a single press is "the accident worth making
impossible". That is right about the rule and wrong about where the risk sits:
`team → anyone` was also a single press, from the state nearly everything is
in. The fix is not a fourth position or a longer cycle — it is that a decision
this size does not belong on an unlabelled icon at all.

So: one icon in the bar, and audience becomes named positions inside the sheet,
with the public step confirmed in words. **`scope.ts` is untouched** —
`scopeOf`, `nextScope` and `stepsTo` remain the pure model, and `setScope`
remains the single point every surface goes through, group guard included.
Only the control driving it changed.

**A simplification of this would put the padlock back** for the keystroke it
saves. What it would cost is the property the confirmation exists for: that
nothing publishes a note without a sentence saying what publishing means. The
test that fails is *going public asks first, and mints nothing until it is
answered* in `noteChrome.test.ts`, which asserts on the absence of a `setScope`
call, not on what the screen then shows.

#### Revoking one person's access has two routes, and they differ by a context

The sheet listed people with access as three strings — name, role, reason —
with no control on any of them. It diagnosed ("the folder it is in is shared
with the workspace") and left the cure three screens away in Settings.

The reason it had no Remove button is real and worth stating, because it is the
first thing a reasonable person would add: **`team` means every member, so one
person cannot be peeled off a team-visible note.** There is no per-note role and
no per-person exception — `privacy.md` is folder defaults plus exact-note
overrides, and an override is still one of the two tiers or a group. "Stop Kola
reading this" therefore has exactly two honest answers:

- **Narrow the note** to `private` with an exact-note rule. Per-note,
  reversible, and what most people mean.
- **Remove Kola from the context** with `removeMember`, closing every note and
  folder at once.

A single Remove beside one name would have to silently pick one. The small one
does not do what the button says; the big one closes an entire context from a
control labelled with one note's name. So the row carries **routes**, each
stating how far it reaches, ordered narrowest first, the wide one drawn
destructive. A group row gets the one route the console can honestly offer —
where the group is defined — because it cannot resolve group membership and
`access.ts` opens by refusing to guess.

**A simplification would collapse the routes into "Remove".** The test that
fails is *each route says how far it reaches* in `noteAccess.test.ts`.

#### A group is made where the group was needed

`GroupsPanel`'s own header says "Nobody should have to come here first" — and
it was the only door. Sharing one note with three people meant leaving the
note, opening Settings, typing a label, adding three members one at a time,
coming back, and typing the group's name. Eight steps for the thing groups
exist to make cheap, which is why nobody made one. The sheet offers it now; the
panel keeps what its header says it is for — renaming one, and dropping
somebody from every folder at once.

`GroupActions.createWith` exists because `createGroup` always returned the new
group's id and the console threw it away, so populating a group you had just
made meant re-reading a subscription that had not necessarily delivered.
Deliberately not atomic: a partial failure leaves a real group with some of the
people in it, which the panel shows and can finish — better than rolling back a
group a folder may already point at.

#### The autocomplete was shipped and unreachable

`ShareDialog` handed `recipientsFor` an exclusion set containing **every member
of the context**, so a matching colleague was filtered out of their own
suggestion list. On a team note that is everybody, and since the invite row
needs a *complete* address, typing a partial name produced an empty box. The
type-ahead had shipped in #425 and had never been visible for the common case.

Two separable mistakes. **What the set measured**: members of the *workspace*,
where what matters is who reaches *this note* — opposites on a private note, so
the field was blankest exactly where it had most to offer. It derives from
`accessRows` now, so one function decides who reaches a note and both the list
and the suggestions read it. **And hiding was the wrong answer anyway**: "no
rows" cannot distinguish "they already have it" from "no such person" from
"this field is broken", and those want different next moves. Somebody who
already reaches the note is shown, marked, sorted below the offers, and drawn
without a press behind it.

**A simplification would restore the exclusion** on the grounds that offering
somebody who already has access is offering to do nothing — true of the
*press*, false of the *row*. The test that fails is *a note everybody reaches
still answers the query* in `shareRecipients.test.ts`.

Shots of every state: `docs/design/share-sheet/`.

### Storage starts with ownership, then offers existing notes

The first storage decision has two peer paths: **Bring your own storage** and
**Context-managed Premium storage**. The first opens the S3-compatible and
Dropbox provider choices. The second names the 50 GB allowance and continues to
the existing Premium confirmation. Neither path is marked safer or recommended;
the choice is technical control versus convenience.

After either path connects, first-run asks **“Have an Obsidian vault or existing
Markdown notes?”** The same question appears in Storage settings for an existing
workspace. On Mac and web, the person chooses the folder and Context streams its
files directly into the connected storage at the same relative paths. Markdown,
folders and attachments therefore keep working together; a successful first-run
import replaces the layout question rather than putting PARA beside a structure
the person already has.

An import into storage that already has data starts with an explicit choice.
**Merge without replacing** keeps the vault's paths and skips every collision.
**Keep it in its own folder** puts the selected vault under
`Imports/<vault name>/`. Those two choices cannot replace an existing object.
The third choice, **Replace everything**, is deliberately destructive: it
removes every object in the bucket before uploading the selected folder.

Replacement has two gates. The screen names notes, attachments, access
settings, audit files and Context plumbing explicitly, says Context cannot undo
the operation, notes that provider-side object versioning may retain older
versions, and requires the owner to type the exact phrase `I understand` before
the folder picker appears. The server requires that same phrase when it creates
the job. A client that hides or bypasses the warning therefore still cannot
mint a replacement job.

The import is bounded, batched and create-only. Convex stores the total counts,
completed batch numbers, and a fingerprint of the local manifest. It never
stores file bytes or note bodies. The person must keep the tab open while bytes
upload because the source vault remains on their device. If the tab closes or a
request fails, they return, select the same vault, and resume after the last
completed batch. Stable path ordering keeps batch numbers consistent when the
browser enumerates the folder in a different order on the second selection.

Replacement adds a durable counting-and-deletion prefix to that same job. It
first counts every object, including dot-prefixed plumbing, then repeatedly
deletes the first bounded page. It never persists a continuation cursor while
mutating the listing, because several S3-compatible stores can skip keys when a
cursor outlives the page it described. Convex records only total and deleted
counts. If deletion succeeds and progress recording does not, retrying the
shrinking first page is safe; the final empty page reconciles the count. Upload
bytes are refused until the job says deletion is complete.

The last replacement batch idempotently creates a new all-private `privacy.md`
before the job may become complete. This happens server-side rather than in a
client follow-up, so closing the tab between the last object write and the
privacy repair cannot strand the replacement without an access map. The person
still has to keep the tab open while local bytes are crossing; after a failure
they reselect the same vault and resume the stored deletion or upload phase.

The client shows the completed file count and percentage. Server audit records
contain paths and counts only. After a fresh onboarding import, the existing
all-private repair path creates a valid `privacy.md` from the uploaded top-level
folders. A merge or folder Settings import never rewrites an established
workspace's access map. Replacement deletes that map with everything else and
creates a new private one from the replacement vault's folders.

Obsidian application state and Context plumbing do not come along:
`.obsidian/`, `.trash/`, `.git/`, `.context/`, `.audit/`, system metadata and a
source `privacy.md` are excluded client-side and refused again server-side.
This avoids uploading plugin credentials or replacing Context's access map.
Folder picking is Mac/web-only because native mobile pickers do not preserve a
vault's relative paths; mobile says where to continue instead of flattening the
vault.

The browser picker waits for the file input's own `change` or `cancel` event.
It must not infer cancellation from the window regaining focus: Chrome restores
focus before it has finished enumerating a directory, so a focus timer can win
the race and discard a valid selection. The regression test deliberately sends
focus first and the selected files later. The import screen also reflects that
intermediate state as “Reading the selected folder…” instead of leaving the
button unchanged.

The Settings flow is one staged card rather than a stack of policy boxes. It
keeps the merge choice visible, shows a folder-reading state, then names the
file count, size, destination, and one `Upload N files` action. The keep-tab-open
warning appears when there is actually a local selection to protect and remains
beside live progress; it is not the first thing somebody sees before choosing a
folder.

**"Create-only" is a claim about the bucket, not about the request, so the
capability decides which way it is enforced.** Every adapter here *sends*
`onlyIf: { absent: true }`; whether the bucket obeys is the question
`initialCapabilities()` answers `false` to until a probe says otherwise, because
"B2 and arbitrary S3-compatible endpoints do not reliably" support conditional
writes. Sending the precondition and trusting the reply on a binding that has
not proven it is how a write that should have been skipped comes back reported
as *created*, with the person's own file gone underneath — the "lost write with
no error" that comment calls the one failure mode a notes product cannot have,
arriving during onboarding over the vault they are importing. So
`importVaultFiles` reads `store.capabilities` exactly as `saveNote` and the
manifest writers do, and an unproven backend gets a read-then-create whose
residual window is one round trip. The check is `does not lose an existing file
on a backend whose conditional writes were never proven`, and it needs
`memoryS3`'s `ignoreIfMatch` to also ignore `If-None-Match` — the same feature,
so a stub that honoured one and not the other was answering for a backend that
could not be the one in doubt, and the create-only claim was only ever tested
where it holds for free.

### A connected account is one card, and its consequence is armed

The Google connections card was the ugliest surface in settings, and none of it
was accidental — each layer was reasonable on its own day.

**It was four boxes deep.** A `Card` held a `Row` per account, which held a
bordered block per service, which held the destination field; with the sync
schedule, four nested bordered surfaces before the one control. Three services
on two accounts is twelve nested boxes on a screen somebody opened to change
one path.

**Its right-hand column was permanently red.** `connectionActions` carried a
`danger` button and the standing sentence "Removes the whole account — Calendar
and Chat stop too", drawn once per account and never not on screen. So on a
two-account panel the most visually dominant thing was destructive text nobody
had asked to read — and the control armed anyway, meaning the warning was
displayed at all times *and* repeated between the presses.

**It said its own scope four times.** A title ("Google accounts"), a sub ("Each
Google account whose calendar this context reads"), a pill ("2 connected"), and
then every account row repeating "Email, Calendar, Chat connected". A reader on
the Calendar panel was told about Email and Chat four times.

Now: one card per account, the destination as a row that opens on Change, and
the consequence of Disconnect said **between the two presses** — which is where
every other irreversible control in this console says it (`useArming`, the same
shape as storage's Disconnect and a share's Revoke). The service list survives
as the single quiet line above that control, because a narrowed panel genuinely
has to say it: `GoogleActions` has no per-service call, so a reader who arrived
from the Calendar heading would otherwise have no way to know their mail stops
too.

Three smaller things went with it. The path is `mono`, which it always should
have been — a proportional face is what let a value scroll out of a field
narrower than itself without anybody noticing. The current sync interval was
`variant="white"` — the landing page's hero CTA — *and* disabled, so the
loudest element on the card was a fact nobody could act on; it is marked the way
`AppearancePanel` marks its current choice instead. And a reader with no
`saveDestination` is now offered no way *into* the editor rather than a disabled
Save button, which is this console's own absent-not-disabled rule finally
applied here.

**What a "simplification" would cost**: putting the destination back in an
always-open field returns three forms per account to a screen where nobody
edits three paths at once. Moving the consequence back beside the button makes
destructive copy permanent furniture again and leaves the arming saying nothing
new.

**The tests that fail if this is reversed**: `what Disconnect takes with it is
said between the presses, not beside the button` and the `the destination
editor` block in `apps/mobile/__tests__/googleConnectionsCard.test.ts`, plus
`a narrowed card offers no way into the editor without a saver` in
`apps/mobile/__tests__/communicationsPanels.test.ts`.

### Reading mode is the whole rule for a block that replaces its own source

Three things in a note are drawn as something other than the characters that
mean them: a `form` fence becomes a form, a GFM table becomes a grid, and an
`html-preview` fence becomes a diagram. All three are gated on **`state.readOnly`
and nothing else** — reading mode, `privacy.md`, a viewer below editor, an
encrypted envelope — rather than on a flag of their own.

That is not tidiness, it is the file's central rule arriving at its limit.
Everywhere else Live Preview serves "you cannot edit syntax you cannot see" by
**revealing markup when the caret enters it**: `## Heading` is a heading until
you click the line. A block widget cannot do that, and the two that came first
show why from opposite directions. Filling in a form field *is* putting a caret
somewhere, so a form that revealed on selection would turn back into a code
fence the instant anybody tried to use it. A table's cell is the thing the grid
replaced, so a grid that gave way on selection would flicker between two layouts
as somebody arrowed along a row.

A reader has no caret to reveal anything with, so the competition disappears:
**editing shows you the source, reading shows you the thing.** The source is one
press of the eye away, which is also the only place it can be fixed — which is
why a `form` block that will not parse draws a card naming the line rather than
a half-built form, and why a table the reader refuses falls back to the mono
face rather than to nothing.

The cost, stated: find-in-note searches the document, so a match inside a
replaced range is not visible while reading. The grid also cannot carry
`noteLinks`' click target, because that extension resolves a path against the
open note through a ref that does not reach a widget — so a `[[wiki]]` link in a
cell is drawn as its words in the link colour and is **not followable** until
you leave reading mode. Both are real, both are the price of the block widget,
and neither is worth a second reveal rule.

**What would reverse this** is making a grid editable in place, and that is a
different product: it needs a serializer from the drawn cells back to pipes,
which is exactly the round trip `livePreview.ts` exists to avoid — "the buffer
**is** the Markdown", and nothing here parses the document into another model
and writes it back.

### The `--lp-*` palette is a contract between two hosts, and a missing one fails silently

Every rule drawn inside the note editor names its colours as `--lp-*` custom
properties rather than as values, because the identical stylesheet runs in two
places: the browser, where `LiveEditor.web.tsx` sets them from `useColors()`,
and the iOS `WebView`, where they arrive over the bridge from `themeVars`. A
colour imported from the design tokens at the top of a shared module would be
the *build's* palette rather than the viewer's.

**The failure mode is why this is a decision and not a convention.** An unknown
custom property does not fall back and does not error: it makes its whole
declaration invalid at computed-value time, so `color: var(--lp-missing)`
resolves to `inherit` and the text silently takes whatever colour the app around
the editor happens to be using. That shipped. The web half declared six of the
set, `--lp-content` was not among them, and CodeMirror's own base theme
(`li[aria-selected] { background: #17c; color: white }`) won the completion list
— white ink on the light ground — while every form label, every input, the
status line and the link tooltip lost their colour by the same mechanism. All of
it was correct on iOS the whole time, which is exactly why looking at the app
never found it.

So the guard is a **relationship rather than a list**: `liveEditorMount.test.ts`
mounts the editor, reads every stylesheet actually in the document, and requires
every `--lp-*` any of them reads to be one the base `.cm-lp-root` rule declares.
Reading the live document rather than importing the themes is what makes a theme
the test forgot to import impossible to miss — the completion list's theme lives
in `linkComplete.ts`, a different file from the one that declares the palette,
and that distance is the whole reason the two drifted. Restricting to the base
block is what stops a property declared only inside the compact media query from
passing while being undefined at every width above the breakpoint, which is the
desktop console, which is where it was reported.

**A hairline is a token, not a fill.** There was no `--lp-line` for a long time,
so anything that wanted an edge borrowed `--lp-code-bg` — the code fence's
*background*, which is `#F5F5F5` on a `#FFFFFF` ground. Every such border was
invisible in light mode, and two separate pieces of work reached that conclusion
independently within a day. `--lp-line`, `--lp-line-strong` and
`--lp-focus-ring` come from the palette's own `line`, `lineStrong` and
`accentDim`; the guard above is what keeps both hosts declaring them.

### One save status, and a control only where pressing it does something

Measured in a real browser against `/e2e-fixture`, at 1440×900: the foot of a
resting note carried the sentence **"Saved in your bucket"** at x=16 and a grey
pill reading **"Saved"** at x=1344 — same row, same moment, same claim, two
visual languages, opposite ends of the window. The same note at 390×844 carried
the sentence alone. So the console said one thing twice, and only on the screen
with the most room to say it once.

The sentence is the half that stays. `NoteEditor`'s own header calls it the
strongest promise in the product, and it is the only half that can tell the
truth about the two states that reach it falsely — a queued draft is on this
device and not in the bucket, a cached body came off this device — which a
one-word pill has no room to do.

The pill is not deleted, because in two states it is not status at all:
`saveButton` is pressable exactly where autosave refuses, a failed save and a
conflict, and the manual route has to stay reachable there. So the rule is the
one that keeps that reason and drops the duplication: **the save control is
drawn when pressing it does something, and not otherwise.** `NoteEditor`'s
status row reads `button.disabled` as *whether to draw this*, not as *how it
should look*.

Every arm it removes is an arm whose sentence already said the same thing, in
words that say it better: `Saved` under "Saved in your bucket", `Saving…` under
"Saving…", `Queued` under a queued draft's own message, and `Read-only` and
`Encrypted` under the notice at the head of the note rather than one word at the
foot of it. `saveButton` still computes all of them and `autosave.test.ts` still
checks all of them — what changed is which reach the screen.

What it costs: a person on a pointer layout no longer has a permanent target at
the foot of the note to aim at, so "where is Save" is answered by the state
rather than by muscle memory. That is the trade, and the states where somebody
actually needs it are exactly the states that still draw it.

The guard is `offlineEditorRender.test.ts`'s "the save status at a pointer
width", which mounts the editor at 1440 and at 390 and asserts the same save
controls at both — and asserts each width alone, because `mount` fires a
`resize` that every editor still on screen listens to, so two held open and
compared afterwards compare one width against itself. Written that way, the case
was green against the defect it exists to catch.

### The browser-reachable console is the console, at every density

`/e2e-fixture` is the only console in this repository anybody can open in a
browser — every other route wants a session and a deployment — so it is what the
WebKit suite drives, what a screenshot of "the console" is taken against, and
what a person looking at this product in a real browser is looking at.

It was the phone console at every width. `E2EFixtureScreen` wires `BrowsePane`
under a `NavBandProvider` exactly as the console layout does, and `BrowsePane`
draws that band at compact only, because at medium and wide the contexts are
`ConsoleRail`'s — one switcher per density, never two. The fixture mounted the
compact half and not the pointer half, on the argument that `AppFrame`'s regions
were not what the WebKit cases press.

Measured in Chromium at 1440×900, that argument's bill: the whole console
answered **three** `[role=button]` elements — an avatar, one breadcrumb crumb
and the save pill — and a person could not reach another context at all. The
same fixture at 390×844 drew `@lk` and `@public-worship` above the path. A
reachable-contexts affordance visible on a phone and absent on a desktop is
backwards, and "a session resolves to a *set* of accessible contexts" is the
product rather than a layout preference.

**The product was right the whole time**, which is the part worth recording: the
rail has carried the contexts at medium and wide throughout. What was missing is
that nothing said so. `consoleChrome.test.ts` asserted the strip at 390 and
nothing at 1440, so the claim that the console has a switcher at every density
was resting on nobody having checked — and the fixture, which is what people
check *with*, reported a defect the product does not have.

So: the fixture takes the density decision the way the product takes it
(`densityFor` and `regionsFor`, not a width literal) and mounts the real
`ConsoleRail` in the mode those functions answer, with the account block in the
rail's foot where the product puts it. `AppFrame` is still not reproduced — the
column is a plain `View` at `layout.railWidth`, and the hairline and surface
fill stay that component's, pinned by `appFrameRender.test.ts`.

Two guards, deliberately in different places. `consoleChrome.test.ts`'s "every
context this account can reach is on the screen" asks the **product** the
question at 390 and at 1440 and does not care which component answers — its mock
grew a second context, because a one-context account renders identically whether
or not a switcher exists. `fixtureConsoleDensity.test.ts` asks the **fixture**
the same question, and asserts the strip and the rail are never both on one
screen. Sabotage: `rail: "hidden"` in `regionsFor`'s wide arm fails six cases
across the two files.

What it costs: `settings.spec.ts`'s pointer-width case reaches Settings through
`rail-settings` rather than the compact account menu, because the compact block
is no longer drawn at that width — one control where the product has one, rather
than a stand-in for a region that was missing.

### The note is a measured column, and the demo note stopped faking one

Measured in Chromium at 1440x900: the element holding the first sentence of the
console's own demo note was **1160px wide, with `max-width: none` on every one
of its first eight ancestors**. Prose was full-bleed across whatever width the
editor pane had — about 150 characters to a line, roughly double the 60-75 that
is comfortable to read — and there was no `max-width` anywhere in either of the
editor's two stylesheets.

**Why nobody had seen it.** `placeholderData.ts` authored
`1-projects/context-lc.md` as hard-wrapped source lines of about fifty
characters, and that note is `defaultSelection` — what the console opens on,
what the e2e fixture shows, and what every screenshot of the editor has ever
contained. The newlines were doing the wrapping. A reader saw a tidy column that
the layout had nothing to do with, so every visual check of this editor passed
while a real note, written the way people write them, ran to the full width of
the window. The fixture is now normal unwrapped paragraphs — same wording, the
browser's line breaks — and re-wrapping it would hide this whole class of bug
again.

**The measure is `--lp-measure`, in `ch`, one value for both densities.**
`layout.readingMeasureCh` is 62; `ch` is the advance of "0", which every system
sans draws wider than its average lowercase letter, so 62ch of box holds about
75 characters in the widest face measured and nearer 68 in the narrower ones.
Characters rather than pixels because the same note is drawn at 14.5px beside a
file tree and at 16px on a phone, and a measure in characters is the same
sentence at both. On a phone it cannot bind at all — 342pt of text inside 24pt
gutters is far narrower — so `--lp-pad-x` still governs there, which is the
point rather than an accident.

**Nothing is allowed to be wider than the prose.** The constraint is on
`.cm-content` rather than on `.cm-line`, because a table, a form and a rendered
diagram are block children of the same element: measure the lines alone and each
of those starts at a different left edge from the paragraph above it, which
reads as broken layout rather than as a wide table. A wide table gets its own
horizontal scroller (`.cm-lp-grid`, which already had one) so it stays inside
the column instead of dragging the document sideways.

**It is padding, not `max-width`, and that is the one non-obvious line.**
`max-width: var(--lp-measure); margin-inline: auto` draws exactly the same
column and was measured and rejected: it leaves `.cm-content` 572px wide inside
a 1192px pane, so a click in the 310px either side lands on `.cm-scroller`, the
editor never takes focus, and clicking beside a line to put the caret in it does
nothing. That is half the note's apparent area no longer being the editing
surface — a worse bug than the one being fixed, and an invisible one, since the
page looks right. So `.cm-content` keeps the pane's full width and the column is
cut out of it with `padding-inline: max(0px, calc((100% - var(--lp-measure)) /
2))`: CodeMirror still maps a click in the margin to the nearest position, and
the `max()` floor hands the width straight back once the pane is narrower than
the measure, which is the phone. `readingMeasure.spec.ts` clicks in the margin,
so the tidier-looking recipe cannot come back quietly.

**It is declared twice, and that is the whole of PR #487's lesson.** The same
stylesheet runs inside the iOS WebView with the palette arriving over a bridge,
and an undeclared custom property makes its *whole declaration* invalid at
computed-value time — not an error, not a fallback. So `--lp-measure` is in the
base `.cm-lp-root` rule (`LiveEditor.web.tsx`), in the guest's `:root`
(`files/webview/styles.ts`), and in `themeVars` (`files/webview/host.ts`), and
`liveEditorMount.test.ts` and `webviewBridge.test.ts` hold that relationship
from both ends.

**The guard that proves it binds is not in Jest.** jsdom lays nothing out, so no
unit test here can tell a `max-width` that binds from one that does not — which
is exactly the state this editor was already in.
`e2e/webkit/readingMeasure.spec.ts` drives the built web export in a real engine
at 1440x900 and at 390x844 and asserts the **character count** on the rendered
line, that the column is centred and its margins still take a click at the first
width, and that `--lp-pad-x` alone governs at the second. It measures the line
box rather than `.cm-content`, because `.cm-content` is deliberately still the
full width of the pane.
