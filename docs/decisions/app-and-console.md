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
- **The context segment comes back, pressable.** The full line drops it because
  the switcher above says it; here it is not a label but the way *up*, and
  without it the bar bottoms out one level short of home. What that duplication
  argument was paying for — a line that ellipsised at both ends — is refunded by
  the leaf and the chip being gone.

Selecting the root is what that segment does, so the root needs a name:
`baseName("")` is empty, and `FolderView` takes a `contextLabel` for the one
folder with no name of its own. A context's root folder *is* the context.

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

### A phone has no left panel, so the one thing its footer said had to move

The rail sheet, the file-tree drawer, both toggles and their scrim are gone at
`compact`; navigation is a context strip along the top and a seven-key bottom
row, neither of which has to be summoned. `features/app/frame.ts` carries the
whole of that decision and amends its own paragraphs in place.

What that removal cost is one line, and it is worth naming because deleting it
with the panel would have been silent. The tree's footer read
`R2 · brain · 62% indexed · 12 notes, 8 folders` — the storage binding, how much
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
top row. The mark stays `layout.accountAvatar` (34) and the pressable around it
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

### Two name fields for a workspace, one for a brain

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
for a brain and the wrong one for a company, whose context is sorted by who owns
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

### The rail splits on kind, and ownership is a mark on one row

The switcher grouped on **ownership** — "Yours" over everything where your role
was `owner`, "Shared with you" over the rest — and the reason it gave was sound:
one flat list made a context you own and a context you were invited into
indistinguishable, and *whose notes am I about to open?* is the question the rail
exists to answer at a glance.

It was answering it in the wrong place, and two things showed that:

- **It named neither of the product's nouns.** The vocabulary decision gives the
  two kinds two words — a **brain** is one person's context, a **workspace** is
  a shared one — and the rail is the one surface where a person meets both.
  Heading it "Yours" and "Shared with you" made the switcher the only place in
  the product that talks about contexts without using either word for them, at
  exactly the moment somebody is learning that the two kinds are different.
- **For a brain, the row already answered it.** `@sayo` is Sayo's brain; nobody
  reads that row and wonders whose notes are behind it. The section boundary was
  spending the rail's strongest structural device on a fact the handle carries
  for free — and paying for it by scattering the workspaces, where whose-is-it
  *is* genuinely ambiguous, across both sections according to something the rail
  never showed.

So the groups are **Brains** and **Workspaces**, and ownership moved to a mark
on one row: `isOwnBrain` requires a personal context you own, that context is
pinned first in its group, and it is labelled `yours`. Exactly one row can ever
carry it — `createWorkspace` writes one personal context per person and there is
no transfer path — which is what makes a marker the right shape and a section
the wrong one. It is a quiet label rather than a badge, because the row it marks
is the one the person recognises fastest anyway: it only has to settle the
question, not raise it.

Ownership of a *workspace* is deliberately unmarked. A workspace is shared by
construction; what differs is your role in it, which is three states shown on
the members card rather than one bit in a switcher.

**The pin is a pin, not a sort.** Everything after the own brain keeps the order
the control plane sent. Re-ordering somebody's list on their behalf is a
decision the rail is not making, and a stable list is what makes muscle memory
work.

Each of the two entries moved to the group that raises the question it answers,
and they stay two flags rather than one. "Claim your @name" lives last in
**Brains** — a person looking at a list of brains, none of which is theirs, is
being shown the gap — drawn accented, gone forever once used. "New workspace"
lives last in **Workspaces**, drawn quietly because it is a permanent verb and
an accent on it would be an advertisement on every screen of every session. It
is also the *whole* group for somebody in no workspaces yet, which is how a
person who has only ever had a brain finds out workspaces exist.

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
was the one who broke their own brain — and `[[../../2-products/x/overview]]`
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
brain is selected — and it is the precedent for the exception list rather than
an invention of one. A reason that lived only in the registry is a reason the
next person editing that route never reads.

What the guard cannot do is lay a screen out: jsdom hit-tests nothing, so "the
control is on the glass at that width" stays with the mounted tests each surface
already has (`consoleChrome.test.ts`, `meetingsFlow.test.ts`,
`meetingsEntry.test.ts`, `railSections.test.ts`). What is genuinely new is the
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
