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

### Hue is meaning in this product, so the palette rations it

Every accent the app shipped with was a Tailwind default — `#3B82F6` blue-500,
`#34D399` emerald-400, `#FBBF24` amber-400, `#F87171` red-400, `#8B5CF6`
violet-500, and blue-600 / red-600 / violet-600 in the light palette — and the
greys carried a blue cast to agree with them. That is worth stating as the
cause rather than as trivia: a palette assembled from a framework's defaults
looks like every other application assembled from them, and no amount of layout
work recovers from it.

Both palettes are warm neutrals now, Graphite and Paper, and hue is spent only
where it carries meaning. Five families, each with one job, placed far enough
apart that no two can be confused at a glance:

- **petrol** (`accent`, `hint*`, `codeKey`) — here, active, yours. It is the
  only hue the interface spends on *itself*, and it is never a status.
- **sage** (`ok*`) — synced, saved, bound.
- **amber** (`warn*`, `warm`) — degraded but working.
- **rust** (`crit*`) — conflict, revoked, failed.
- **iris** (`shared*`, `graphColors.shared`) — somebody else's context. The one
  cool hue in the budget, deliberately: a context that is not yours should not
  sit in the same family as the paper it is drawn on.

`private` — the resting state of very nearly everything in this product — wears
no hue at all. That is what forces the neutral ramp to do real work, and why
each palette has four surfaces rather than two near-identical ones.

All 41 token names were kept through the repaint, which is why it moved no call
site: a screen already reads its palette through `useColors()`.

*What a "simplification" costs:* taking a colour from a framework's palette
because it is to hand puts this product back in the crowd it was indistinguishable
from, one token at a time — and spending a hue decoratively means the next real
status has no hue left that reads as one. *The tests that fail if it is
reversed:* `theme.test.ts` — `no retired framework default has crept back into
either palette`, which names all eight by value; `muted clears AA on every dark
surface, the old exception retired`; and the contrast and hierarchy suites that
hold every text token to AA on every ground it is drawn on.

### Nine sizes, two densities, and no literal font size anywhere

`tokens.ts` tokenised colour, radii, spacing and shadows and did not tokenise
type — so every screen picked its own size. Counted before this landed: **26
distinct font sizes** across `features/` and `app/`, drifting in half-points,
10 through 17 with nearly every half-step occupied. `Text.tsx`'s 33 variants
held 16 sizes between them on their own.

Nothing chose those gaps. They are what a variant added by copying its
neighbour and nudging the number until one screen looks right leaves behind,
and they are the single largest reason two panels built by two hands never
looked related.

`pointerType` and `touchType` are nine integer roles at two densities, and
`typeFor(density)` picks one. Integers only: a half-point is never a decision,
and it blurs on any display that is not 2x. The two densities are the same
split `radii` had already argued for in prose and expressed as three lonely
values; `title` gets **smaller** on a phone, because the measure there is about
342pt against the console's 640 and a title that wraps to three lines is an
obstacle rather than emphasis.

The scale governs size only. Weight, tracking, colour and transform stay each
variant's own.

*What a "simplification" costs:* a tenth role, or one literal `fontSize` in one
stylesheet, is how nine becomes twenty-six again — it always arrives as a single
reasonable-looking addition, and the rendered difference between `13.5` and
`pointerType.ui` is half a point, which no render test would be written to
notice. *The tests that fail if it is reversed:* `typeScale.test.ts` — `the
roles are the nine that were designed, and no more`; `pointer sizes are whole
numbers` and its touch twin; `touch is not pointer scaled up — the title is
deliberately smaller`; `no stylesheet carries a literal font size`, which reads
every `.ts`/`.tsx` under `features/` and `app/` and names file and line; and
`a rendered note keeps six heading levels`, which exists because mapping
`NoteBody`'s `h5` and `h6` by value put both on `ui` and collapsed a level of
the document with nothing failing.

### One interface face, and `display` kept as a role with no face of its own

The app shipped Onest beside Instrument Sans as a display face. Nothing in a
console is set large enough to tell two humanist sans apart — measured, they
differ by about a point and a half of width per hundred pixels and by nothing a
reader would name — so it was a webfont fetched on every cold load that bought
no identity.

`fonts.display` stays as a token, because the role is real: a wordmark, a hero,
a pane title and a legal page's headings want one voice and the interface wants
another. Keeping the name means a face can be given back to that role later
without touching a call site. It resolves to the body face for now, and the
difference between display and interface is carried by size, weight and
tracking.

**The hero's width bound is a measured property of whichever face is in use.**
`HERO_CH_RATIO` is the advance of "0" in the display face, and changing the
face invalidates it. Re-measuring is not optional and estimating is the
specific failure `hero.ts` was written about — the first port used a flat 780px
and wrapped the headline to four lines. Measured in Chromium against the real
woff2 at 98px, weight 500: Onest 65.00px per `ch`, Instrument Sans 66.00px.

The method matters as much as the number: it was validated by reproducing the
file's own previously recorded figures — 65.02px, and 846.3px for "Share your
context." — before the new ones were trusted. A measurement that cannot
reproduce the last one is not a measurement.

*What a "simplification" costs:* a second display webfont is a download on
every cold load for a distinction nobody can see at console sizes; and a hero
ratio carried over from a retired face, or reasoned from character counts
rather than measured, silently wraps the headline and pushes the console demo
below the fold, which is the one thing the landing design is built around.
Characters are not a proxy for width — the hero's own copy change shipped 14px
wider than the reasoning beside it claimed. *The tests that fail if it is
reversed:* `htmlShell.test.ts` pins the served document's font href to
`fonts.web.ts`'s, so a family cannot be added to one alone; `consoleFormat.test.ts`
holds `heroHeadingWidth(98)` above `HERO_LONGEST_LINE_AT_98` and across the
clamped size range.

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

Reading the bucket side is self-healing. A Convex action can hang when a device
still appears online, and a provider or gateway can fail one read while the next
one succeeds, so the conflict review bounds each read, retries transient
failures with backoff, and offers an immediate retry on the same screen. It does
not retry server refusals. Until a bucket body and etag have actually been read,
the choices that would discard or overwrite text are unavailable; a hard
refresh is never part of resolving an ordinary transport failure.

A deletion conflict is not an unreadable bucket version. The refused write is
authoritative: an expected etag was supplied and the path was absent, so the
resolver shows a distinct two-way choice. **Keep deleted** discards the local
draft and closes the note without writing; **Keep mine** recreates it with a
create-only write (no expected etag), which is refused as a fresh conflict if
anything has appeared at that path meanwhile. There is no Merge control because
there is no bucket body to merge, and the console never loops on a
`FILE_NOT_FOUND` read to establish something the write already proved.

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

**A phone carries the same three states, in a header pill and a sheet.** The
strip does not exist at compact (`frame.ts`: `statusBar: false`) and
`SaveChip` was pointer-only, so for a while a phone — the device this layer
was built for — was told none of it. `SyncPill` sits in the phone's top row
(`AppFrame`'s compact-only `syncSlot`) and draws `compactSync`, which is
`syncSegments` — the strip's own connection and queue segments, lifted out of
`statusSegments` — plus the open note's `saveChip` in its loud states
(`Queued`, `Cached copy`, `Conflict`, `Not saved`). So it is absent in exactly
the states the strip is silent in, including while the platform has not said;
it reads `Offline · 3` offline and the queue's own sentence online; and it is
`crit` whenever anything behind it is. Tapping it opens `SyncSheet`, which says
the same sentences and lists **every** waiting and stuck note as a row that
opens it — opening is how a parked write is answered — and gives a cached
copy its age, which a phone has no tooltip for. The quiet save states stay off
the phone's header on purpose: the note's foot sentence says them, and a pill
on every note is one nobody reads.

**Every list marks the notes that are not in the bucket.** The tree, the
folder page and the Recent sheet ask `files.pending.stateFor(path)` —
`pendingMarks`, a read-only selector over the open context's live queue, which
is the only context any of those lists shows — and draw a `warn` ring for a
queued write and a `crit` target for a parked or refused one, with "waiting to
sync" / "needs you" in the row's accessible name. Shape before hue, because the
folder page's exception pip is already a disc. `__tests__/phoneSync.test.ts`
pins the rules (and that the pill's facts are the strip's, case for case);
`__tests__/phoneSyncRender.test.ts` fails if the pill draws when there is
nothing to say, if the frame gives it a slot at a pointer width, if the sheet
stops naming or opening notes, or if any of the three lists stops marking.
Pictures are in `docs/design/offline-status/`, written by
`__tests__/offlineStatusShots.render.ts`.

### A cold start with no network is the case the offline layer was built for

Everything in the section above — the cache, the drafts, the queue, the
three-way merge — was reachable only while the app was *already running* with
the context list *already loaded*. Both of those come from `listMyWorkspaces`,
which is a Convex subscription, so with no network neither ever arrives:
`(app)/_layout` sat on `resolveProtectedRoute`'s `wait` for as long as the app
was open, and had it got past that, `visibilityTierForRole` answered `unknown`,
which makes `useOfflineNotes` set its scope to `null` and refuse to serve a
single cached byte. Deliberately, and for a good reason — an offline cache
cannot re-check authorization, so a copy is filed under the clearance that read
it and a session that does not know its clearance must not read one.

The consequence was that the feature worked for a phone going into a pocket and
not for a phone coming out of one. A relaunch — an OS reclaiming a backgrounded
app, a restart, a browser tab opened fresh — is an app that will not start, on a
device holding a complete offline copy of the notes somebody wanted to read.

**So the context list is written down as it lands, and read back when it has
not.** `features/offline/cache.ts` holds one `context` record per workspace and
`useRememberedContexts` decides whether it may be served.

**Three conditions, all of them required.** The live list has not landed (not
"is slow" — `undefined`); the device says it is offline; and something was
remembered. The first is why there is no merging and no preferring the fresher
of two: one of them is a fact and the other is a memory, so the moment the
server answers, the server wins. The second is why this is not a stale rail
flickering ahead of a real one — online, a list that has not arrived is a list
that is about to, and waiting for it is what the console already does. The third
is the security property, and it is the whole of it: sign-out calls
`forgetLocalCopies`, which clears this namespace along with the note bodies, so
**the presence of a remembered row is the evidence that a session got far enough
to have one**. A signed-out device remembers nothing, offers nothing, and waits
exactly as it did before.

**Remembering a role cannot widen a clearance, and that is a fact about the
control plane rather than care taken in the console.** The clearance a cached
copy is served under is `private` for `owner` and `team` for everybody else
(`scopeForRole`, mirrored by `visibilityTierForRole`), and the owner role cannot
be taken away: `setMemberRole` refuses with `CANNOT_CHANGE_OWNER_ROLE`,
`removeMember` with `CANNOT_REMOVE_OWNER`, `leaveWorkspace` with
`OWNER_CANNOT_LEAVE`, and ownership transfer is not built. A remembered role can
therefore be *out of date* — a promotion from `member` to `editor` is not seen
until the next successful load, and both of those read at `team` anyway — but
never *wider* than the one the server would give, which is the only direction
that discloses anything. That premise is pinned where it lives, in the control
plane, by `apps/convex/__tests__/ownerRoleIsPermanent.test.ts`: build ownership
transfer and that test goes red, which is the moment to make this remember
`team` for a context whose ownership can move.

**A remembered row never outlives the reach it describes.** It is taken by
`keysForWorkspace` when somebody presses Leave and by `keysForDepartedContexts`
on the first load that sees a context gone — the endings this device never
witnesses, which is where a row left behind would name a context on the rail of
somebody who was removed from it. Making that true needed one distinction the
folder had been conflating: `sweep` and the departed purge both spelled "never
somebody's typing" as "has no clearance", which was the same set only while
every unscoped kind *was* typing. `isOwnTyping` is that idea by itself, spelled
as a record over `Kind` so a kind added later has to declare which side it is
on, and taken by default rather than exempt by accident.

**The row holds identifiers and labels and nothing else** — the same class of
thing `lastPlace` already keeps. No note text, no etag, no draft, no credential.
It ages out on the same thirty-day bound as a cached note, because a device that
has not reached the server in a month should not still name somebody's contexts;
it is deliberately *not* subject to the count bound, because evicting a few
hundred bytes to make room for a note body would cost the boot the rest of the
feature now depends on, invisibly.

**The gate renders without claiming the session is authenticated.**
`resolveProtectedRoute` answers `render`, and `isAuthenticated` stays false —
so `(app)/_layout` now reads its subscriptions off `auth.isAuthenticated` rather
than off `decision.action === "render"`. Those were the same value until this
landed and are now different questions: a subscription opened on an unconfirmed
identity is refused by `requireAuth` anyway, and the layout should not be asking.

**Every gate a cold start passes through takes the same escape, not only the
console's.** A phone always launches on `/`, and `resolveRootRoute` sat in front
of `(app)/_layout` with a bare `wait` on `isLoading` — so this whole section was
unreachable from the launch it was written for, and the phone showed a blank
ground however many times it was relaunched. Every test drove the console's gate
directly, and on the web `/` is the landing page, so nothing saw it. `/` now
reads the same remembered session and sends it to `/console`; the console's gate
still decides what renders. A new gate on the launch path that waits on
`isLoading` must take `rememberedSession` too, or it reintroduces this.

What a simplification of any of it costs: dropping the offline condition puts a
memory where a round trip was going to answer; dropping the "server always wins"
ordering makes a rename take a reconnection to appear; dropping the sign-out
clear draws one person's contexts for the next person to sign in on that
machine. `__tests__/offlineRemembered.test.ts`,
`__tests__/offlineRememberedHook.test.ts` and the protected-route tests in
`__tests__/authRedirect.test.ts` each fail on their own rule.

**What this does not fix, named so it is not mistaken for done.** A device that
has *never* loaded the console online still cannot start offline, and should not
— there is nothing to remember. This paragraph used to go on: "the cache is
still populated only by reads, so what is available on a train is what somebody
happened to open". The mirror replaced that on every device that has one — every
note of every context the person can reach, not the ones they opened (see "Every
note on the device: the mirror" below); only a browser with IndexedDB blocked is
still limited to what it read, and is told so. On the web none of this survived
a cold *tab* until the service worker below. The desktop shell's mirror is a different origin again, with its
own storage, so it sees none of this.
### On the web the app has to be able to *start* offline, which is a service worker

The two sections above put the customer's notes on the device and made them
reachable from a cold start. On the web none of that runs. Every line of
`features/offline` is JavaScript, and a browser does not execute JavaScript
until it has fetched a document and a 4.5MB bundle over the network — so a tab
opened on a train showed the browser's own offline page, with a complete copy
of somebody's notes in `localStorage` on that very origin and nothing running
to read it.

A service worker is the only thing that can answer a navigation with no
network. `public/sw.js` is that worker, and `expo export` copies `public/` to
the output root, which is what puts it at `/sw.js` — a worker may only claim a
scope at or below the directory it is served from, so the root is not a
preference here, it is the requirement.

**It is origin-wide, which `drawing-editor/sw.js` argues against by name**, and
that argument is the reason for the shape rather than a reason not to do it.
The danger it names is staleness, and staleness is a property of that page
rather than of workers: `editor.js` and `editor.css` keep their names across
deploys, so a cache-first worker pins you to whatever you first fetched. The
console is the opposite — `infra/router` marks `/_expo/` immutable precisely
because *"the filename changes when the bytes do"*. So:

- **A navigation is network-first.** Online everybody gets the document the
  server has, which is the one naming the current bundle. A deploy lands on the
  next online load with no version lag at all.
- **`/_expo/` and `/assets/` are cache-first.** Their names contain a hash of
  their bytes, so a cached one cannot be the wrong version of anything.

A stale shell is served only when the alternative is nothing, and it points at
hashed assets cached beside it.

**Every navigation is stored under one key, and that is a privacy decision
rather than a tidiness one.** The console is a single-page app, so `/`,
`/console/@someone` and `/console/@someone?note=1-projects/pay-review.md` are
all answered by the same document. The obvious worker caches a navigation under
its own URL — and would therefore build, inside `CacheStorage`, a list of every
context and every note path somebody had opened, outside everything
`forgetLocalCopies` clears at sign-out. Under one key the cache holds one
generic document and some public build output, identical for everyone who loads
the origin: nothing to leak, and nothing worth clearing.

**What it will not touch** is a closed set, each clause a way this becomes a
cache of somebody's content rather than of the app: non-`GET`, cross-origin
(the notes come from Convex on another origin, the fonts from Google), `/api/`
(same-origin, proxied to the control plane, the one prefix that answers
per-person), `/drawing-assets/` (that worker's, at a narrower scope), anything
carrying `Set-Cookie`, anything redirected, anything not `ok`.

**A rejection inside `respondWith` is not a cache miss, it is an origin that
will not load.** A worker survives the tab and cannot be reloaded out of, so
every cache operation answers instead of throwing. `caches.open` is the one
that makes this real: it *rejects* where a browser refuses storage — a Safari
private window, blocked site data, an enterprise policy — which is exactly the
population least able to clear anything. Written the obvious way, with
`await caches.open(CACHE)` at the top of each handler and outside its `try`,
every one of those people gets a broken origin instead of a normal one. A
`null` cache means no cache and every caller goes to the network, which is how
the console behaved before any of this existed.

The manifest beside it is what makes the worker worth having on a laptop: an
installed window opens into the app rather than into a browser that has to be
online to show a tab. `start_url` is `/console` and not `/`, because on web the
root is the landing page and somebody who installed this has an account;
`scope` stays `/` so a link into any route opens in that window. The icon is
`purpose: "any"` and deliberately not `maskable` — a maskable icon has to
reserve a safe zone inside its own artwork, and claiming it for one that does
not is how an icon ships with its edges cropped.

What a simplification costs: caching per URL writes somebody's note paths into
a store that survives sign-out; cache-first on a navigation reintroduces the
stale-shell failure the drawing worker warns about and pins people to an old
bundle; letting `caches.open` reject takes the origin down for private windows.
`__tests__/appShellWorker.test.ts` drives the real file in a sandbox and fails
on each.

**What this does not do.** The desktop shell still mirrors the console to
`app://console/`, a second origin with its own storage that therefore sees none
of this — with a service worker on the live origin that mirror is largely
redundant, and retiring it is a change to [desktop](./desktop.md)'s own argued
design rather than a detail of this one. There is still no precache manifest,
so the *first* load must succeed; a person with no network on their first ever
visit has no account or notes on the device either.

### A reconnection empties every queue, not the one on screen

The queue has always been per context — one outbox record per workspace, keyed
by workspace id, and `waitingOnDevice` already walked all of them for the
sign-out warning. Only one of them was ever *drained*. `useOfflineNotes` is
instantiated for the context the console is showing, hydrates that outbox, and
empties it when reachability comes back; nothing hydrated the others.

The shape of the bug: edit a note in your own context, switch to a shared one
and edit there, go through a tunnel, come back. The context on screen sends its
writes. The other sits unsent until somebody happens to navigate into it. The
status strip said "3 notes waiting to sync", which was true, and the app had no
way to act on it — and the button beside that count at sign-out is the one that
throws the queue away. Nothing was lost, and "your edit will go when you
reconnect" was true of one context and not of the rest.

`drainOtherContexts` is one sequential pass over every queue **except** the open
one, mounted once by `useLiveConsoleData` as `useBackgroundDrain`.

**The exclusion is the interesting half, and it is not a hole.** The console
holds a *live* queue for the context it is showing, and the record on disk
trails it by up to `PERSIST_DEBOUNCE_MS`. Two drains against one queue — one
from the live copy, one from a stale record — would re-send entries the other
had settled and write back a queue missing whatever was typed in between. So the
open one stays the foreground drain's, on the same reconnection, by the path it
always used. It is the same split `waitingOnDevice(store, exceptQueueIn)`
already makes, at the same boundary and for the same reason. `null` — no context
open, which a cold start really is — means every queue is the pass's.

**Which queues it takes is read off the store's keys, never off the context
list.** A queue is somebody's typing; the list of contexts the console can
currently see is a different question that can arrive late, short, or not at
all, and driving the drain from it would leave unsent work in a context whose
row had not loaded. A queue for a context the person has genuinely lost is not a
problem either: its writes are refused by the server and parked by the rules
that already exist, which is visible, rather than dropped, which is not.

**The workspace became an argument to the write, and that is the cross-tenant
property.** `useFileBrowser`'s sender closes over the open context. A background
pass that reused it would have written every context's queued edits into
whichever context happened to be on screen — somebody else's note, under
somebody else's privacy rules, by a code path nobody pressed. So there is now
one `queuedWriteSender` in `features/console/files/queuedWrite.ts` that takes a
`workspaceId`, and both drains bind it: the foreground one to the open context,
this one to the workspace each queue is *filed under*. One definition, because
two would be two places for a `force` flag to appear or an `expectedEtag` to be
dropped "to get things through", which is last-write-wins with extra steps and
would read like a bug fix.

**Nothing about a queue's rules changed.** Every write this pass makes is
`drainOutbox`'s: the same `expectedEtag`, the same conflict parked rather than
retried, the same bounded attempts, the same allowlist of transient codes. This
module decides *which queues* and in *what order*; `sync.ts` decides everything
that happens to one. It is sequential across contexts for the reason
`drainOutbox` is sequential within one — each entry is a round trip against the
customer's bucket, on their request quota.

Two smaller decisions, each a way it could go wrong:

- **It passes no `onWritten`.** That callback exists to move the *open* editor
  onto the etag the bucket now holds, and by construction none of these queues
  is the open context's. Calling it would hand the console an etag for a note it
  is not showing.
- **The epoch is checked again before every write-back, not once at the top.** A
  pass over four contexts is far more time than one drain, and
  `forgetLocalCopies` bumps the epoch before it removes anything — so a
  write-back after a sign-out would re-persist the entries somebody was warned
  about and pressed "discard" on, one context at a time, onto the machine the
  next person signs in on.

What a simplification costs: dropping the exclusion puts two drains on one
queue; binding the sender to the open context writes one context's edits into
another; dropping the second epoch check undoes a sign-out.
`__tests__/offlineDrainAll.test.ts` fails on each, and the middle one fails on
two tests rather than one — the cross-tenant assertion *and* the exclusion,
which sees it in the calls it was handed even though the queues taken were
right.

### The offline mirror is fed by a privacy-filtered manifest, a batched read, and a create that cannot clobber

The sections above cache what somebody happened to open. The mirror — every
note a person can see, on the device, reconciled when online — needs three
things the control plane did not have: a way to enumerate everything visible
*with its version* without reading it, a way to fetch many notes without a
round trip each, and a create that stays a create when it is sent hours after
it was typed. `functions/files.ts` now has `syncManifest`, `readNotes`, and an
atomic create inside the existing `writeNote`.

**The manifest is filtered by the same `canSee`, and it is the only filter.**
`syncManifest` walks the whole bucket once and keeps what `canSee` keeps at the
caller's clearance — the clearance `authorizeFileAccess` resolves for
`listFiles` and `readNote`, group names included. A `team` member never
receives a private note's path, etag *or size* — the version is half of
"exists", and a manifest that dropped the path and kept the etag would still
count somebody's private notes and date every edit to them. Context's plumbing
is absent for everybody; `privacy.md` reaches only the owner, marked
`readOnly`, as it does in a listing. A non-member is refused with
`WORKSPACE_NOT_FOUND`, byte-identical to a context that never existed — an
empty manifest would be an oracle of a different shape.

**Versions come from the listing, never from a read.** The etag on each entry
is the store's own — S3's `ETag`, Dropbox's `rev` (which the Dropbox listing
used to drop) — and is the value `readNote` returns, so one walk says which
notes changed and nothing else is fetched. An entry without an etag means the
store listed none: read it to learn its version, never "unchanged".

**The cursor is the last path the caller was given, never the store's
continuation token.** That token is base64 of the last *backend* key of a page,
and at `team` scope that key is routinely a private note: handing it back would
name one private path per page, to exactly the reader the filter exists for.
So a page ends on a visible entry and the next call asks the store to start
after it (`startAfter`, ListObjectsV2's `start-after`). That only means
something on a store that lists in key order and honours the position, and
Dropbox does neither, so both are *checked*: a listing seen out of order gets no
cursor, and a resumed walk that comes back with a key at or before the cursor
stops. Either way the page says `truncated: true` — the pages so far are a
floor, and the client must not read a missing path as a deletion — rather than
replaying the start of the bucket under a cursor that promised the rest, which
would loop the client forever.

**The batched read is `readFile`, N times, under one manifest load.**
`readFiles` calls `readFile`'s own body (`readVisibleFile`) per path; there is no
second privacy path to drift. A hidden note and a missing one are the same row,
with `readNote`'s own code and message, and a hidden note is never fetched from
the bucket at all. A refusal is that path's answer and does not fail the batch.
It is capped at `READ_BATCH_PATHS` (50) — refused before the credential barrier
opens anything — and at `READ_BATCH_BYTES` of note text, past which the rest
come back `deferred`. The budget is spent only by notes that were read, which
only a visible one is, so a deferral says nothing about a hidden path.

**A create that must not clobber is the create that already existed, made
atomic.** `writeNote` with no `expectedEtag` has always meant "new, and a
conflict if something is there" — and the offline queue already sends exactly
that for a note typed while it did not exist. But the check was a read and the
put after it was unconditional, so a note created at that path in between was
overwritten silently, and offline turned that round trip into hours. The put is
now `onlyIf: { absent: true }` wherever the binding **proved**
`conditionalCreate` — `If-None-Match`, probed separately from `If-Match`'s
`conditionalWrite`, because a bucket that honours one need not honour the other.
A lost race is the same `CONFLICT`, with the `currentEtag` of what won, that
every other conflict carries, so the queue parks it by the rules above. Where
the capability is not proven the read is still the check, and the result says
`read-compare`, exactly as an update on such a bucket does. No flag was added:
a second way to say "create" would be a second place for somebody to leave it
off.

What a simplification costs, and what fails:

- Filtering the manifest with anything but `canSee`, or running it at the
  owner's clearance, hands a team reader the private half.
  `offlineSync.test.ts` ("a team reader gets only what is shared…") and
  `files.test.ts` ("an owner's manifest and a member's differ by exactly the
  private half") fail.
- Returning the store's continuation token as the cursor names private paths.
  "a team reader's cursor is always a path they were given" fails.
- Trusting a store to have resumed, or to list in order, loops the client or
  skips notes. "a store that ignores the resume point…" and "a store that does
  not list in key order…" fail.
- A batch read that does its own visibility check, or none, breaks the
  hidden-equals-missing rule. "hidden and missing answer byte-identically…" and
  "a batch answers each path as readNote would…" fail.
- An unconditional create, or one gated on `conditionalWrite`, clobbers or
  claims a guarantee it does not have. "a create that lost a race…" (both
  files) and "a bucket that has not proven onlyIf-absent…" fail.

**What this does not do.** It is the server half. The mirror itself — walking
the manifest, fetching what changed, dropping what is no longer visible,
reconciling with the queue — is the client's, and is the next section. The
manifest does not say whether a note is encrypted: that is in the note's
frontmatter, not in a listing, and `readNotes` reports it per note. And a bucket
of more than about a hundred thousand hidden keys in a row before anything the
caller can see ends a page with no progress, which is reported as `truncated`
rather than hidden behind a cursor that could only have been a private path.

### Every note on the device: the mirror

The owner's requirement, verbatim: the app "should work perfectly fine even when
offline; people should have all their notes downloaded on their device, sync any
time when connected … and it should be clear when notes are not synced." The
sections above made what somebody *opened* readable offline, bounded to 200
records in a five-megabyte store. The mirror is every note of every context the
person can reach, on the device, reconciled with the bucket whenever there is a
connection. It is `features/offline/mirror*.ts` and `useMirrorSync.ts`.

**It is still a disposable derivative, and the typing is still not in it.**
Non-negotiable #3 holds unchanged: deleting the whole mirror loses a download
and nothing else. Drafts and the queue stay in `cache.ts`/`outbox.ts`, never
evicted, never bounded — the mirror holds copies of what the bucket said and no
line of it is somebody's unsent work. That separation is what lets the mirror be
pruned freely.

#### Storage: files on native, IndexedDB on the web, and what a path may become

`localStorage` caps near five megabytes for the origin and Android's
`AsyncStorage` defaults to six; a context of a thousand notes fits in neither,
and a full store throws on the next write — which in `KeyValueStore` is the write
that queues somebody's typing. So the mirror has storage of its own behind one
port (`mirrorStoreCore.ts`): one file per note body under the **document**
directory on native (`expo-file-system`, already `core` in `native-deps.json`, so
no gate and no `runtimeVersion` bump), and a hand-written IndexedDB wrapper on
the web (four operations and a probe — a dependency would be a web-only library
in `apps/mobile` for four calls). The document directory rather than the cache
directory because the OS empties the cache under pressure, silently, and a
mirror that vanishes on a train is the failure this exists to remove. IndexedDB
is **probed with a real write**, like `localStorage` is: every refusal (a private
window, blocked site data, over quota, an open that never answers) is "no mirror
on this device", the bounded cache keeps serving what was opened, and the
console says "This browser is not keeping an offline copy" rather than claiming
one.

**A bucket key is untrusted input to the phone's filesystem.** Obsidian, an AI
client, a teammate or the provider's own console can write `../../Library/x.md`,
and joined onto the document directory that is a write outside the mirror. Every
segment is therefore encoded (`mirrorPath.ts`) to an alphabet with **no separator
and no dot** — lowercase letters, digits, `-`, `_XX` — so there is nothing left
for a filesystem to interpret. The escape is `_` rather than `%` because
`expo-file-system` addresses files by URI and a URI layer may percent-decode:
with `%`, whether `%2E%2E%2F` reached the disk as nine characters or as `../`
would depend on native decode behaviour no test here can see. `_` means nothing
to a URI, and every name is pinned to survive `decodeURIComponent` unchanged. Uppercase is escaped too, because `Plan.md` and
`plan.md` are two notes and one file on a case-insensitive filesystem; names past
200 characters are hashed into a `~`-prefixed form the short form cannot produce.
Each body record carries its own path and etag, and a read that finds another
note's record (a hash collision) is a miss.

**The sign-out barrier is inside the store.** A first sync is minutes of reads,
each followed by a write, and checking the epoch in the caller leaves a gap
between the check and the write. So every mirror write carries its session's
epoch and `guardMirror` compares it inside one serial queue that `clearAll` runs
through too. `forgetLocalCopies` ends the epoch before it enqueues the clear, so
a sync write is either ahead of the clear (and removed by it) or behind it (and
refused) — never between.

#### The sync, and the prune rule

Per context, at the clearance `visibilityTierForRole` gives: page `syncManifest`
until its cursor is `null`; fetch what is new, changed, or listed with no etag
("the store gave none" is never "unchanged"); `readNotes` in batches of at most
fifty with two in flight, re-asking what was `deferred`; skip keys ending in `/`.
Contexts one after another, for the reason `drainAll.ts` drains queues one after
another — every call is a round trip on the customer's request quota. Fetched
notes are committed in hundreds, not per batch, because every commit rewrites the
index. It runs on start once online, on reconnection, on return to the
foreground and every five minutes in front of somebody; single-flight; from the
**live** context list only, because a remembered list is a memory and this is the
thing that prunes; never for an `unknown` tier, which downloads and deletes
nothing; and every Convex action is wrapped in a timeout, because `action()` has
none and "online" can be a captive portal.

**Prune only after a complete listing.** A manifest page that says `truncated`,
a page that failed, a cursor that did not move, a read batch that failed — each
makes what arrived a floor rather than a list, and a path missing from a floor is
evidence of nothing. When the listing was complete, every note not in it leaves
the device, body, ancestor, and the names of folders with nothing left under
them. **That rule is what closes the gap the read cache had**, where a group grant
lost on another machine left the notes it covered readable on this one until an
age bound reached them: every complete sync re-derives, from the server's own
`canSee`, what this device may hold. A `FILE_NOT_FOUND` from `readNotes` is an
answer about that path and drops it even from an incomplete run.

#### The ancestor rule

A three-way merge needs the body at the version the draft was typed on
(`draftBase`, `RestoredDraft.baseEtag`), and `offerMerge` refuses anything else
(see "The merge is real, and it is refused rather than faked"). The read cache
kept that ancestor by accident — nothing overwrote a copy nobody reopened — and a
mirror overwrites every changed note on every sync, so without a rule it would
destroy exactly the ancestor a queued edit needs, on the reconnection about to
conflict it. So: **before a body is replaced, it is copied to a `base` slot
whenever some local work is based on its version.** "Local work" is the queue and
the drafts on the device *and* what the running console holds but has not written
down (`mirrorHolds.ts`): the live queue, which the store trails by
`PERSIST_DEBOUNCE_MS`, and the open editor's etag and draft base — a note can sit
open and clean for ten minutes while a sync moves the copy on, and the draft
typed after that is based on the version on screen. The base goes when nothing
needs it, and always when the note turns out to be ciphertext: an ancestor of an
encrypted note is plaintext the device was asked to stop holding.

An online open goes through the same writer, which fixes an older loss: the read
cache overwrote the ancestor whenever a note with a parked write was reopened
online, so that Merge was refused with "moved on" even before the mirror existed.
The conflict review asks `ancestorFor(path, draftBase)` rather than for the
newest copy, which is exactly what an ancestor is not once the bucket has moved.

#### Serving it

Offline, a note and a folder listing come from the mirror — any note, any
folder, opened before or not; listings are derived from paths, with a folder's
badge from the last listing that named it, else from a note directly inside it
(whose `inherited` *is* that folder's rule), else a guess, because the privacy
rules are not on the device. "Open it once with a connection" is still what a
context with nothing mirrored says. Online, a read gets 250ms; past that the
mirror's copy is shown marked as a cached copy and replaced when the bucket
answers — unless the person has started typing (their draft is based on the
copy's version, and the hold keeps that version as the ancestor), unless there
is a queued write or draft to restore (those opens wait, so `restoreFor` runs
once), and never over a refusal (the editor closes). A save that lands and a
drained write move the mirror onto the version now in the bucket.

On a device with a mirror the per-note/per-listing read cache is **retired, not
kept beside it**: two stores answering "what is this note offline" can disagree,
and the older one is exactly the one a lost grant could leave readable. Its
copies are adopted into the mirror once (only where the mirror has nothing, so a
copy that is the ancestor of an edit queued before the upgrade keeps its Merge)
and removed. A browser without a mirror keeps the bounded cache unchanged.

#### Saying it

`mirrorStatus` per context — `syncing | synced | partial | unavailable | never`,
with notes, bytes, last sync, remaining and why — and `mirrorLine` words it: "All
1,204 notes on this device · synced 2 minutes ago", "Downloading 340 of 1,204
notes…", "Only part of this context is on this device — 12 notes not
downloaded". It rides in `SyncFacts.mirror`: a quiet segment in the desktop
strip, the last block of the phone's sync sheet, and "Offline" says every note
is here exactly when the mirror says so. **A whole mirror is never a warning**,
and an incomplete one warns only while offline, so a synced phone never grows a
pill and a context too large to list is not a permanent alarm.

Sign-out clears the whole mirror (verified by re-listing, as the cache is);
leaving clears that workspace; a membership that ended elsewhere clears it on
the next live list, through the same hooks as the cache.

#### What a simplification costs, and what fails

- Joining a note path onto the filesystem unencoded writes outside the mirror.
  "a traversal key stays inside the mirror" (`offlineMirrorStore.test.ts`).
- Comparing the epoch outside the store's queue lets a sync write land behind a
  sign-out. "a write queued behind a sign-out is dropped", and — with the
  engine's own checks also removed — "a sign-out during a sync leaves nothing"
  (`offlineMirrorSync.test.ts`).
- Pruning on a truncated or interrupted listing deletes notes that are still
  there; not pruning on a complete one leaves a lost grant readable. "a
  truncated manifest prunes nothing", "a manifest that fails part-way prunes
  nothing", "a note that left the manifest leaves the device".
- Syncing an `unknown` tier, or filing under the wrong workspace. "an unknown
  tier touches nothing", "each context's notes are filed under that context".
- Dropping the ancestor rule, the holds, or asking the online open without
  them costs the Merge. "the version a queued edit is based on survives the sync
  that replaces it", "a note that became encrypted keeps no plaintext ancestor",
  and, through the real console, "a queued edit still gets a real merge after a
  sync moved the note on" and "an online reopen keeps the ancestor a parked
  write needs" (`offlineMirrorConsole.test.ts`).
- Replacing typed text when the slow read lands, or showing the copy over a
  refusal. "typing into the copy is never replaced…", "a refusal takes the copy
  away".
- Clearing the cache but not the mirror on any ending. Each test in
  `offlineMirrorForget.test.ts`.
- Toning a whole mirror `warn`. "a complete mirror is quiet even offline", "a
  synced phone grows no pill" (`offlineMirrorStatus.test.ts`).

**What this does not do, and what needs a device.** Attachments are listed and
never downloaded, and empty folders are not offline (the manifest lists notes).
One ancestor is kept per note. A note pruned because it was deleted or became
invisible takes its ancestor with it; a queued write to it is refused or
conflicted by the server as before, without a Merge. Two web tabs share one
database with separate queues, so concurrent syncs can lose one tab's index
update to the other — repaired by the next sync, since a missing entry is
re-fetched, not trusted. The index is one JSON document per context, read on
every offline open and rewritten per commit: fine at thousands of notes, worth
splitting per entry if contexts reach tens of thousands. A crash between a body
write and its index commit leaves an unreachable body until the workspace is
cleared. The document directory is included in device backups, as
`AsyncStorage` already is. And all of the native half runs in tests against a
fake `expo-file-system`: `Directory.list()` naming, and write throughput on a real iPhone and
Android device are unverified until somebody runs a first sync on one.

### The file tree is drawn from the mirror's metadata, so a folder opens without a request

Clicking a folder in the sidebar used to wait on `listFiles`: membership,
storage, a read of `privacy.md`, then a provider listing, every time a folder
had not been opened in this session — 200 to 800 ms on staging for folders of
three entries. The mirror already held every visible path on the device, and
the online tree did not use it. Now it does, and the tree is metadata, kept
apart from bodies.

**The manifest names the folders, by `listFolder`'s own test.** `syncManifest`
returns `folders`: every folder the walked keys live under that
`folderVisibleAtScope` keeps, with `visibilityOf` as its default, the root
first. It is derived from every key the page walked, hidden ones included —
which is what `listFolder`'s delimited prefixes are — so it names a shared
folder whose only notes are held back, and an empty folder a tool made with a
marker key, and it names nothing a listing would not. The test walks
`listFolder` from the root for owner, team and a group member, and requires
the manifest's folders and defaults to equal it exactly, in one page and in
pages of two keys.

**Metadata is committed before any body is read, for every context.** The
sync walks each context's manifest and commits its paths and folders to the
index first; a note new to the device is an entry with `body: false` — drawn
in the tree, never served as a note (`mirroredNote` requires a body), never
counted as on the device. `syncAll` lists every context before downloading
any, so the second context's tree no longer waits on the first context's
bodies, and the context somebody opened is listed first. Opening a context
also asks for a metadata-only walk of it outside the sync's single flight
(`requestMirrorRefresh`), so it never waits behind a download either.

**A walk only moves the tree forward.** Two walks can overlap — the five-minute
pass and the refresh opening a context asks for — so the index records when
its listing started (`listedAt`), and an older walk neither commits over a
newer one nor, at the end of its downloads, prunes or rewrites entries the
newer one corrected. The console applies the same rule per folder: a
committed walk replaces a folder only if that folder's own live listing
started before the walk did, so a note this console just created does not
vanish under a manifest walked a moment earlier.

**On entry the device's tree is drawn at once, and the bucket confirms it.**
`useFileBrowser` reads the whole tree from the index in one pass (`treeOf`,
a parent-to-children map built once rather than a scan per folder), fills
every folder the bucket has not answered yet, and stops showing "Reading your
bucket…". The root listing still goes out and replaces the root; every later
committed walk redraws the tree (`onMirrorListed`), which is how a folder
somebody else made appears. A complete walk drops folders it no longer names;
an incomplete one only adds. A refusal takes the device's rows down: a
refused root clears the whole tree, a refused folder its own listing —
repainting a listing after a refusal discloses exactly what the refusal
withheld, and drawing it *before* one must not become the way around that.

What a simplification costs, and what fails:

- Deriving folders only from visible keys, or without
  `folderVisibleAtScope`, loses held-back folders or names private ones. "for
  team / a group member, exactly the folders … walking listFolder would draw"
  and "a team reader is named no private folder" (`offlineSync.test.ts`) fail.
- Committing metadata only at the end of a sync puts the tree behind the
  downloads again: "every listed path is in the index, bodiless, when the
  first read goes out" and "every context's metadata is listed before any body
  is read" (`offlineMirrorSync.test.ts`) fail.
- Letting an older walk prune fails "an older walk does not undo a newer
  one"; letting it replace a newer live listing fails "a walk older than a
  live listing does not undo it" (`fileTreeMetadata.test.ts`).
- Drawing only the root from the device fails "a nested folder opens from the
  tree without asking the bucket"; not redrawing on a committed walk fails "a
  folder somebody else made appears without a reload"; keeping device rows
  after a refusal fails "a refused context shows none of the device's tree".

**What this does not do.** The redraw is only as fresh as the last walk: the
five-minute pass and the walk opening a context asks for. Pushing a hint when
somebody else writes is the next change, and it rides this path — a hint
triggers a walk, and the walk is what redraws. A walk is a whole-bucket
listing, so a context of tens of thousands of keys costs that many listed keys
per walk; a truncated walk leaves missing folders to `listFiles` as before, and
never reads an absence as a deletion. The device's tree is keyed by workspace
and clearance, not by storage binding, so a context reconnected to a different
bucket shows the old bucket's folders until the root listing and the first
complete walk replace them — seconds, and only to somebody who could see both.

### Offline is more than saving: create, rename, move, delete

The owner's requirement is that people can *take notes* offline, the way they
can in Apple Notes or Obsidian. Until this section, only saving an existing
note's text was queued. New note, new folder, rename, move, archive and delete
all went through `run()`, which has no offline branch: it waited
`OPERATION_TIMEOUT_MS` (45 seconds) on a Convex action that never answers
offline, then said "it may still have gone through — check the list" about a
request that certainly had not. Creating a note is the core of taking notes,
and it was the one thing a phone on a train could not do.

**One queue, not a second one.** The outbox gains `ops` beside `writes`
(`PendingOp`: `move` — which is both rename and move, as `moveEntry` is —
`archive`, `trash` and `folder`). Everything `outbox.ts` and `sync.ts` already
promise holds for ops unchanged: one sequential drain, the transient-code
allowlist, `MAX_ATTEMPTS`, a conflict parked for a person and never retried by
itself, nothing evicted, the epoch barrier, sign-out wiping the record (it is
the same record), the per-workspace sender. `queuedOpSender` sits beside
`queuedWriteSender` in `queuedWrite.ts` and is bound the same way — to the open
context by the file browser, to each queue's own context by `drainAll` — so the
cross-tenant property the background drain was built around covers ops too.
The record's `version` was deliberately **not** bumped: `parseOutbox` discards
a record of another version whole, so bumping it would throw away every edit
the previous build had queued on first launch. An absent `ops` reads as none;
the cost runs the other way — an older build that rewrites the record drops its
ops and keeps its edits.

#### A note created offline is a create, made later

`createNote` offline enqueues a write with `baseEtag: null` — the form the
queue already had for "this note did not exist" — and opens it at once. The
editor holds it with `etag: null` (the `opened` action's `unsent`), so every
save of it is a create too, and what drains is `writeNote` with no
`expectedEtag`: the server's atomic create (`onlyIf: { absent }` where
`conditionalCreate` is proven), which refuses with `CONFLICT` if a note
appeared at that name meanwhile. That conflict is parked like any other and
answered by the existing resolver; its Merge is refused with the sentence it
already has for a note that did not exist, because a create has no ancestor.
Renaming a parked create is also an answer — "call mine something else" — and
is the one way a parked entry goes back into the queue without the resolver:
because a person pressed it. Name collisions are refused locally against the
listings as drawn, which include the queue's own new notes. New drawings stay
online-only and say so: the phone's drawing editor is never kept offline
(`drawingOffline.ts`) and the web's only once a drawing was opened online, so a
drawing made offline could open as a picture nobody can draw in.

A new folder is `createDirectory` made later — the server makes a folder real by
writing its README placeholder, so there is nothing to invent — and a
`DESTINATION_EXISTS` on drain is the folder that was asked for, not a problem
for somebody to answer.

#### Every op carries the version it was asked about

A rename typed on a train is a decision about the note as it was on the train.
Sent blind, a rename of a note somebody rewrote in Obsidian meanwhile would
carry their newer text under a name chosen for something else, and a queued
delete would put it in the trash without anybody who asked being told. So
`moveEntry`, `archiveEntry` and `trashEntry` now take an optional
`expectedEtag` and answer `CONFLICT` with the current etag when the note moved
on — compared after the visibility check, so a hidden note is still
not-found and its version never leaves the server. Atomic where the bucket
proves both `conditionalCreate` and `conditionalDelete`, a read-compare where it
does not (the check an online save gets on such a bucket); the plugin runtime's
rename keeps refusing weak buckets through `requireAtomic`. Absent
`expectedEtag` is exactly the online press it always was — it is optional, not
a force flag, and **the client never sends an op on a note without one**:
`queuedOpSender` refuses a versionless op locally rather than send it
unchecked. A single-note move now returns the note's etag at its new path
(after any self-link rewrite), because the queue's next op on that note must
be checked against what its own rename produced.

The version an op carries moves in exactly one way — `rebaseOp`, onto an etag
the bucket returned *to this queue* for the same note: the note's edit landing
ahead of it, or a rename of it landing ahead of it. Never a fresher read, which
is `enqueue`'s rule restated for ops. A parked op offers "Do it anyway", which is
`forceMine`'s shape — re-based onto the version the conflict reported, still
conditional — and "Discard"; a refused one offers "Try again" and "Discard".

A folder rename, move, archive or delete is refused offline in a sentence.
A folder has no version, its notes can change on other devices while this one
is offline, and a folder-wide op sent hours later against a tree nobody
re-checked is last-write-wins across a subtree.

#### Order, and what is coalesced

The drain goes one **note** at a time (`drainUnits`, grouped by bucket path):
its edit first, then whatever was asked of it. The edit goes before a rename so
the rename carries the new text and is checked against the version the edit
produced; before a delete so what is in the trash is what the person last
wrote. A note whose edit is parked or refused has its op held back — not
charged, since nothing reached the bucket. Between notes the order is the order
things were asked.

An edit of a note renamed on this device is filed under the **bucket's** name
for it (`serverPathOf`), which is what makes "rename, then edit under the new
name" drain as edit-then-rename rather than as a write to a path the bucket has
not heard of; the console shows it under the new name (`localPathOf`), and
anything done to such a note — even online — goes through the queue
(`routesThroughQueue`).

Coalesced where it is safe, and only while no drain is running:

- a create renamed before it went is one create at the new name;
- a create deleted before it went is nothing sent — its text handed back to the
  toast's undo, the only way back to it;
- a rename of a pending rename is one move; renamed back, no op at all;
- a rename then a delete is a delete of the original.

A create then an archive is both, in order, because an archive keeps a note and
the note has to exist first. While a drain is on the wire nothing already
queued is rewritten — rewriting a create that is being sent would make two
notes — so an op queued then waits behind what it would have folded into, with
no version of its own (`baseEtag: null`), and the landing ahead of it supplies
one, in the drain or in `reconcile` afterwards. More round trips, the same
result.

**A name the queue is holding cannot be reused by a different note until the
queue drains** (`claimedPaths`). Delete `plan` and create a new `plan` offline,
and the order across two notes becomes load-bearing: the create sent first is a
conflict with the note the delete had not removed yet. Refusing the second
`plan` in a sentence is rare and says what to do; it is also the rule that lets
the drain treat every note as independent of every other.

#### What a person sees

The tree is the bucket's listings with the queue laid over them
(`overlay.ts`): a new note or folder appears, a renamed note is at its new name
with its own entry (exception included), a moved one has left one folder for
the other, a deleted or archived one is gone. A view, not a write into the
mirror: the mirror is pruned against the server's manifest on every complete
sync, and intent written into it would be deleted by the first sync that ran
before it was sent. A parked op is still drawn where the person put it, with
the `crit` mark, because drawing it back at the old name would read as the
rename having been lost. The overlay is recomputed only when the queue's shape
changes (`overlayKey`), never on a keystroke into a queued note.

`pendingMarks` marks the row an op left behind; the phone's sync sheet lists
every op in plain language — "Rename plan → plan-2026 · waiting to sync",
"Delete old-notes · needs you", "New folder: Trips", and a new note's row reads
"New note: Groceries" — with the answers on the parked ones. Each queued op
toasts with an undo that restores the queue exactly as it was before the press,
and says so plainly when it can no longer (the op is on the wire or landed).
**The sheet is reachable on every layout**, because its rows are where a
parked op is answered: a phone opens it from the pill, and a pointer layout
from the status strip's sync segments ("Offline", "2 notes need you", "3 notes
waiting to sync"), which are buttons for exactly that and are the only segments
that are — the rest are measurements. The same sheet, centred at a phone's
width, rather than a desktop surface with its own copy of the rows and answers.
Marked and counted but unanswerable would strand a change with no way to act on
it (`desktopSyncAnswers.test.ts` fails if the strip stops opening it).
Counts include ops, so the strip, the pill and the sign-out warning count a
waiting rename as something not in the bucket, and sign-out's warning now says
"changes" rather than "edits". Any other operation asked for offline — a
duplicate, a paste, a visibility change — is refused at once with a sentence;
the 45-second "it may still have gone through" is now only for a device that
believed it was online.

After a drain that created notes or landed ops, the folders involved are read
again, a created note is written into the mirror (badged with its folder's
default until the next sync answers — `private` when unknown, so a guess never
claims a note is shared), and a renamed note's mirror copy moves to its new
name, so none of them blinks out of an offline tree in the window before the
next sync.

#### What a simplification costs, and what fails

- Sending an op without its version, or dropping it "to get things through":
  "it is never sent without the version it was asked about"
  (`offlineFileOps.test.ts`) and, server side, the conflict tests in
  `apps/convex/__tests__/offlineFileOps.test.ts` and "a queued rename or delete
  of a note that changed is a conflict…" (`files.test.ts`).
- Binding the op sender to the open context: "every rename names the context
  its queue is filed under…" (`offlineDrainAll.test.ts`).
- Sending an op past its note's parked edit: "its note's parked edit holds it
  back, uncharged".
- Filing an edit of a renamed note under its new name: "renamed, then edited
  under the new name: the edit goes to the old name first, then the rename"
  (`offlineFileOpsConsole.test.ts`).
- Removing an ops-only queue's record: "a queue holding only a rename is written
  down, and read back as it was".
- Letting offline creates go through `run()`, or dropping the overlay, or the
  offline guard in `run()`: each fails its own tests in
  `offlineFileOpsConsole.test.ts` (sabotage-checked).

**What this does not do, and what needs a device.** Folder rename, move,
archive and delete stay online-only.
Archive's destination is decided by the server's privacy rules, so an archived
note simply leaves the tree offline and reappears in the archive after the
next sync. A rename that lands and was dropped mid-flight is answered by
queueing the rename back; a delete that landed cannot be taken back from here
and is not pretended to have been. Offline search reads the mirror, so a note
created offline is not found by it until the create has landed and been
mirrored, and a note renamed offline is found under its old name until then.
Two web tabs hold separate live queues over one store, as before. And all of it runs in tests against fakes: the queued
create, rename and delete on a real phone going through a tunnel is unverified
until somebody does it.

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

### A folder's placeholder is not a row

Object storage has no folders, so `createFolder` writes `README.md` to give the
prefix something to be. That file then appeared as the first row of every folder
the console drew — above whatever anybody had actually written, on the surface
with the least room for it, and on a screen whose whole argument is that a
folder is somewhere you are rather than a settings panel. The owner's report was
"I don't love that creating a folder puts an overview page in it".

**The console does not list it, and the bucket still holds it.** `listedEntries`
drops it and both surfaces call that one function — the tree and the folder
page are one listing shown twice, and a file that is a row on one and absent on
the other is worse than the row it was hiding. `loadedCounts` skips it for the
same reason: that line is read against the rows on screen, so counting a row
nobody can find prints one note more than anybody can go and look at. Obsidian,
`ls`, rclone and the gateway are unchanged, which is the point — the file exists
*for* them.

Three boundaries carry the argument, and each is a test:

- **Never at the root.** The root prefix needs no key to exist, so a `README.md`
  beside `index.md` was put there on purpose — very probably by whoever
  self-hosted the bucket — and hiding it would be hiding content.
- **The open note is always drawn.** A placeholder reached from search, from a
  `[[link]]` or from a restored tab is the thing you are looking at, and a tree
  that draws a selection it does not contain is worse than one extra row. It
  goes back to being unlisted when you leave it.
- **Names, never contents.** A listing carries names; asking the bucket for every
  README on every expand would be a request per folder to decide a row. The
  honest cost is that a folder overview somebody really wrote is hidden too.
  Nothing becomes unreachable — search finds it, a link opens it, Obsidian never
  hid it — and if that cost turns out to bite, the fix is to render the README as
  the folder page's own introduction rather than to put the row back.

The body changed with it. It used to be `# <folder name>`: the opening line of a
note somebody had started, on a file nobody wrote. The only readers left are the
tools the file exists for, and to them an empty overview page reads like a task,
so it says what it is instead — `renderFolderPlaceholder`, exported so the copy
is pinned by a test. `NEW_FOLDER_HINT` still mentions the file at the moment the
folder is made, because a README turning up in somebody's vault that the app
never mentioned is worse than one line of explanation.

What is deliberately **not** changed is the share card. `previewChildrenFrom`
holds at most three names and would waste one on a placeholder, but the argument
in that function is that it adds no filter the privacy engine did not compute,
and a presentation rule is a poor first exception to it. It can move later, as
its own change, with its own test.

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

**Following a link is one click, and two gestures reach the text instead.**
⌥-click places the caret and navigates nothing; so does a click on a link that
is already showing its source, because live preview unfolds the link the
selection touches and clicking text puts a caret in it. A ⌘-click (Ctrl off an
Apple keyboard) or a middle-click opens the note **behind** the one on screen.
On a phone a tap follows and a long press is a selection again. The tooltip
names the target note instead of teaching a keystroke.

*This reverses the rule that stood here until 2026-09-19, and the reversal is
the argument rather than a change of taste.* What stood here was: following is
⌘-click, a plain click still places the caret, because this is an editor and a
mistyped path lives inside a link — an implementation that followed a plain
click reads as working and has made those characters unreachable. The premise
is still true and the conclusion was wrong, because it rested on a click being
the *only* way to reach a link's text. It is not: ⌥ reaches it and a caret
already inside it reaches it, and both are cheap. What the old rule spent to
protect those characters was the gesture everybody already has — so the feature
had to announce its own chord in a tooltip to exist at all, which is the shape
of a feature nobody finds. The owner, reporting it: "I should be able to go to a
link just by clicking it once, similar to obsidian, shouldnt have to command
click."

The long press went with it, and that deletion is worth as much as the click.
A press is also how a selection starts, so it could not navigate on its own —
it raised a confirmation, and to arrive at all it had to be told apart from a
scroll *and* from WebKit's own long-press recogniser, which claims a stationary
touch and announces it by sending `touchcancel`. That cost a timer, a cancel
floor, a `contextmenu` handler, a rule about which of two signals fires first,
and a dialog in front of all of it. A tap is over before any recogniser has an
opinion and is not ambiguous, so the whole apparatus is gone and the platform
has its long press back.

**A followed link opens a pinned tab, immediately right of the tab it came
from.** Following used to go through `files.select`, which opens a *preview*
tab — the one the next selection replaces — so following A → B → C left one tab
and nothing behind to come back to. Pinned because a followed link is a
destination rather than a glance; beside its source because the note you were
reading and the note it sent you to are one train of thought. ⌘-click opens it
without moving the selection at all, which is what "behind" has to mean.

**`‹ ›` are drawn at every density.** `history.ts` has held the stack since the
phone's toolbar was built, and `ConsoleBottomBar` — the only thing that drew
them — renders at `compact` only. So on a desktop the console kept a complete,
correct, tested history of where somebody had been and offered no way to walk
it: the route with no way in, again. They sit at the head of the note's path,
where a browser and Obsidian both put them. The phone keeps them in the bottom
bar and the breadcrumb draws neither there, because two of one control on a
390pt screen is what the second drawer toggle was deleted for being.

**A navigation pushes `?note=`; a correction replaces it.** Every write was
`setParams`, which replaces — so every note had its own URL, the app wrote those
URLs as you moved, and the address bar was still a label on the current screen
rather than a record of where anybody had been. The browser's own back button
left the console from the third note as surely as from the first. A push is a
real `router.push`, the same call an activity link already made, and it is web
only: a push on a native stack is a *screen*, and four followed links would be
four panes stacked on each other.

The cost is a remount: `Slot` is a `StackRouter`, so a pushed address is a new
route entry and `BrowsePane` is rebuilt. What that loses is the note scroller's
offset, which the arriving note replaces anyway; the tree, the listings, the
tab strip and the open draft all belong to the layout, which does not remount.
A push also only happens while the address is carrying nothing but a context
and a note, because it rebuilds the address from those two and would otherwise
drop a `?settings=` beside them.

What tells a navigation from a correction is `FileBrowser.navigations`, a
counter bumped by a `select` the unsaved-changes guard allowed. The selection changing is not
enough on its own — a rename moves the path under the open note, and pushing
that would leave a history entry naming a path that no longer exists. Nobody
navigated when the last tab closed either, and a back button that returns to an
empty pane is worse than one that skips it.

**An arrival at a neighbouring place moves the cursor rather than appending.**
`history.ts` now has `arrived` beside `visited`, because the address bar is a
second history over the same places: the browser's back changes `?note=` under
the console, the note it names is opened, and that arrival reaches the same
effect a click does. Recorded as a fresh visit it would truncate the forward
tail, so the browser could go back and `›` could never go forward again. The
cost is stated rather than discovered: deliberately navigating to the note you
were just on — clicking it in the tree rather than pressing `‹` — now moves the
cursor back instead of appending a third entry, so `›` afterwards returns to the
note you left. A browser would have appended and its forward would be dead;
this is the better of the two, and it is the one that keeps `‹ ›` agreeing with
what the address bar just did.

Settings sections and app panes are places in `history.ts` and are *not* pushed,
because `?settings=` is written with `setParams` — so the browser's back may
skip a settings section that `‹` walks. Two stacks that agree about notes and
differ about an overlay, honestly, beats one that lies about either.

**The editor does not check that a link's target exists**, and that is forced
rather than lazy: the tree loads folder by folder, so the console knows the
notes somebody has expanded and nothing about the rest. Requiring existence
would render a link into an unexpanded folder — the normal case — as plain
prose. Following a link to a note that is not there lands on the editor's own
"that file does not exist", which is the answer Obsidian gives.

What a simplification would cost, and the test that catches it: dropping the
`canSee` filter is two failures in `linkRewrite.test.ts`; substituting instead
of recomputing relative links is one there and three in the gateway's
`links.test.mjs`; and letting the two engines drift is two in
`linkParity.test.ts`. On the gestures: dropping the ⌥ check is two failures in
`editorLinks.test.ts` and dropping `hasFocus` from the caret check is five;
opening a followed link without honouring `select`'s refusal is one in
`tabsContextSwitch.test.ts`; pushing every URL write rather than only a
navigation is six in `noteAddress.test.ts`; making `arrived` an alias for
`visited` is three in `noteHistory.test.ts`; and taking `‹ ›` back out of the
breadcrumb is four in `browseHistoryButtons.test.ts`.

### A web link opens on a click, and only a web scheme opens

"Clicking on a [regular](link.com) does not work." It did not: the editor
followed links to other notes and nothing else, so `[site](https://…)`,
`<https://…>` and a bare `https://…` were drawn as links and a click put the
caret in them.

**A web link now follows on the same click a note link does**, with the same
two ways into its text (⌥-click, or clicking a link already showing its
source). It opens in a new tab on the web — `noopener`, because this tab holds
somebody's notes — and in the person's real browser from the desktop shell,
whose `setWindowOpenHandler` already allowed only `http(s)`.

**What opens is allow-listed in one place, `webUrl.ts`: `https:`, `http:` and
`mailto:`.** Every host this string reaches acts on `javascript:`, `file:` or
another app's scheme. A target with no scheme is a web page only when its host
ends in a short list of TLDs — `[site](example.com)` is how people write one,
and CommonMark reads it as a relative path — and the list leaves out the TLDs
that are also attachment extensions (`.ai`, `.sh`, `.app`, `.me`), because
"anything with a dot" would claim `report.pdf`. `webUrl` never calls `new URL`:
the native host re-checks the guest's answer by calling it again and comparing,
and React Native's `URL` disagrees with a browser's (it appends `/` to
`mailto:`).

**On a phone, opening one is asked about first, naming the address.** The
`open-url` message is the one thing the WebView sends that leaves the app — the
channel `NAVIGATION_ORIGINS` exists to keep shut — so a script in the WebView
that should not exist must not be able to post a note to a URL nobody read.
The host re-runs the allow-list, and `LiveEditor.tsx` shows the sheet.
Removing the sheet to save a tap reopens that channel.

`webLinks.test.ts` pins all three: the allow-list (three failures if it accepts
any scheme), the host's re-check (one), and that the note resolver no longer
claims `[x](example.com/page)` as a missing note (one).

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

### Reassurance is a chip in the top bar; a decision is a button over the note

Autosave removed the *reason* for the Save button and left the button. The
report, from somebody writing a note:

> whenever I type in the note, this big ugly save button appears, any way where
> it can not appear there and just show in the top right where it shows "R2
> managed" that its saving or failed to save or something

Both halves are right. `dirty` is the state every keystroke produces, so
"Discard changes" and "Save" appeared across the foot of the document on the
first character and stayed until the write landed — two controls over somebody's
own text, for a write that was already scheduled. Neither was load-bearing: ⌘S
and the autosave timer make the same conditional write, and Discard in `dirty`
could only ever reach back to the last autosave, which is what undo is for. And
the surface that *could* have said it quietly was saying it in the bottom-right
corner, in 11pt grey, between a word count and a bucket name.

**So the two jobs were split by whether a person has to do something.**

- **Nothing owed** — typing, saving, saved, a cached body, a queued draft
  draining on its own — is `saveChip` (`status.ts`), drawn in the top bar
  beside the storage pill and nowhere else. Same words, same tones, same
  details as the strip segment it replaces: "Saving soon", "Saving…", "Saved",
  "Cached copy", "Queued", "Not saved", "Conflict".
- **A decision owed** — a save that failed, a conflict, a queued draft
  somebody may want to let go — keeps `NoteEditor`'s row, with the full
  sentence beside the buttons at *every* density. Those messages are
  paragraphs ("Still waiting on your bucket, so we stopped waiting…") and a
  two-word chip cannot hold one. `editor.ts` has always said the manual route
  must stay reachable exactly where autosave refuses, and it is.

**The claim moved rather than multiplied**, which is the same rule that took
the disabled Save pill off the row and then took the durability sentence off
the pointer layout: one claim, one surface. The strip keeps what is
*measured* — the note's key, the word count, the index, how writes are checked,
the bucket — and gives up the one fact in it that changed while you typed. The
phone is untouched apart from losing the buttons: it has no top bar chip and no
status bar, so the sentence at the foot of the document is still its only save
claim, and Save is still `check` on its toolbar.

**Why the top-right and not somewhere calmer.** It is where the bucket chip
already is, and the two answer one question between them: where the note lives,
and whether it is there yet. It leads that group because it is the only chip in
the bar whose text changes while somebody types, and in a row aligned to the
trailing edge the leading item can grow without shifting its neighbours.

**What a reversal costs, and the tests that fail.** Putting the Save row back
in `dirty` fails "typing puts nothing over the note"
(`offlineEditorRender.test.ts`), which mounts a mid-sentence draft at 1440 and
asserts that neither button is on screen; putting the segment back in the strip
fails "the strip does not carry it" (`status.test.ts`), which is what stops the
console saying "Saved" at both corners at once; dropping the row in `error` or
`conflict` fails "a failed save keeps its Save, and a conflict keeps its
Overwrite", and dropping the sentence with it fails "a failed save explains
itself at a pointer width" — the case that keeps the reason for a failed save
reachable now that the strip no longer carries it as a tooltip.

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

> **Superseded for tables** by "A grid is edited in place, and the unit that
> reveals is the cell" below, which reverses exactly the paragraph this section
> ends on. It stands unchanged for the other two blocks, and the argument here
> is what the reversal had to answer.

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

*(That reversal happened, for tables and for tables only. The next section is
the answer to this paragraph — there is no serializer, because the cell you are
in shows its own characters.)*

### A grid is edited in place, and the unit that reveals is the cell

A table in a note being written was a paragraph of pipes for the whole of the
time anybody was working on it, and the section above says why: the grid was
gated on `state.readOnly`, so a table rendered only once you had stopped
editing. The complaint is the obvious one, and it came with the obvious
reference — Obsidian draws the table while you type in it.

So tables are now drawn in **both** modes, and what the eye takes away is not
the grid, it is the typing. A read-only note's cells are drawn and not
editable, which is `editability`'s own rule about a control that could only
ever fail.

**The reveal rule was right about the flicker and wrong about the unit.** The
old argument was that "a grid that gave way on selection would flicker between
two layouts as somebody arrowed along a row", and it would — if the unit that
reveals is the *table*. It is the **cell**: the one with focus shows its own
markdown and every other cell stays drawn, so `**bold**` is in the cell you are
in and **bold** is in the one beside it. That is this editor's central rule
about `## Heading`, applied one level down, and nothing flickers because
nothing around the caret redraws.

**And that is the whole answer to "it needs a serializer".** It does not. The
focused cell's text *is* the source, so writing it back is a change to the span
between two delimiters and nothing else in the file is read, let alone
rewritten. `tableEdit.ts` is where that promise is kept and it holds no model
of a table: every function takes a range of the document and the characters
somebody typed into that range. A hand-aligned table stays hand-aligned in
every cell except the one being edited — pinned by *a hand-aligned table keeps
its alignment in the cells nobody touched* in `apps/mobile/__tests__/tableEdit.test.ts`.

The three characters that cannot be in a cell as themselves are handled at the
keystroke rather than refused: a typed `|` is escaped (a keystroke that
silently splits the row into a new column is the table breaking under the
person editing it), a pasted newline becomes the `<br>` the cell reader already
draws, and the outer spaces are padding rather than content.

**The structural edits exist because the source became unreachable.** Once a
table is always drawn, the pipes are no longer somewhere a person can go and
fix — there is no source mode in this editor, only reading and writing. A grid
that could not gain or lose a row would be a grid you had to leave the app to
repair. So an editable grid carries four controls, pinned to its own frame and
revealed on hover or focus: add a row, add a column, delete a row, delete a
column. The two deletions stay **disabled until a cell has been focused**,
because "delete row" with no row named has to guess and the guess is a row of
somebody's note. Tab past the last cell and Enter on the last row add one too,
which is how a table gets longer without anybody reaching for a control.

**What this costs, stated rather than discovered:**

- **CodeMirror's caret is not in the cell.** Focus is in a `contenteditable`
  element of the widget's, so `view.hasFocus` is false while somebody is typing
  in a table — which is deliberate, because it is what stops CodeMirror drawing
  its own selection over the top. Escape hands the note back with the caret
  after the table.

  This one is **closed rather than stated** now, and the way it was closed is
  the reusable part. `toggleWrap` asks `toggleMarkerInCell` first, so Bold from
  the keymap, from the phone's accessory bar and from the right-click menu all
  reach the cell that has the caret; the decision is `planToggle`'s either way,
  so the CommonMark run rule that makes ⌘B and ⌘I compose is the same one a
  paragraph gets. `planToggle` and the marker pairs moved to `markerToggle.ts`
  to make that possible without a cycle — `markdownFormat.ts` imports
  `livePreview.ts`, so the shared half could not stay where it was.

  The **chords** need one more thing, and a browser is what said so: a unit
  test that calls `toggleWrap` directly passes while ⌘B in a cell does nothing,
  because `ignoreEvent` tells CodeMirror every event inside the widget is the
  widget's and the editor's keymap therefore never sees a keystroke made in a
  cell. That is right for Tab and Enter and leaves the chords with nobody to
  answer them, so the cell answers them itself from the same three-row table.
- **A column GFM invented for a short row is drawn and not editable.** There
  are no characters in the file for it, so there is nothing for a keystroke to
  replace, and a cell that wrote to a range it invented would put its text in
  the row's last real column.
- **A redraw skips the focused cell**, so a change arriving from elsewhere —
  a sync, an undo — does not appear in the cell being typed in until it is left.
  The alternative is the document's version of the text landing under the caret
  mid-word.

**Three things asked "where is the caret?" and answered from the document**,
which is the class of defect this change created and the reason they are listed
together rather than as three fixes:

- The table picker's own command put the caret in the new grid's first cell and
  `LiveEditor.web.tsx` called `view.focus()` immediately after, taking it back
  out. `insertTable` now reports whether a cell took the caret. **Only the
  WebKit job saw it** — jsdom has no menu, so the unit test focused the cell
  and nothing took it away.
- Both halves reported focus from `contentDOM`, which does not have it while a
  cell does, so a tap on a cell read as a blur. On the phone the accessory bar
  is the only way out of the keyboard, so that raised the keyboard and removed
  the way back. `focus`/`blur` do not bubble and `focusin`/`focusout` do, so the
  pair moved to the editor's root on both halves, with a `focusout` that lands
  inside the editor saying nothing.
- `caretBox` measured `state.selection.main.head`, which is not where somebody
  typing in a cell is looking, so the keyboard-avoidance scroll would have gone
  to whichever line the selection was left on. The focused element answers for
  itself when it is inside the editor and is not `contentDOM`.

The general rule, for the next widget that takes a caret: **a widget's
`contenteditable` is a caret in the note and not a caret in the document**, and
anything that reads the selection to find the person has to say which of the two
it means.

**And one table is still not drawn: the one being typed.** `| - | - |` is a
valid delimiter row, so a table parses *in the middle of* typing the dashes.
The grid went up over the two lines being written, the caret was left at the
end of a line that was no longer on screen, and the rest of the row went in
where nobody could see it — measured in Chromium, `| --- | --- |` finished as
`-- |` under a two-column grid, and the body rows after it never joined the
table at all.

So `writingTable` holds the one table that gives way, and it is **identified
rather than inferred from where the caret is**: position cannot answer this,
because a caret at the end of the delimiter row and a caret parked there by
Escape are the same number and want opposite answers. A *document change* with
the caret in a table marks that table as being written; a selection that leaves
it puts it back; and the two gestures that hand a table over rather than leave
it — Escape out of a cell, and a cell taking focus — say so with an effect.
Arrowing about inside the source keeps it revealed, which is the courtesy every
other construct here extends to the thing being edited.

Two details are asymmetric on purpose, and each was found by a test rather than
reasoned out. The change has to **touch** the table, or an edit elsewhere would
reveal a table whose first character the caret happens to rest on —
`openingCaret` parks at the first line of the writing, which on plenty of notes
is a table. And the caret has to be **past** that first character: arriving from
above is being beside a table, while the end of its last line is where the
keystroke that made it one leaves you.

This does not reintroduce the flicker the old rule feared. A caret in a cell is
not a caret in the document, so a grid somebody is working in is never the one
being written, and `atomicRanges` means the document's caret cannot walk into a
drawn table — it gets inside one only by writing it.

**The visual half was also only visible in a browser**, which is the third
finding of #733 arriving on its own: the control bar was pinned outside the
grid so an editable table would occupy exactly what a reader's does, and in the
running app it was drawn across the last line of the paragraph above and then
cut in half by the grid's own scroller — `overflow-x: auto` clips the other
axis too. On a narrow table it was worse: an absolutely positioned box cannot
be wider than the box it is positioned in, so a two-column table of single
characters folded every label into its own column and drew "+ r o w" on top of
"+ c o l". The grid reserves the space now and keeps a floor under the frame,
and `apps/mobile/e2e/webkit/tables.spec.ts` measures both — the bar inside the
grid's own box and above the table, and four buttons on one row at four
different lefts.

That spec opens `2-areas/public-worship/org-chart.md`, which carries a table
for the fixture reason #733 states. It is **not** in `weekly-review.md`, where
the constructs usually go: `callouts.spec.ts` types at the end of that note and
arrows back up into what it wrote, and a drawn table is an atomic range the
caret steps over.

**What would reverse this** is a cell that wrote back what it *drew* rather
than what it holds: that is the serializer, and the first thing it would do is
replace `**bold**` with `bold` the moment anybody put a caret in the cell. The
tests that fail if it is: *the source is what is written back, so the markup
survives an edit* and *the element survives the keystroke that changed the
document* in `apps/mobile/__tests__/tableEditing.test.ts`, the second of which
is the reason the widget patches its own DOM instead of letting CodeMirror
rebuild it — every keystroke is a document change, and a rebuilt widget loses
the caret on every letter.

### A control on a table belongs to the row or the column it acts on

The first editable grid carried a bar of four buttons above it — add row, add
column, delete row, delete column — acting on **the last cell that had the
caret**. The report it earned was *"deleting a row is not really possible"*,
and driving it in a browser found two failures rather than one.

The obvious gesture, hover the table and press *delete row*, does nothing at
all: the button is disabled until a cell has been focused, and a disabled
button explains nothing. And once a cell *had* been focused, the button stayed
armed after the caret left the table entirely — so a press deleted a row chosen
by something the person had stopped thinking about three clicks ago. Measured:
a click in a paragraph above the table, then a press, took a row out.

Both are the same mistake, and it is worth naming because it is not about
tables: **a destructive control whose target is not on screen.** Arming it on
remembered state made it worse rather than safer, because the remembered state
outlived every cue that it existed.

So every control hangs off the thing it acts on. A handle in a gutter beside a
row opens that row's menu and tints that row while it is open; a handle in the
strip above a column does the same for the column; the corner handle is the
table's. The handles are **cells of the table** rather than boxes positioned
over it, so each one is laid out by the table itself beside its own row at
whatever width that column came out — the alternative is measuring a grid that
is rebuilt on every keystroke. A reader's table has no gutter and no strip.

Two things stay plain buttons, because a menu could not make them clearer:
`+ row` and `+ col` append at the end.

**The menus are also where the verbs nobody had live.** A table needs more than
four of them, and the set is what somebody retyping a table by hand is doing:
insert above/below and left/right (the append could reach neither end), move a
row or a column (the alternative is retyping it), set a column's alignment —
which GFM keeps in the delimiter row, the one row the grid never draws, so
before this there was **no way to set it from the app at all** — and delete the
table, which nothing could do, because `atomicRanges` keeps the caret out of a
drawn one.

**"Edit as text" is the escape hatch and is the reason the rest can stay
small.** It hands one table back as its own pipes, which is the state
`writingTable` already models for a table being typed, so leaving is the same
gesture. Anything the menus have no verb for — a stray escape, a row the parser
refuses, a wholesale rewrite — is one press away instead of a reason to open
another app.

**Undo is what makes a destructive menu safe, and it did not work.**
`ignoreEvent` keeps every keystroke made inside the widget away from the
editor's keymap, so ⌘Z in a cell reached the browser's own contenteditable
history, which knows nothing about the document: it would put characters back
into the element while the file kept the change. The cell answers ⌘Z and ⌘⇧Z
itself now, letting go of focus first so the redraw is free to draw the
document that came back. Shift-Enter is answered there too, as the `<br>` that
is the only way a Markdown cell holds two lines.

**What a browser caught that 7,600 checks did not:** a menu drawn on the
document body is outside the element the `--lp-*` palette is declared on, and
an unknown custom property invalidates its whole declaration rather than
falling back — so the menu had no background and the note's text showed
through it. The same defect this log already records as *white text on a white
ground*, reached from the other direction. The palette now travels to the
element, read off the handle. It is on the body deliberately: inside the grid
it would be clipped by the same scroller that cut the first chrome in half.

**What would reverse this** is any control that acts on a row it did not name.
The tests are *the handle of the second row takes out the second row* — pinned
separately, because a handle that forgot its index passed every other case in
the file, which presses row one — *and it is that row, not the one somebody
last had the caret in*, and *the menu is drawn in the note's own palette,
outside the note* in `apps/mobile/e2e/webkit/tables.spec.ts`.

### A note may declare the mode it opens in, and the person still outranks it

Reading mode is a *session* mode and the section above it says why: it is how
you are working, not a property of the file, and resetting it on every selection
"makes it a property of the note rather than of how you are working, and then it
belongs in the file rather than here".

For one kind of note it does belong in the file. A page whose content is a
` ```form ` fence is drawn as a fillable form **only while the note is read** —
that is the rule directly above, arrived at for reasons that are not going to
change — so the one page in the product whose purpose is to be *used* rather
than written opened as a code fence, and everybody who visited it had to find
the eye in the trailing group first. The owner's words: forms should "be easily
sent without more clicks".

So a note may say so in its frontmatter, and `files/viewMode.ts` reads it:

```yaml
---
view: read      # or reading, preview; and edit, editing, source
---
```

Four things are decided here rather than left to the next reader.

**It is frontmatter, not a key in the `form` block.** The question is "how does
this page open", which is true of a note with no form in it at all — a
long reference someone only ever reads, a diagram page — and a block that
declares it would answer it only for pages with blocks. It also keeps
`forms.md`'s rule that the fence declares the response path and nothing about
presentation.

**`obsidianUIMode: preview | source` is read too, and ours wins on a tie.**
These buckets are open in Obsidian while the console is looking at them, and
that is the key Obsidian already honours for exactly this. Honouring it costs
one row in one table and means one line in the file rather than two that can
disagree; refusing it would have meant every form page carrying both.

**A value neither table knows is ignored rather than guessed at.** The note
opens however the person was already working, which is what every note did
before this existed. `view: readonly` is not "near enough to `read`": a key
that half-works is worse than one that does nothing, because the author
believes they were understood.

**The declaration is a default, so it is a second layer and never the mode
itself.** `readMode.ts` holds the person's `chosen` and the open note's
`declared`, and everybody reads `declared ?? chosen`. The first version
collapsed them — a declaration simply called `setReadMode` — and it is wrong in
the direction nobody reports as a bug: opening one form page would put the
*session* into reading mode, and every ordinary note opened afterwards would
come up unwritable with nothing on screen saying why. A file may decide how it
is opened; it may not decide how you work. For the same reason the declaration
is applied once, when the note's identity changes: pressing the pencil wins for
as long as that note is open, which matters because the one place a `form` fence
that will not parse can be fixed is its source.

What this costs, stated: a note stored encrypted declares nothing the console
can see, because what it holds is the ciphertext and the envelope's plaintext
frontmatter is the encryption marker rather than the note's own. Such a note
opens in the session's mode. And nothing *writes* the key — `frontmatter.ts` is
a reader and gains no serializer for this, so setting it is typing a line, or
asking an agent to.

**The tests that fail if this is reversed**: `a declaration does not follow you
onto the next note`, `the person's own mode still persists across notes` and
`the pencil outranks the file, and keeps outranking it` in
`apps/mobile/__tests__/noteViewMode.test.ts` — the three that collapsing the
layers turns red while every parsing test stays green — plus `a note that
declares \`view: read\` opens read, with no press at all` in
`noteChrome.test.ts`, which is the only one that fails if `BrowsePane` stops
calling the hook.

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

**The measure is `--lp-measure`, one value for both densities, relative to the
type rather than in pixels.** `layout.readingMeasureEm` is 36, so the column is
36 times the note's own font size: the same line at 14.5px beside a file tree
and at 16px on a phone, where a pixel width would have been two numbers to keep
in step. Measured in a browser, 36em is 522px in the console's face and holds 68
characters; prose in a system sans averages 0.45-0.55em a character, so it lands
between about 65 and 80 across faces against a comfortable band of 60-75. On a
phone it cannot bind at all — 342pt of text inside 24pt gutters is far narrower —
so `--lp-pad-x` still governs there, which is the point rather than an accident.

**`em`, not the `ch` that nominally means "characters", and CI is why.** The
first version of this was `62ch`. `ch` is the advance of the digit zero, so it
tracks a face's *digits* rather than its prose, and the two diverge: the same
declaration measured **75 characters in Chromium and 91 in WebKit on the same
Linux runner**, which the WebKit job caught before this merged. `ch` was
ambiguous a second way as well — a font-relative length inside a custom property
may be resolved where the property is declared or where it is substituted, and
engines differ; the note's wrapper is Times New Roman at 16px while the note is
a sans at 14.5px, so those are two different lengths. So the property now
carries a **bare number** and the rule that draws the text multiplies it by
`1em` there, against the type it is measuring. The unitless value is asserted on
both hosts: a unit sneaking back in is that ambiguity returning silently, on one
engine only.

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
at 1440x900 and at 390x844 and asserts the rendered **column in em** (tight —
that one is the layout's own arithmetic) and the **character count** (loose —
that one is the font's), that the column is centred and its margins still take a
click at the first width, and that `--lp-pad-x` alone governs at the second. It
measures the line box rather than `.cm-content`, because `.cm-content` is
deliberately still the full width of the pane, and it logs the width, the em
multiple, the count and the resolved face on every run, so a failure names the
font it is arguing with rather than only a number.

### An icon reaches for a path only when a rectangle cannot hold one weight

`Icon.tsx` draws the set from `View`s — borders, radii, transforms — and the
header argues at length for why, against both an icon font and
`react-native-svg`. Two of the forty-odd icons are now stroked `<Path>`s
instead. This is the rule that keeps it at two, and the evidence that earned
the exception.

**The refusal had two grounds and both expired.** The first was the dependency:
native, so it would land in `native-deps.json` and need a fresh development
build before anyone saw an icon. It has been in `package.json` at 15.12.1 and in
`native-deps.json` `core` since the baseline was over-provisioned ahead of the
first binary — every build already carries it, so there is no build to wait for
and nothing to gate. The second was the load-bearing one: *"there is no icon
here with a curve a rectangle cannot fake."*

**The eye is that curve, and it took three attempts to say why.** A rectangle
*can* fake a curve. What it cannot fake is **a curve at constant stroke
weight**, and every failure was that one fact arriving in a new disguise:

1. A `shackle` over a `cradle` — the padlock's arch and its mirror. Those carry
   left and right borders, which closed the almond into a capsule with a dot in
   it. That is a toggle switch, and it read as one in the toolbar.
2. One rounded border per lid, then a semicircle stretched sideways to kill the
   straight run a clamped corner radius leaves across a wide shallow arc. That
   removed the switch and exposed what the borders had been doing all along: a
   corner between borders of different widths is drawn as a wedge running to a
   point, so the stroke arrived at each canthus at nothing.
3. The true arc walked as round-capped `bar`s. Uniform weight at last — and the
   caps that let consecutive segments join are the same caps that bulge past a
   curve this tight, so it read as a beaded chain.

A stroked path has none of those failure modes, and the reference the owner
supplied — one weight the whole way round, lids meeting in points, an iris large
enough to nearly fill the almond — is not reachable from `borderRadius` at all.

**So: reach for a path only when the drawing needs a curve at constant weight.
Everything a rectangle can fake stays a rectangle.** Without a stated trigger
this becomes a slow, unargued rewrite in which forty working drawings are
churned one at a time for no gain. `eye` and `pencil` qualify; nothing else in
the set does today.

**What a "simplification" back to borders would cost**, and the guards that
fail. Path data stays in the same unit space (`viewBox="0 0 1 1"`) and the
weight is still `strokeFor(size)`, expressed as `strokeWidth = w / u` — so a
path icon is held to every set-wide claim the others are, rather than quietly
dropping out of them. `icons.test.ts` reads the geometry back out of the DOM:
it samples arcs rather than reducing them to their endpoints, because an arc's
bulge is the part that leaves the box, and it holds `eye` and `pencil` to
"stays inside its box" in the stroke's own terms — half the weight hangs outside
the outline, and that half has to fit too. The guard that is the actual finding
is **one weight all the way round**: it is cheap, exact, and it is the thing
that was wrong in all three earlier attempts. Sabotaged three ways — the iris at
a different weight, the eye widened until the stroke overhangs, the outline left
open — each fails exactly one test and no others.

### The read toggle's glyph is the act, so the accent fill is gone

The note's trailing capsule carried one eye, lit by `selected` while reading.
The argument for the fill was real: one mark cannot draw both "will hide the
markup" and "will bring it back", so the state went into the fill and the label
carried the act — the same rule `ICON_NAMES` states for the padlock that group
used to hold.

Two marks can draw it. The control now shows an **eye while you are editing**
(press it to read) and a **pencil while you are reading** (press it to edit), so
the icon and its `accessibilityLabel` say the same thing at last.

**Once they do, the fill is not merely redundant — it is wrong.** It would light
the *pencil*, and a lit control in this chrome means "this mode is on", while
the pencil means "press to start editing". Keeping both would be one signal
contradicting the other on an unlabelled 20pt target.

`_layout.tsx` (the phone) and `BrowsePane.tsx` (every pointer density) take the
same swap, because it is one control in two places rather than two controls.
`noteChrome.test.ts` asserts the label and the glyph together, reading
`data-icon` — which is why `Icon.tsx` puts the name in the DOM at all: a drawing
has no text, so without it "the mark changes when the mode does" is
unassertable.

### The staff console is shaped for ten customers, and its figures count rows

`/admin` was eleven identical tiles and a credential form in one scroll. Every
tile was a count of events from `usageDaily`, every tile carried the same visual
weight, and the only comparison on the page was day-over-day. Read as a UI/UX
audit against the product it is actually for — a handful of accounts, more
contexts than people, a $5 subscription per context — six things were wrong, and
each one is a different mistake:

**A percentage of a single-digit number is not information.** One person opening
the app twice is `+100%`. `dayOverDay` was already careful to return `null` from
a zero baseline, which at this size is most days, so the honest half of the tile
was an em dash. The growth figures now print `+2 — 3 vs 1 before`: the change,
and both of the numbers it came from, because `+0` from "two and two" and `+0`
from "nothing and nothing" are entirely different weeks. The event counters keep
their percentage — tool calls and searches run to hundreds a day, which is a
denominator big enough to carry something.

**Eleven tiles of equal weight is no hierarchy at all.** "Site visits" read as
important as "active contexts". Four headline figures now sit above everything
else, and the rest of the page is not tiles: at n=11 the interesting fact is
nearly always *out of what*, which is a composition bar, or *who fell out*, which
is a funnel and a roster.

**None of the questions could be answered.** Contexts were one number with no
personal/shared split, no managed-versus-customer-owned split, no plan status, no
provider, no client. Every one of those is a decision someone takes weekly — what
we are paying Cloudflare for, who to email about a declined card, which AI client
to test against first.

**There was no revenue anywhere.** The product sells a subscription and the staff
console did not say how many were paying or what that was worth. MRR is derived
from `PREMIUM_PRICE_CENTS` rather than restating it, and counts `active` only:
`past_due` is a declined card, not income.

**At this size the answer is a person, not an aggregate.** Five accounts, two of
which never connected a bucket, is a morning's work to fix and is invisible on
any page that only aggregates. Hence the funnel and the roster — and the roster
is control-plane metadata only: an address, when they arrived, contexts owned,
whether storage verified, clients, plan. `functions/admin.ts` already forbids
per-note, per-path and per-query figures, and that card is the thing most likely
to tempt somebody to break it. No column there may name a note, a folder, or a
search.

**Rotating a Stripe key and reading a growth figure were the same scroll.** Four
tabs, because there are four errands.

#### Counting rows, and what it costs

The figures the audit asked for cannot come from `usageDaily`. A counter only
knows what happened since the day somebody added it, so a growth curve drawn from
one begins on the day it shipped — and personal-versus-shared, managed-versus-BYO
and plan status were never counted at all. `censusReport` counts **rows that
exist now**, bucketed by when they were created, which makes every figure
retroactive and exact.

Convex has no count API, so that is a table scan, and the trade is stated rather
than hidden. `CENSUS_CEILING` is 500 rows per table — low, because one census
spans ten tables including the two widest rows in the schema, and the failure
mode of guessing high is the one screen whose job is to report growth throwing
because it did. Past the ceiling every figure is a floor, `truncated` travels to
the client, and **the growth curves are withheld rather than drawn**: a
cumulative line missing an arbitrary slice of its rows is a different and wrong
shape, not a rough one. That is the same rule the note count already follows, and
it is the point at which counting should be replaced by maintained aggregates —
a decision somebody takes, not a constant somebody raises. Rows are read
newest-first so a page that fills drops the oldest, which is the half nobody is
asking about.

Three pieces of the arithmetic a "simplification" would get wrong, each with a
test:

- **The cumulative curve counts everything created on or before each day**, not
  only what landed inside the window. Restarting at the left edge re-founds the
  company thirty days ago.
- **Managed storage is told apart by the whole derived bucket name, never the
  `ctx-` prefix.** A customer's own bucket carrying our prefix and somebody
  else's id must not be counted as one we pay for — and the name is interpolated
  rather than taken from `managedBucketName`, which *throws*: correct when
  provisioning a bucket, wrong in a census, where one unusual row must not take
  the dashboard down.
- **The funnel is thresholds, not a staircase, and is deliberately not
  monotonic.** Somebody with a client connected to a context whose bucket never
  verified is precisely the customer to go and find; clamping each step to the one
  above it erases them from the one screen that could have shown them.

One more rule the page inherits from the chart work: a stacked bar lifts any
non-zero slice to `MIN_SEGMENT_PERCENT` and scales the large ones down to make
room. The widths are then not proportional, which is the trade — the count beside
every slice is the truth, and rendering one real paying customer out of four
hundred as zero pixels is the worse lie.

`usageReport` keeps the event counters and loses its two all-time totals from the
screen. One number arriving on one page from two different reads, with two
different ceilings, is how a dashboard starts disagreeing with itself.

### Both left panels fold, and the seam between them is the control

The console's two left panels on a pointer layout are the rail and the file
tree. The rail collapsed to its marks through ⌘B and nothing on the screen said
so; the tree did not fold at all — `explorerToggleFor` was a documented constant
`null`, above a comment reserving the decision for whoever took it. Both fold
now, and the decisions that a "simplification" would reverse are these.

**The control that folds a panel lives on the panel's own edge.** So the control
that unfolds it is where the panel was, and spatial memory does the work. A
toggle in the top bar puts the affordance for restoring a left column forty
points up and to the right of where that column used to be, which is how people
come to believe a feature was removed. The seams were already there as
hairlines, and are 7pt hit targets that reveal a chevron only under the pointer —
so the affordance costs nothing on screen at rest, which is what lets it be
permanent.

**A seam does one job.** The seam behind a resizable panel drags; the seam
behind a folded or fixed-width one is pressed. Putting a press target in the
middle of a drag handle takes the most natural place to grab a divider and makes
it do something else, and no amount of hover-revealing fixes that — the target
is there whether it is painted or not. The tree is therefore folded by dragging
its own edge past the floor, not by a button sitting on that edge.

**Dragging past the floor arms a close instead of refusing.**
`clampExplorerWidth` still renders nothing narrower than `explorerMinWidth`,
because that is where a kebab-case name under two indents stops being readable.
What changes is only what a *release* past it means. The clamp's own comment
gave the reason it refused — dragging a region to zero is how somebody hides it
and then wonders where it went — and that reason is answered by the seam left
standing, not by the refusal. `explorerCloseOvershoot` is the gap that keeps
overshooting the floor by a few pixels from folding the tree by accident.

**The drag handle is a sibling of the editor, and a drag on it is not up for
negotiation.** Both halves of that are hit-testing and event facts rather than
taste, and both were reported as one thing: "expanding the side panel drags
properly to the right, but not to the left — and when it works I have to move
really slowly".

The strip straddles the column's border, because people aim *at* an edge rather
than a few points inside it, so three of its seven points lie over the editor.
Drawn as the column's last child they lay *under* the editor — later siblings
are on top — so every press on the outer half reached the editor and the handle
never heard it. It is therefore drawn after the editor, positioned from the
column's width (`explorerSeamOverhang`), and still before the scrim and the
peek, which have to cover it.

The other half is that **a pointer moving with the button down is a text
selection**, as far as a browser is concerned, and react-native-web's responder
system terminates the current gesture the moment one becomes valid, asking
`onResponderTerminationRequest` first — which defaults to yes. Dragging left
crosses the tree's note names, so the gesture died about three points in;
dragging right crosses CodeMirror's editing host, where a selection begun
outside does not extend, so that direction never hit it. What was left answered
only a pull slow enough to stay inside the handle's own 7pt strip, the one place
on that side with no text in it. So the resizer answers `false` to the request —
`selectionchange`, `scroll` and `contextmenu` are the only events routed through
it, and none of them should end a drag somebody is in the middle of — and holds
`user-select` and the resize cursor on the document for the length of the
gesture, handing both back on release *and* on a real cancel. A page left
unselectable is a worse bug than the one this fixes, and only a reload clears
it.

The guards: `appFrameRender.test.ts` drives a real `selectionchange` mid-drag
and pins the handle's place in the row; `panels.spec.ts` drags the seam in a
browser, from the half of the handle that lies over the editor, on the fixture
with a real tree behind it. Measured against the bundle before the fix, a 45pt
pull left moved the seam 3pt and then froze.

**`explorerHidden` and `explorerWidth` stay two fields.** One number meaning
both makes a 40pt tree representable, which is exactly what the floor exists to
refuse, and re-opening would have to invent a width instead of restoring the one
somebody dragged to.

**The peek is its own region, not the drawer with its scrim suppressed.**
Resting on the folded tree's seam brings it back *over* the editor — floating,
so nothing reflows and the paragraph being read does not move — which is what
makes folding it a cheap decision rather than a commitment. It must not have a
scrim: it is dismissed by moving the pointer, and a scrim would grey out and
make inert the note being peeked at *in order to reach*. `regionsFor` promises
the scrim exists if and only if a panel is over the editor and asserts it by
naming `drawer` and `sheet`, so the alternative was to loosen that word to
"modal". A fourth arm on a union that is already `frame.ts`'s subject is cheaper
than weakening a proven invariant, and `appFrame.test.ts` fails if the peek is
folded back into `drawer`.

**`closesOnSelect` takes the presentation, not the density.** Its previous
comment predicted this: it answered `false` everywhere and said the day a
density put the tree over the document again, this is the line that changes. The
tree is over the document again — as a peek, at wide rather than compact — so
the density was never the question.

**Preferences survive a resize; modes do not.** `railCollapsed`,
`explorerWidth` and `explorerHidden` are choices about how somebody likes the
app. `explorerPeeking` and `focus` are claims about what is on the screen right
now, so `panelsClearedFor` clears them. Getting the split wrong fails in both
directions: a cleared preference is a resize that rewrites what somebody chose,
and an uncleared mode is a rotation that returns you to a stripped app.

**Focus mode removes the panels, not the instruments.** ⌘\ folds both and keeps
the status bar, which carries the save state, the conflict-check mode and the
two panel toggles — so it is the way back out, alongside Escape and a warm strip
down the leading edge where a hand goes looking for a panel that was there a
moment ago. A mode that hides its own escape hatch is one people enter exactly
once. It is also the only thing that reaches `rail: "hidden"` at a pointer
density, so that arm has left `frame.ts`'s kept-but-unreachable list and
`appFrameRender.test.ts` now names which density draws it.

**Two controls for one action, split cleanly: the seam is the gesture, the
status bar is the state.** The seam costs nothing at rest because it is revealed
under the pointer; the status bar costs nothing to find because it never moves,
is the only half a keyboard reaches by tabbing, and is the only half left
standing in focus mode.

**None of this is on a phone.** `compact` has no left panel — navigation is the
context strip and the bottom row — so `explorerToggleFor` and `focusToggleFor`
answer "nothing" there, and the closed seam is gated on the same answer rather
than on a second derivation of it. A control that folds where the chord does
nothing is a button that lies. The first render of the closed seam *was* gated
on `hasExplorer` alone and drew a seam on every phone; a render test caught it,
which is the whole argument for asking the single owner instead.

### Bold is a toggle, ⌘B belongs to the note, and the right-click menu is the web's alone

Four decisions from one ask — *"command b should make whatever you highlighted
bold, same with italics… highlight something, right click to see a menu of
different options, strike through… maybe insert a table, selecting the
dimensions of that table"* — and they are separable, so each is here with what
it costs.

**A marker verb is a toggle, on every surface.** `wrapSelection` inserted a pair
and nothing took one off, which was survivable while the only thing that ran it
was one key on the accessory bar with an undo key beside it. It is not
survivable on ⌘B, because ⌘B is *the* chord people press twice — once to start a
bold word and once to end it — and answering the second press with `****bold**`
punishes the most ordinary thing anybody does with the editor. So `toggleWrap`
in `markdownFormat.ts` is what the chord, the menu row **and the phone's Bold
key** all run. The bar did not ask for that and gets it anyway: two meanings of
Bold on two surfaces is the drift `editorSetup.ts` exists to prevent, and
`webviewBridge.test.ts` now presses the bar's key twice across the bridge to
prove the phone got the same verb rather than a lookalike.

**Which half of `***x***` a chord takes back is a rule, not an accident.**
`**words**` has a `*` immediately either side of the word, so a naive "is the
marker there?" answered yes for ⌘I, took one off each end, and left `*words*` —
the same words saying something else, from a keystroke meant to *add* emphasis.
A run of asterisks is now read the way CommonMark reads it: a one-character
marker is present only in an **odd** run, a two-character marker in any run of
two or more. That is what makes the two chords compose — bold then italic gives
`***x***`, and either pressed again removes its own pair and leaves the other —
and it is the first thing to revisit if a marker that is not a repeated single
character is ever added.

**⌘B is bold in a note and the rail everywhere else**, which needed a rule in
`keymap.ts` rather than a winner. `toggleRail` is global and declaring `"global"`
declares every scope but `"overlay"`, so before this the chord toggled a sidebar
while somebody was typing. The two are not competing for one chord: they are one
chord meaning the obvious thing in each of the two places it can be pressed, and
that is what scopes are for. **A binding that names a scope beats one that only
reaches it as `global`** — which is general, is what `resolve` does in two
passes, and is why the collision guard in `keymap.test.ts` now allows exactly
one kind of shadowing and still fails every other. The marker bindings sit at the
*bottom* of `BINDINGS`, below `toggleRail`, on purpose: in their natural group a
first-match-wins resolver would answer `bold` by coincidence of position, the
rule would be untested, and the suite would go green against a resolver that had
never learned it.

Three consequences, each a real cost rather than a tidy-up:

- **⌘B no longer toggles the rail while the caret is in a note.** That cost
  was paid before it was charged: the section above this one put the fold on
  the rail's own seam and a toggle for it at the leading edge of the status
  bar, on the argument that a panel collapsing through a chord with nothing on
  screen saying so was the defect. The chord was the only route; it is not now,
  and ⌘\ still folds both panels from anywhere including the editor.
- **The three chords are declared in `keymap.ts` and dispatched nowhere.**
  `editorSetup.ts` binds them inside CodeMirror, against the live selection,
  which is the only place that knows what "the selection" is. The declaration
  buys the two things a binding written only there cannot: the menu prints the
  real chord through `describeBinding` rather than a literal — the bug `menu.ts`
  has already had once — and the chord takes part in the collision guard.
- **`useKeymap.web.ts` now ignores a keystroke whose default was already
  prevented.** It has to: the listener is on `document` and bubbles, so a widget
  with its own keymap has already run. The latent half of that is worse than the
  ⌘B half — ⌘S is bound in `editorSetup.ts` *and* is `save` here, so the day
  `readFocus` learns to see a contenteditable (the Live Preview editor is a
  `div`, not a `textarea`, so the `editor` scope does not resolve for it today)
  one press would have written the note twice, the second write conditional on
  an etag the first had already moved: a conflict dialog over somebody's own
  keystroke.

**There is no chord for an inline code span, and none for a link.** Every
obvious one is already spoken for by something that works: ⌘E is
`togglePreview`, ⌘⇧C is the element inspector in Chrome and Edge, and ⌘K is the
palette — which is the console's main route to everywhere and worth more than a
second way to type two brackets. Both verbs are on the menu with no chord
printed beside them, which `describeBinding` already treats as a legitimate
state rather than an error.

**The right-click menu is `Menu.web.tsx` drawing `editorMenu.ts`**, the same
arrangement the file tree has had since the console rebuild, and it inherits
that arrangement's two rules unchanged: read-only means a row is *absent* rather
than greyed, and an empty list means **let the browser's own menu open**. That
last one is not politeness. Spelling suggestions live in the browser's menu and
nowhere else, and spellcheck is on in this editor by an earlier deliberate
decision (P1), so replacing that menu unconditionally would have taken away a
feature somebody had switched on. **Shift-right-click therefore falls through**,
which is the chord Firefox already spells this way and which the other engines
learn here. Paste is deliberately not offered at all: reading the clipboard is a
permission prompt in Chrome, a second confirmation in Safari and refused
outright on an insecure origin, so the row would work for some people some of
the time with nothing useful to say when it did not — and ⌘V is unaffected.

The handler also **places the caret where the click landed** unless the click is
inside the selection, because the engines disagree about whether a right button
places a caret in a contenteditable at all, and a formatting menu that acts three
lines from where somebody clicked is worse than none. `posAtCoords` measures, and
measuring is the one thing here that can throw, so a position it cannot answer
leaves the selection alone rather than costing the whole menu.

**The table picker is web-only, and the file name says so.** Hovering a
rectangle is a pointer gesture, the menu it opens from does not exist on the
native app, and the accessory bar is already at the width where an equal share
of its pill falls below the touch floor — there is no room for a ninth key. So
`TableSizePicker.web.tsx` has no native sibling, and an iOS note gets tables by
typing them exactly as it did before. That is a stated gap, and the same gap
covers **strikethrough**, whose ⌘⇧X has no touch route on the native app either.
`keymap.ts`'s standing rule — no command it names may be the only way to do
something without a keyboard — is satisfied for bold and italic by the bar and
for strikethrough only by the web build's own long-press, which raises the same
menu as a bottom sheet. The place the missing keys would land is the bar, on the
day it stops being full.

Two smaller things fell out and are worth recording so they are not undone:
`place`/`fixedAt`'s flip-don't-clip arithmetic moved to
`design/components/popoverPlacement.ts` because the picker is the second thing
that opens at a pointer and a second copy of that rule is the copy that gets
fixed once; and a GFM table cannot interrupt a paragraph, so a table asked for
on a line that already has text is inserted *after* that paragraph with the
blank line the grammar requires — without which the button's whole output is a
row of literal pipes in the middle of somebody's sentence.

## A callout is a box, and `[!type]` never reaches the reader

Reported with two screenshots side by side — the Bible Reference plugin's
output in Context, and the same note in Obsidian — and one sentence: *"this
plugin shows up weird, compare to how it shows up in obsidian."*

**It was never a plugin bug.** The plugin writes
`> [!bible] [John 3:16 - NIV](…)`, which is an ordinary Obsidian *callout*, and
this editor had never heard of one. `[!bible]` parsed as a shortcut link, its
brackets were hidden like any other `LinkMark`, and the reader was left with the
word `!bible` underlined in blue in front of the reference. Every `[!note]`,
`[!warning]` and `[!tip]` in anybody's vault read the same way; a plugin is only
what finally put one on screen next to its original.

Callouts are Obsidian's extension rather than CommonMark, so lezer has no node
for one and `callouts()` reads the first line of a `Blockquote` the tree already
found — the same shape, and the same stated reason, as `frontmatterRange`.
Matching on a line the tree has *already called a blockquote* is what keeps
`[!note]` in the middle of a sentence from becoming a box.

**The `>` goes too, and that reverses a rule this file's neighbour states
flatly.** `HIDDEN_MARKS` in `livePreview.ts` is emphatic that `QuoteMark` must
never be hidden — "a blockquote with its `>` removed reflows into the paragraph
above it and the reader cannot see the quote at all". Exactly right for a quote
and exactly wrong for a callout, because the box says the same thing the `>` was
saying. It is hidden per callout rather than by widening that set, so a plain
quote keeps every one of its marks, and per *line* rather than per callout, so a
caret on one line does not bring back the `>` on the four nobody is editing.

**No per-type colours, no icons.** Obsidian has thirteen callout types and
thirteen colours; each would be another `--lp-*` token crossing the WebView
bridge, against this area's standing restraint about palette-specific tokens.
The book icon in the report's screenshot is not Obsidian's either — it is the
plugin's own stylesheet, and Context does not load a plugin's CSS into the
trusted realm. Folding is not implemented, and the `+`/`-` that asks for it is
consumed as part of the marker rather than left behind: a callout that will not
fold is legible, and half a marker on screen is the bug this fixes.

**The completion list stopped assuming its own content at the same time.** Every
completion this console wrote for itself is a note path or a form keyword — a
few words, and a row that never needed a width. A plugin's suggestion is
whatever its `renderSuggestion` drew, and Bible Reference's is the verse: two
hundred characters on one unwrapped line, so the list grew to fit and ran off
the side of the screen. Wrapped and clamped to three lines rather than
ellipsised, because a verse cut at one line cannot be told from the next one.

**What a simplification costs.** Dropping the marker replacement is the reported
screenshot. Widening `HIDDEN_MARKS` instead of hiding the `>` per callout takes
the marks off every plain quote in every note. Revealing per callout rather than
per line jumps four lines of text sideways under a moving caret. Letting the
line walk stop on the quote's `to` draws an empty row of box under every callout
— which jsdom reported as fine and Chromium drew. `callouts.test.ts` holds the
decisions and `e2e/webkit/callouts.spec.ts` holds that they reach a screen; six
sabotages confirm them, and a seventh was removed rather than kept, because a
`Decoration.mark` inside a `Decoration.replace` paints nothing and no test could
tell the difference.

## A plugin row's switch is the press it replaced, and a choice never becomes one

Reported from a phone, and already quoted in `pluginRow.ts`: *"soooo much
jargon text; people just want to enable or disable a plugin."* The list was cut
to one question per row on the back of that, and the control it was left with
was still a button reading Start or Stop — the same press, drawn as a thing you
read rather than a thing you flick. Every other plugin manager people have used
puts a switch there; ours had the word.

**So the row has a switch, and exactly two presses are allowed to become one.**
`pluginRowSummary` already split them: start and stop are complete on the row
because everything they need has been granted, while anything with a choice
inside it opens a door and says so with an ellipsis. `pluginRowControl` is that
same split at the control, and it lives beside the summary rather than in the
panel so a second surface cannot quietly widen it. A switch that turned a
plugin on for the first time would have to pick capabilities and hosts on
somebody's behalf, which is the consent screen skipped by a control too small
to hold the question — and it would still render, still look right, and still
pass every test about wording. `pluginRowSummary.test.ts` names both doors,
`Enable…` and `Approve…`, because a test naming one of them goes green on a
mutation that special-cases the other.

**The switch is the accent, never a status tone.** Graphite and Paper spend one
hue on "here, active, yours", and a switch is the clearest thing in the console
that is yours — but `ok` green on a healthy plugin would make it a status light
somebody can press. The two halves come apart on the row that matters most: a
plugin that crash-looped is **off** without anybody having turned it off, so
its switch reads off while its pill keeps saying *Stopped itself*. The control
says what you set; the pill says what happened. `pluginSwitch.test.ts` asserts
the track paints `accent` and specifically not `ok`, which is what fails if
somebody ever "simplifies" the two into one colour.

The simplification this resists is the obvious one — draw the switch wherever
there is a press, colour it by health — and what it would cost is a consent
screen and a status vocabulary, neither of which the row would look any
different for having lost.

## The rail folds into the switcher, and the column it occupied goes to the note

The owner's words, looking at four screenshots of the console beside Obsidian
and Notion: *"the design system for context.lc is non-existent and its very
generic, and does not feel cohesive."* The palette, the type scale and the radii
were the first three answers. This is the fourth, and it is the only one that
changes what is on the screen rather than what colour it is.

The console drew **three columns**: a 216pt rail of workspaces and app
destinations, a 260pt file tree, and the note. The design canvas draws two —
the tree and the page. Three columns on a 1440pt window leave the note 964pt
before its own gutters, which is why the measure looked cramped in a window
nobody would call small, and why the app read as busier than the two products
it was being compared to.

**Five workspaces and four destinations do not earn a permanent column.** They
earn a menu under the name already in the title bar, which is where you look to
know whose notes are open. `features/console/SwitcherMenu.tsx` is that menu, and
it carries `railGroup`'s list unchanged: one group, the personal workspace
pinned first and marked "yours", everything after it in the order the control
plane sent, the claim entry in the pinned top slot and "New workspace" at the
foot.

### What it reverses, and what it only moves

**"The rail is one list, with the personal workspace pinned to the top"** is
*moved*, not reversed. Same `railGroup`, same pin, same mark, same two offers
under the same two conditions — a different container. `railGroup.test.ts` is
untouched and still passes, which is the evidence rather than the claim.

**"The contexts moved into the scroller, because navigation is not a verb"** is
untouched. That decision is about a phone, where a strip of pills lay across
somebody's note at every scroll position; `compact` still has no rail, still
draws `NavBand` inside the scroller, and still pins the account mark alone in
the corner. `topBarLeadFor` is the one function that says which of the two a
density gets, and it exists so the reachability guard has an input again —
that guard used to read `Regions.rail`, and a rule whose input has been deleted
is a rule that agrees with everything.

**"Both left panels fold, and the seam between them is the control"** loses half
its subject. There is one left panel, so there is one seam and one status-bar
toggle. `PanelToggle`'s third state went with the rail: `half` meant "narrowed
to its icons", which had to exist because `icons` was not `off` — the rail was
still there and still navigable — and the tree is drawn or it is not.

**⌘B is repointed rather than retired, and an earlier draft of this change said
the opposite.** That draft argued: *"quietly moving a shortcut onto a different
panel than the one its user learned is worse than a shortcut that stops doing
anything."* The premise was wrong. Nobody learned "⌘B narrows the workspace
column"; they learned what VS Code, Zed and Obsidian all mean by it, which is
*fold the left panel and give me the width*. There is exactly one left panel
now, so that is what it does, and ⌘⇧E is gone rather than kept beside it —
`keymap.test.ts` allows a command exactly one chord, which is what keeps
`describeBinding` from having to choose which alias to print. The collision with
`bold` in a note is unchanged, and so is the rule that settles it.

### What the fold cost, and where it was paid

**Right-click on a workspace.** `ContextRowMenu` hung off every rail row through
`RightClickTarget`, which reached the real DOM node to attach a `contextmenu`
listener react-native-web would otherwise strip. A menu row has no second menu
behind it, so that wrapper is deleted and a pointer layout has no right-click on
a workspace at all. The phone's own gesture is untouched: a long press on the
strip's pill, the same component, same two verbs.

The two verbs are what had to be paid, and they are rows in the switcher's own
menu: **Settings…**, and **Leave**, offered only on the context you are standing
in and only where `leaveWorkspace` would allow it — a row offered on your own
workspace is a press whose only outcome is `OWNER_CANNOT_LEAVE`. One row rather
than one per workspace, because "leave" is a verb about where you are standing
and a list of five workspaces each with a destructive row beside it is a menu
you stop reading.

Without that row this change would have taken the only door out of a shared
context on a desktop, which is the kind of quiet subtraction a fold is most
likely to make.

**What a simplification costs.** Bringing the rail back is the third column and
the cramped measure; it is also `Regions.rail`, `Regions.navToggle`,
`FrameState.navOpen`, `FrameState.railCollapsed`, `railToggleFor`, `AppFrame`'s
`rail` slot and `closeNav`, the rail column, the rail seam, the nav sheet and
`ConsoleRail.tsx` itself, all of which went in one change because `frame.ts`'s
own list refuses a representable region with nothing that can draw it. Dropping
the Leave row leaves a shared context with no way out on a pointer layout.
Dropping the claim entry's top slot puts a placeholder under the rows it stands
in for. Leaving ⌘B unbound leaves the chord every editor uses doing nothing, and
leaves `keymap.ts`'s scope-precedence rule with no live example to be tested
against.

**The tests that fail if it is reversed.** `appFrame.test.ts` ("a pointer layout
is the tree and the note, and nothing more"; "and the leading end of its title
bar is the switcher"; "`railToggleFor` is gone, and ⌘B belongs to the one panel
that is left"), `appFrameRender.test.ts` (the account slot, the seams, the one
status-bar toggle), `consoleIdentityChrome.test.ts` (the whole list, the pin,
the mark and both offers, read out of the opened menu),
`routeReachability.test.ts` ("a control `SwitcherMenu` draws is claimed as the
switcher", and `REGION_DENSITIES` read off `topBarLeadFor`),
`meetingsEntry.test.ts`, `ownContextPrompt.test.ts`, `consoleChrome.test.ts`,
`signOutHygiene.test.ts` and `fixtureConsoleDensity.test.ts`. Fifty-one
assertions across eight suites named the rail as the container they lived in;
every one was rewritten rather than deleted, because they are the reversal
guards of the decision this moves.

## A picture of the application does not invert with the page it sits on

The landing page is drawn in whichever palette the visitor's system asks for.
Two objects on it are drawn in graphite regardless, and the design canvas is
explicit about it: the endpoint bar — the MCP address you copy into a client —
and the hero's application window are both graphite on `Landing-Hero`'s **paper**
board as well as its dark one.

That is not an oversight in the canvas and it is not a theming bug. Both objects
are *depictions of software*, quoted inside a page that is not that software. A
terminal is a dark thing; a screenshot of an application is a screenshot,
whatever the brochure around it is made of. Re-tinting either to paper produces a
slightly different paper — which is not a different kind of thing, and is exactly
the effect that makes an embedded screenshot read as a panel instead of a window.

So the palettes carry `appSurface`, `appInk`, `appAccent`, `appChip` and
`appChipHover`, identical in both worlds.

**What a simplification of this would cost.** The obvious simplification is "let
them follow the palette like everything else". On paper that turns the hero's
window into a cream rectangle with cream chrome, and the endpoint bar into a
lighter stripe on a light page — both lose the edge that says *this is a
different surface, belonging to a different thing*. The hero window stops looking
like the product and starts looking like a section of the website. The page's one
job above the fold is to show the product.

The opposite simplification — hexes at the call site, no tokens — is what was
written first, and `paletteDiscipline.test.ts` rejected it correctly. A component
that names a colour is a component no palette can answer for; "this one is meant
to be fixed" is a claim that has to live somewhere a reviewer will find it, which
is here and in `tokens.ts`.

**The tests that fail if it is reversed.**

- `theme.test.ts`, *"no token was left as its dark value"* — this rule's own
  hazard, and the reason the exception is an allowlist rather than a relaxed
  comparison. That test exists to catch a token copied into `lightColors` to make
  the types line up and never given a light value, which is indistinguishable
  from a token that is *deliberately* the same. Each `app*` name is listed
  explicitly; everything else must still differ.
- `theme.test.ts`, *"every allowed exception is actually fixed, not merely
  listed"* — the allowlist's own guard. A name left in it after its token started
  differing protects nothing, and a name mistyped into it silences nothing while
  looking as though it does.
- `paletteDiscipline.test.ts` — no component may name a colour, so a third fixed
  surface cannot be added as a literal without this decision being read first.

**What this does not license.** Two objects, both depictions of the application.
A third one is not covered by "well, the other two do it": the rule is about what
the object *is*, not about wanting a dark box. Anything that is genuinely part of
the page — a card, a callout, a band — inverts.

## A sort number is filing, so the console draws the name and keeps the number

PARA only works in order. `1-projects` has to come before `2-areas`, and every
tool that reads the bucket — a listing, Obsidian's sidebar, the Files app, `ls`
— sorts one way, alphabetically. So the order has to be *in the name*. That is
not a Context convention we could drop; it is how ordering survives being
handed to somebody else's tool, which is what non-negotiable #1 is about.

The cost is that the number is then drawn back at the reader on every row, in
every crumb, on every tab, in the one product whose claim is that the files stay
pleasant to live in. The owner's framing, asking for this:

> for numbers i agree that it's not sexy to have, but when you organize in para
> you need to have the folders in a specific order, and most file systems just
> do alphabetical

The question that answers it — put to them by somebody they were explaining the
layout to — was whether the number could be invisible: an attribute the console
sorts by rather than something it renders.

It can, and it already is: the number is filing, exactly as `.md` is filing.
`displayName` had been dropping the extension from what a row draws since the
tree existed, with `TreeRow.name` and `TreeRow.path` carrying the truth beside
it. **`withoutSortPrefix` is the same rule for the other end of the name**, and
`docs/decisions/` has no argument to re-run: it is the argument for the
extension, applied where the reader already agreed with it.

Backwards compatible in both directions, and that is the reason this is cheap
rather than clever. An existing bucket needs no migration to look better,
because nothing is written. A context whose folders draw without numbers is
still, byte for byte, a context any other tool opens in order — so the person
who leaves with their files (non-negotiable #1) leaves with the ordering intact,
and never finds out this happened.

**Where the number goes, and where it stays.** The split is not
surface-by-surface taste; it is one question asked of each string — *is this
naming a thing to a reader, or addressing a key?*

- **Dropped**, because these name a thing: tree rows and folder rows
  (`displayName`), every breadcrumb segment (`crumbsFor`), tab labels and the
  folder that disambiguates two of them (`tabLabel`), the note's inline title
  when it falls back to the filename (`noteHeading`), a folder's own heading on
  its page, Recent's rows and the folder line under them, the row menu's title,
  the "Currently team — from …" line, the share dialog's heading, and the
  toasts that report a move, an archive or a delete.
- **Kept**, because these address a key: Rename's field — which is the answer
  to "but when editing you can see it", and the one place somebody changes the
  number — the move picker and the command palette, `[[link]]` completion
  (whose `insert` is a path being written into a note), the permanent-delete
  sentence, and every operation anywhere, all of which go by `path`.

**What a simplification of this would cost.** The tempting one is a wider
pattern: `/^\d+[-_.\s]+/`, which is what `titleFromPath` and `linkLabel`
already use. Both are allowed to be wider because both are *inventing a title*
and may refuse — "a card with no title is honest". This rule draws the
customer's own filename back at them, so being wrong is not a missing card, it
is a row naming a file that is not the one on disk. Hence one or two digits (a
year is four), a hyphen only, nothing stripped when nothing is left, and never
when another digit follows — `2026-09-18.md` keeps its year, `12-25-christmas.md`
keeps its month, and `4-archive/2026-08-26T09-14-02-113Z/…` keeps the folder
`restoreTargetFor` reads a path back out of. **When in doubt, draw what is on
disk**: showing a number nobody wanted is untidy, and hiding half of a date is a
lie about somebody's file.

The other simplification is to make the label depend on its siblings, so
`1-plan` and `2-plan` do not both draw as `plan`. That is rejected and the
collision is the accepted cost: a label computed from whatever else happens to
be loaded reads differently for one folder in the tree, the tab strip and the
crumb, and the tab strip is the only place a collision has a bounded answer (it
qualifies with the folder, and already does). Two siblings deliberately given
one word is a naming problem its owner can see and fix, in a Rename that spells
the number out.

**The tests that fail if it is reversed.** `fileEditor.test.ts`, "the display
name" — the whole of PARA drawn short, a date left alone in four shapes, a
number with nothing after it kept, a separator that is not a hyphen kept, the
two halves re-joining to the original name, the collision pinned as stated, and
`TreeRow.name`/`path` unchanged beside a trimmed `label`.
`breadcrumbPath.test.ts`, "every segment drops its sort number" and "no trim
reaches the path a segment opens" — the second is the one that matters, because
a trim leaking into `crumb.path` asks somebody's bucket for a folder that is not
there. `fileTabs.test.ts`, "a sort number is dropped, and the collision test
sees the same name" — `1-plan.md` and `plan.md` both draw `plan`, so a collision
test on the untrimmed name would leave two identical tabs.

## A folder row says what differs, so `0-inbox` gets no count

**Decided 2026-09-18 by the owner, closing a gap the design canvas opened.**

`Phone-Browse.dc.html` draws a folder listing with a `3` beside `0-inbox`, in
accent, in the slot where the row's other marks go. It was recorded as an
outstanding difference between the app and the canvas, twice, and escalated as
"the app has no cheap source for the number". That framing was the mistake: the
question was never where to get it.

The owner's answer is that **that is not what the inbox there means**. It is a
folder you file out of, not a queue with a depth, and a number beside it turns
"you have not filed today" into an unread badge — a count that demands to be
driven to zero, on a surface whose entire job is to be a calm list of folders.
Nothing else in the listing counts, and the one folder that gets a number would
be the loudest thing on the screen.

**And it would be a number in the wrong slot.** The trailing position on a
folder row is where `FolderRow` draws the exception mark — the pip that says
*this row's visibility differs from its folder's*. The tree's rule, stated in
that file, is that a listing marks **only exceptions**: a `team` on every row of
a team folder is the default drawn once per file, which buries the one row that
differs from it. A count is not an exception about anything; it would be the
first mark in that slot that is not making the listing's one claim, and the pip
beside it would lose the meaning it has by being the only thing there.

**What a "simplification" of this would cost.** The tempting one is the reverse:
draw the count because the canvas draws it, and source it from the listing that
is already loaded — which is genuinely cheap, and is why this stayed open as a
data question rather than being closed as a design one. The cost is a badge
nobody asked for on the first screen of the phone, and a trailing slot that says
two unrelated things.

**The test that fails if it is reversed.** There is none, and that is
deliberate: this is a decision not to draw something, and a guard against
drawing it would be a test asserting the absence of a feature nobody has.
`FolderView.tsx`'s own comment on the exception mark is what a future reader
hits first, and it now says the slot is for exceptions and names this.
## The workspaces come back as a row at the foot of the tree, not as a column

The owner, looking at the console:

> Right now, it's not super visible — all the workspaces that someone's in,
> you got to click on it and drop down… I just want to explore some different
> UX/UI designs for that, because we want people to be able to switch more
> quickly.

The switcher menu is two presses, and the worse half of that is not the count:
it is **invisible at rest**. Nothing on the screen says a second workspace
exists, so nothing reminds anybody that it does. An account with four contexts
looked exactly like an account with one.

Five directions were drawn to scale and the owner picked one: **the context you
are in, spelled out, and the ones you were in last beside it, along the foot of
the file tree**. `features/console/foot.ts` is the rule and
`ContextFootRow.tsx` is the drawing.

### Why this one, and what the other four cost

- **A dock of full-width rows** at the foot of the same panel. Same zero cost in
  width, reads at a glance, and runs out at five or six workspaces — at which
  point it is a scrolling list inside a panel that already has one.
- **A pinned pill strip at the top of the panel** — the phone's `ContextStrip`
  on a second surface, which is the cheapest thing to build and the worst thing
  to use: 260 points fits about two pills, so the third workspace is behind a
  horizontal scroll, and a scroll gesture on a pointer is the most expensive way
  to reach something that was supposed to be one click away.
- **A 52pt icon gutter**, Slack's answer. It works, it scales to a dozen, and it
  is a column — which is the thing "The rail folds into the switcher, and the
  column it occupied goes to the note" spent 216 points buying back. 52 is less
  than 216 and it is the same trade in the same direction.
- **Tabs in the title bar**. Fastest to read, and it borrows a meaning it does
  not have: a tab is an open document you can close, a workspace is neither, and
  the title bar already draws note tabs two inches away.

### What the row costs, and where it is paid

**The panel is resizable, so the row is a function of its width.** The owner's
second and third instructions are the specification:

> when people extend it, we should be able to accommodate more space and maybe
> even show some of the workspace name if we have enough space

> if someone only has two workspaces and they're able to comfortably fit on that
> bottom panel without it being too crowded, then why not?

So `footPlan` takes the measured width and the real names and decides between
two shapes: **named pills** when every name on the row is whole, **marks** when
they are not. Nothing is ellipsised, which is `ContextStrip`'s rule — "two
contexts that look identical, on the one control whose entire job is telling
them apart" — with one stated exception: in the marks shape the *current*
context's label may shrink, because it is the third copy of that name on the
screen (the breadcrumb and the title bar's chip are the other two) and
budgeting it whole made the entire row disappear at the 200pt floor.

**Three recents, whatever the width.** Extra width buys names, not a fourth
workspace. A row that grew towards a dozen marks is the rail coming back at the
bottom of the panel, and everything beyond the third is behind the chevron —
which is `SwitcherMenu` itself, mounted with `trigger="chevron"` rather than
reimplemented, so the claim offer, "New workspace" and Leave keep their single
set of conditions.

**The title bar's chip stays.** It is redundant on Browse and it is not
redundant anywhere else: the explorer column is only rendered while browsing, so
demoting the chip to a label would leave Map, Connections, Search and Settings
with no switcher, no Settings row and no sign-out at a pointer density. Removing
it is a separate change that has to give those panes somewhere else to put it.

**No ⌘1–⌘9.** The obvious keyboard half of this row is already spent:
`keymap.ts` gives those nine chords to the note tabs, and `keymap.test.ts`
allows a command exactly one chord. Inventing ⌃1–9 for workspaces would be a
second digit row meaning a second thing, which is how a keyboard layout stops
being learnable. Left undone rather than done badly.

**What a simplification costs.** Dropping the width measurement and always
drawing marks is the tempting one, and it takes the owner's actual request back
out: the two-workspace account that fits comfortably is exactly the case the
names were asked for. Dropping the shape rule the other way — always names,
ellipsised to fit — is the defect `ContextStrip` already argued.

**The tests that fail if it is reversed.** `contextFootRow.test.ts`: "no row
where there is nowhere to go" (one workspace draws no band), "most recently
visited first, and never alphabetical", "the pinned context is held last", "three
at most, whatever the width" (asserted as the literal 3, because a test that
reads `RECENT_SLOTS` agrees with whatever `RECENT_SLOTS` becomes), "two short
workspaces are named at the resting width", "dragging the panel open buys the
names", "the floor still holds all three, however long the current name", "what
is planned fits the room it was planned for, at every width" — the sweep, which
is the one that catches a character-width estimate drifting narrow — and "every
workspace has a name a screen reader can read", which is the rule that killed an
icon-only rail once already.

### "Move to…" is one dialog, and the other context is a destination rather than a mode

A person who owns two contexts thinks "this belongs in @work", not "this belongs
in a different tenancy". So the destination picker gained a row of contexts
above its folder list, rather than a second command beside `Move to…`. Where
there is nowhere else to send anything — one context, or somebody who is only an
editor of this one — the row is **absent**, not a single disabled option: the
same rule the rest of this console follows, argued in the header of `menu.ts`.

Three things about that dialog are decisions rather than mechanics.

**The list of contexts is the client-side gate, and it is gated on ownership of
the context being left.** `useFileBrowser` empties it unless `isOwner`, because
moving something *out* removes it from everybody who could read it there — the
server's own rule in `functions/contextMoves.ts`. The console never offers a
destination whose press would be refused, and it never re-derives the rule from
anything else.

**Choosing another context asks it for its folders, once.** A console only ever
holds the tree of the context it is standing in, and walking another one a
`listFiles` at a time would be one bucket credential opened per folder. One
`folderPaths` action walks it inside the single call that already has the store
open, bounded, and says so when it hit the ceiling rather than presenting a
floor as a total — #25's shape. A folder chosen in one context is dropped when
the person switches to another, because two contexts can both have `work/` and a
stale selection is not an invalid press that fails, it is a valid press that
lands somewhere nobody chose.

**It is the one file operation that reports itself in a sentence.** Everything
else in this console finishes inside the press and reports itself by the tree
changing while somebody watches. A cross-context move can still be running
minutes later, in a scheduled action, with nothing on this device involved — so
it gets a line in the notice band that says what is happening, says that closing
the console does not stop it, and settles into something a person can act on: a
count, a list of what stayed behind and why, or a failure with "Finish the move"
rather than "Try again" — because everything already carried stays carried, and
resuming is not a re-run. A finished move is dismissible and a running one is
not, because a Dismiss that would be ignored is worse than no Dismiss.

**What a "simplification" of this would cost.** A second top-level command
splits one question into two and makes the cross-context case feel like a
different product. Drawing the context row from `canEdit` offers an editor a
control that is always refused. Keeping the chosen folder across a context
switch files something into the wrong context silently. Reporting a move only as
a toast loses the outcome for every move longer than eight seconds, which is all
the ones that needed reporting. `apps/mobile/__tests__/contextMoveBrowser.test.ts`,
`contextMoveNotice.test.ts`, and the "move dialog's other contexts" block in
`explorerActionGuards.test.ts` fail.
### Settings is seven rows, and a row has to earn its place

Twenty rows under four headings, each holding one word. Sayo, looking at it on
a call on 2026-09-18: *"I'm looking at the settings page right now. I'm
overwhelmed, bro."* That is the whole brief, and the rest of this entry is what
was done with it and what a reversal would cost.

**A row is a navigation, and a navigation is a question the reader has to
answer before they can ask theirs.** Twenty of them cannot be scanned, only
read, so the list was demanding a decision — *which of these twenty is my
question in?* — from somebody who had arrived with exactly one. The four group
headings were the first attempt at that problem and they made it worse: 10.5pt
in the faintest grey on the screen, carrying the whole of the structure.

Seven rows now, in the order the questions get asked:

    Profile · Workspace · Storage · Integrations · Meetings · Premium ·
    Sharing & Access

plus **Invitations**, which is present only while an invitation is pending.

**The four rules the collapse followed.**

1. **A merge is only worth it where the rows answered one question.** People,
   Groups, Shared links and Privacy all answered "who can see this", so they
   are four blocks of Sharing & Access. AI apps, Email, Calendar and Chats all
   answered "what is plugged in", so they are Integrations. Meetings stayed a
   row of its own because it is the one capture surface people open on purpose
   rather than configure once — the owner asked for it by name on the same
   call.
2. **Nothing is deleted with its row.** "Your devices" lost its row and its
   Revoke button became a card at the foot of Profile: a machine grant can
   capture into private notes, and this app is the only client that can cut one
   off. `CLAUDE.md` — never weaken revocability — is the rule, and the sections
   test is what fails if a later edit takes the card out too. Search is a block
   on Storage, Advanced a block on Workspace, Overview the *head* of Workspace.
3. **The keywords move with the content, always.** `matchSettingsSections`
   requires every typed word to match something, so a haystack that keeps a
   word for a row that no longer exists returns a section that cannot answer —
   worse than no match at all. "dark mode" reaches Profile, "rebuild index"
   reaches Storage, "who can see it" reaches Sharing & Access. That last one is
   spelled out as a whole sentence because it used to be the *group heading*,
   which the matcher searched alongside the keywords.
4. **Every retired `?settings=` value aliases rather than failing closed.**
   Twelve of them, in `RENAMED_SETTINGS_SECTIONS` — never in the catalogue, so
   they appear in no list and in no search result, which is what keeps an alias
   from being a second name for a section.

**What a row still costs, and the two things that removed one.** Appearance was
a Light/Dark/Follow-device picker with a stored choice behind it, a
module-level store to keep the panel and the provider agreeing, a synchronous
peek on web, an async read on native, and the launch image held up until that
read landed — all so one pinned value could arrive before the first frame.
Nobody asked to pin the app against their own system setting. The picker went
and the machinery went with it, because a stored value no surface can change is
a setting somebody is locked into. "Sign out & delete" was a row for two
buttons somebody presses once or never, and pairing them put the control that
ends a *session* on the only screen that can end an *account*.

**What a simplification of this costs.** The tempting one is to keep merging:
Meetings into Integrations, Premium into Workspace, Invitations into a
permanent row. Each takes back a distinction somebody on that call named —
meetings is a surface, not a configuration; Premium is about the account
paying; a row that says "None" on every load is a badge people learn to skip.
The other tempting one is to bring a heading back the first time a page feels
long: a heading over one row repeats its name, and four of them are what made
twenty rows unreadable.

**The tests that fail if it is reversed.** `settingsSections.test.ts`: "seven
rows, and one of them only when it has something to say" (the literal list),
"the list reads in the order somebody asks the questions", "one question, one
row: sharing answers all four of the old ones", "appearance is a sentence on
Profile, not a section of its own", "signing out is a control on Profile, not a
row of its own", "invitations is a row only while one is waiting", "the
machines are reachable from Profile, because the row went and the revoke did
not", and "deleting a workspace and deleting an account are not the same
search" — which is asserted by exact equality, so a keyword edit that merges
those two destinations fails loudly. `consoleNav.test.ts` holds the aliases.
`settingsOverlayRender.test.ts` sweeps every section for exactly one
`role="heading"`, which is what stops a merged panel from growing a second one.

### A pasted image is a width in the note and a file in the bucket, and nothing else

**Built, and this section was rewritten when it was.** It began as a design
recorded ahead of the work, with the tests it named still to be written. They
exist now, and one part of the design did not survive contact: alignment, below,
is a reversal of what the first version ruled out. What it got right is the part
that decided everything else — what a Markdown file can carry honestly.

**Pasting is two writes, in this order: the object, then the line.** `⌘V` in a
note writes the image into the bucket and then writes one embed line at the
cursor. A failed note write therefore leaves an unreferenced object —
invisible, recoverable, offered by name to its owner and never swept silently —
while the reverse order leaves a line pointing at nothing, which is a note that
reads as broken to every client at once. The line is drawn immediately, before
the upload completes, because the object's name is known before the bytes move
(below), so the optimistic line is the final one rather than a guess.

**The pointer decides between the two verbs, and a resize needs no click at
all.** Press and release on an image without moving and it is *selected* — ring,
corner handles, toolbar. Press and travel more than four pixels and you are
*moving* it, with the insertion caret showing where the line will land. One
target, two gestures, told apart by what the hand does: it is what Notion and
Craft do, and it is why the separate drag grip is gone — a 26px square with six
dots in it was a second thing to find for a gesture the picture itself can
carry. The side handles are on every writable image and appear under the
pointer, so the commonest edit is one drag rather than a click and a drag; the
cursor says the rest (`grab` over the picture, `grabbing` while it moves,
`ew-resize` over a handle). Putting the image down is the caret going anywhere
else — one definition of "the cursor is elsewhere", which this editor already
had — and the image's own toolbar carries no selection, so it stays picked
under the hand using it.

**A drawn thing that nothing redraws is not drawn at all.** Clicking an image
did nothing for a day, and the effect was landing correctly the whole time:
`livePreview`'s decoration field only recomputes when the document, the
selection, `readOnly`, the tree or the focus changed, and an image being picked
is none of those, so the field held the pick and the view kept the old
decorations. The gate now counts a fifth input. `imageInteraction.test.ts`
exists because no unit test could have caught it — both halves were right on
their own — so every assertion in it is made against a mounted `EditorView` and
its DOM.

**An image does not reveal its markup, which is this editor's one exception.**
Everywhere else in `livePreview.ts` the line the selection is in shows its
syntax, because you cannot edit syntax you cannot see. An image is where that
stops being true: the markup is a filename nobody types by hand, and clicking a
picture to have it turn into `![[paste-971e….png]]` was reported as "really
weird" the day it shipped — which it is. What replaces it is a **toolbar on the
selected image**: width chips, the three alignments as drawn icons, alt text,
Replace and Remove, plus corner handles and a grip. Every edit the line can
carry is a control on the picture, so nothing is lost by never showing the text.
The line is still ordinary text to everything else — a selection deletes it,
undo undoes it, another editor shows the embed — and `atomicRanges` keeps the
caret from walking into a row it cannot see. The selection lives in a
`StateField` rather than in the widget, because a widget is rebuilt on every
transaction and a selection kept inside one would be lost by the first resize it
was used for.

**The paste reads `DataTransfer.files`, and `items` only when that is empty.**
Reading both and de-duplicating by identity looks obviously right and is wrong:
`getAsFile()` mints a new `File` object on every call, so a browser that fills
both lists — Chrome, for one — handed back the same screenshot twice, it was
uploaded twice, and the note got two embeds of one image. Reported as "images
paste twice" within a day.

**The caret lands on the line *below* the image, and that is not a detail.**
The first version left it after the embed — on the image's own line — and the
reveal rule then did exactly what it exists to do: the line the selection is in
shows its markup. So a paste ended with `![[paste-….png]]` on screen, drawn as a
link, and the picture appeared only once somebody clicked elsewhere. Reported
within a day of shipping, with a screenshot of a link. A blank line under the
embed is written when there is not one already, which is where somebody would
keep typing anyway.

**The width goes in the pipe, and that is the load-bearing choice.**
`![[attachments/2026/09/paste-4b2c9f1a.png|480]]`, Obsidian's own grammar, which
[`links.ts`](../../packages/shared/src/links.ts) and `apps/mcp/src/links.js`
already parse — `embed: true`, the target spanned so a rewrite replaces only
the path. An `<img src="…" width="480">` would render in more places and is
still the wrong answer: the link engine cannot see an HTML attribute, so the
first time somebody moves the note the image is gone, and `linkParity.test.ts`
has nothing to say about it. The rule is that anything a note points at must be
written in the grammar the rename engine speaks. A strict CommonMark renderer
shows a wikilink embed as text; that is visible, reversible degradation next to
a file that is right there, and it is the same trade the `html-preview` fence
takes. Which of the three link styles is written follows what the note already
uses — a vault on `![alt|480](path)` keeps getting that — because non-negotiable
#2 says user-authored keys and conventions are not ours to rewrite.

**Several embeds on one line are a row, and that is the whole of side by side.**
Not a convention of ours: an image is an inline node in CommonMark and in
Obsidian, so `![[a.png|320]] ![[b.png|320]]` is two images beside each other in
those readers as well as in this one. A row is therefore a *line*, dragging an
image beside another is one line edit, and there is no gallery syntax to invent,
parse or explain. The same fact settles moving: `⌥↑`/`⌥↓` already move a line, so
an image inherits that and gets no verb of its own. A line that is *nothing but*
embeds is a row; an image in the middle of a sentence stays part of the sentence,
because resizing that by dragging would reflow somebody's paragraph.

**Alignment is a directive comment, which reverses this section's first
version.** That version ruled it out, on the grounds that "nothing in Markdown
carries centred". The second half of that is still true and the conclusion was
too strong: an **HTML comment** is carried by every Markdown file and rendered by
no Markdown renderer, so `![[a.png|320]] <!-- context: align=center -->` is
centred here, uncentred in Obsidian, and *never visible junk* anywhere. It is
still in the file, which is the line this holds — metadata we understand goes in
the Markdown, degrading to invisible, and never into a sidecar the Markdown does
not contain. `left` writes no directive at all, because the absence of one is
what a file written by anything else looks like and those two must not be
different states; an unknown key inside a directive survives an alignment
change, so an older console cannot silently drop what a newer one wrote.

**The bytes go in the opaque store, and this reverses what shipped first.**
The first version put pastes in a visible `attachments/<YYYY>/<MM>/` folder,
argued from Obsidian: that app skips dot-folders, so an embed pointing into
`.context/` draws there as a broken link. The owner reversed it the day it
landed, and the reasons are better than the one it replaced — one image store
rather than two, nothing new in the file tree, the listing stays the customer's
own folders, and `IMAGE_PREFIX` is the prefix `read_image` already serves, so an
agent can fetch an image somebody pasted. A visible folder could not have
offered that without widening `imageRefFor`, which is a security-critical
function.

So a pasted image is `paste-<hash>.<ext>` under `IMAGE_PREFIX`, written through
the `writeImage` that was already there, and the embed names the leaf —
`![[paste-4b2c9f1a.png]]` — which is also what a person typing one by hand in
another app would write. **What it costs is stated rather than hidden**: that
embed does not resolve in Obsidian, because the bytes are in a folder Obsidian
does not look in. Export is unaffected — `.context/` leaves with everything else
— and a resolver on the Obsidian side, or a visible mirror of the store, is the
change to make if that becomes the thing people trip over.

**Reading one back is gated on the reference, which is the gateway's own rule.**
An image has no row in `privacy.md` and cannot have one — non-negotiable #5 keeps
`Scope` two-valued and about notes — so borrowed visibility is the only honest
model. `readNoteImage` asks whether there is a note *this caller can see* that
names this file, through the same `read` operation the editor uses, so `canSee`
answers once, where it already answers. A visible folder is one whose keys a
member can guess; this is what refuses the guess. Writing needs `editor`, because
a paste is not a read.

**The number is a cap, not a demand.** `|480` means "up to 480px", clamped to
the reading measure, which is what makes one note correct on a 390pt phone and
a wide window without a second number or a per-device override. Percentages are
not available (Obsidian has no percentage), so the four chips are fractions of
the measure — a quarter, a half, three quarters, Full — and what they write is
the px that comes out, identical from every surface, so a width means the same
thing wherever it was set. The drag snaps to those quarters with `⌥` to ignore
snapping, and aspect is locked because height is never written down: there is
nowhere honest to keep it.

**A resize is an ordinary edit, and takes #701's machinery unchanged.** It is a
one-line edit op carrying `expectedEtag`, rebased only by `rebaseOp`, parked
with "Do it anyway" / "Discard" like any other. It gets **no** bespoke
width-merge: an earlier draft of this design said a conflicting resize would be
re-applied to the other side's text, which is a second conflict path for a
one-line change and is hereby dropped. Nothing about images reaches the bucket
except through the paths an edit already uses.

**Moving an image moves a line.** Drag the grip and one line changes places
between two others, with the insertion point taken from CodeMirror's own
`posAtCoords` so a drop lands where the editor would put a caret. Dropped on
another row, the two join — that is the side-by-side gesture, and it is one line
edit. Free positioning is **deliberately not built**, and this is the reversal
rather than an omission: x, y, rotation, float, z-order and a crop box all need a
store, the only store is the file, and the file has no room for them — so they
would land in a shadow layout document beside every note, which is non-negotiable
#3 ("plain files stay canonical") traded away for arrangement. The escape hatch
already ships and is the honest one: paste into a **drawing**, where an
`.excalidraw` file is a canvas format that carries coordinates because that is
what it is for, and which embeds back into the note as one line.

**The object is named from its own content**: sixteen hex characters of SHA-256,
at `attachments/<YYYY>/<MM>/` by default. Hashing buys three things at once — the
same paste in three notes is one object, a retried upload is idempotent rather
than leaving `-1` behind, and a clipboard with no filename needs no invented one.
The key is derived by the server rather than supplied by the client, because a
client-chosen path is a path to argue about, and `assertAttachmentPath` refuses
whatever comes out of the derivation if that is ever changed carelessly.

**Bytes are never inline and never remote.** No `data:` URI in the Markdown — it
destroys `git diff`, `grep` and every reader's idea of a paragraph — and no host
of ours in the link, which is `share/markdown.ts`'s rule already: a remote image
in a shared note is a tracking pixel that reports every read to whoever wrote it.
Inside the `WebView` the bytes do cross as a `data:` URL, and that is the same
rule rather than an exception to it: the guest holds no credentials and must not
be handed a URL it could fetch, because a URL it could fetch is a URL a note
could name.

**Offline needs something the mirror does not have, and this says so rather
than assuming it.** #696 is explicit that attachments are listed and never
downloaded, and that stands: this does not make the mirror fetch images. What a
paste needs is the other direction — an **outbound staged blob**, keyed by the
hash the device computed itself, which is exactly why the line could be written
offline and still be correct when the bytes arrive. Until that staging exists, an
offline paste is refused in a sentence, following #701's precedent for a folder
op: refuse honestly rather than queue something that cannot be made right.

**The rest of the product applies without special cases.** A `member` sees the
image and no handles at all, because write is a separate grant from read and a
greyed-out control is a worse way to say so. Through a folder share link the
image is re-derived through the live `privacy.md` at `team` scope with no granted
names, so an image only a private note embeds is **absent**, not merely
unlinked. A paste over the size ceiling is refused in the store's own words
rather than silently recompressed: the customer's bucket, the customer's bytes,
the customer's bill.

**An encrypted note refuses a paste outright**, and that is a decision rather
than a gap. Its text is encrypted on the device and an image's bytes are not, so
storing one beside it would put in the clear exactly what somebody turned
encryption on to keep out of it — in the same bucket, under a name the note
itself spells out. Encrypting attachments is real work that
[`encryption.md`](./encryption.md) scopes, and until it is done a refusal
somebody can read beats a paste that quietly weakens what they asked for.

**What a simplification of this costs.** Moving the width into an `<img>` tag
buys wider rendering and loses every image the first time its note is renamed.
Storing a position, an alignment as anything but a comment, or a crop box buys
arrangement and costs the claim that the Markdown is the whole note. Making the
width a percentage or a per-device value buys a nicer phone and costs "one file,
read the same everywhere". Writing the line before the object trades a
recoverable orphan for a broken note. Putting the bytes in a visible folder buys an embed that
resolves in Obsidian and costs a second image store, a new folder in everybody's
file tree, and an agent that cannot read what somebody pasted. Dropping the reference
gate on reads buys one round trip and turns a visible folder into a way for a
member to read what a private note holds.

**The tests that hold it.** `imageLine.test.ts` (26 checks) is the grammar: a
sentence with an image in it is not a row, an alias is not a width, `left`
removes the directive, an unknown directive key survives an alignment change.
`imageBlock.test.ts` (44) is every gesture as a planner — the row that stays
drawn wherever the selection is, what the toolbar writes (alt into the alias
slot, Replace keeping the width, Remove taking the line rather than leaving a
blank one), the clipboard pair where both lists hold the same image, the
snapping and `⌥` turning it off, a drop onto a paragraph moving the line, a drop
onto a row joining it, the blank-line arithmetic of moving a block, and base64
byte for byte against the platform's own encoder. `pasteImage.test.ts` (8) is the derived
name: a type the store cannot serve has no name at all, a hash that is not a
hash is refused rather than producing a junk key, and every name it can produce
round-trips through `writeImage`'s own leaf rule — a key that rule refuses is
bytes nobody could ever get back out. `imageBrowser.test.ts` (5) is the console's side:
the cache that keeps a keystroke from being a round trip per picture, a server
refusal passed through in its own words, and an encrypted note refusing before
the bytes leave the device. `webviewHost.test.ts` (6) is the bridge: every branch
replies, a read-only note refuses before the sink is reached, junk base64 is
refused rather than stored truncated. `files.test.ts` holds the reference gate —
a `member` naming the private note gets the same `FILE_NOT_FOUND` as for a note
that never existed, naming a visible note does not help, and the owner still
reads it — and it was that file's own endpoint table that noticed the two new
actions were missing from it. Sabotaged by disabling the reference check: two of
those go red, which is the point of writing them.

**What is not built, stated rather than implied.** An embed into `IMAGE_PREFIX`
does not resolve in Obsidian, per the reversal above. Images are still not in the
offline mirror, per #696 above.
And there is no crop, which is the one on this list worth doing next: a crop that
writes a new object needs no new numbers in the file, which is what made every
other item here expensive.

## A status wears a chip; a band is for what you have not been told

A `member` of a shared context read two full-width bands above every note,
every folder and every listing of it, on every load, with no way to put either
away:

> Team access — notes marked private are not shown here.
> This is Context's own workspace, not yours — read anything here, and use a
> form to file a bug or a request. Your own notes are never in it.

and two inches above both, the `team level only` chip the frame already draws
on every route. Three statements of one relationship, on the pinned
`@context-lc` — a workspace every account has in its rail and opens repeatedly.
The owner reported them as useless.

Each band arrived by a defensible step. The tier line moved from "the context
root only" to "every screen" because a team link opens straight into a note, so
the reader with the least context was the one nobody told — that argument is
right and is kept. The pinned line exists because "ask an owner for editor
access" is wrong for a workspace nobody invited you to. What neither argument
licensed is the screen they added up to: **a status drawn as news, twice.**

So the two are split by what they are.

**The fact is a status and stays permanent, in the one place a status costs
nothing.** `tierChipLabel` renders `team level only` in the pane head on every
route of the context, for exactly these readers, and `tierExplanation` holds
the paragraph on the members card for anybody who wonders what it means.
Neither moved, and between them "this view is filtered" is still stated on
every screen of the console.

**The sentence is a band, so it is shown until it is answered** — once per
context, with a *Got it* rather than a *Dismiss*, because it is read rather
than deferred. A first-time reader still lands in a filtered listing with the
line above it, which is the case the previous iteration existed for; that case
is a first screen, not every screen for ever.

**There is never more than one of it.** On the pinned context the pinned
sentence replaces the tier line rather than stacking over it: it already states
the whole relationship *and* the one thing a visitor can do, and "notes marked
private are not shown here" under it is a smaller claim about the same fact.
Elsewhere a `member` gets both halves in one paragraph, because what you cannot
see and what you cannot write are genuinely two facts.

**The demo keeps its line permanently**, and it is the one surface where that
is right: on the landing page the band reads "This is a demo. Sign in to edit
your own workspace", which is the page's call to action rather than an
orientation somebody finishes with. It is drawn with no control on it.

**The answer is a device flag, and here that is the right home** — the
opposite of the storage-layout migration's, whose whole lesson was that a
device flag was the wrong one. That answer was a fact about a *bucket*, which
the bucket itself knew, so a flag on one browser nagged every other. This one
is "has this person read a sentence about their own access": nothing else can
observe it, no table holds it, and a new browser telling somebody once more is
what a first-time reader gets anyway. The key carries the workspace *and* the
kind, so a `member` promoted to `editor` is told once that write access arrived
without the private notes coming with it.

**What it costs, plainly.** The read tier survives on the chip; the write half
has no equivalent, so a member who has answered and later tries to type gets an
editor that refuses the keystroke and no sentence saying why — the status row's
`Read-only` is about a file this console generates, not a context somebody
cannot write to. Accepted rather than overlooked: they dismissed a line that
had just said so, and the alternative was a band above every note for ever. If
it bites, the fix is a word in that status row, not this band returning.

**What a simplification costs.** Dropping the pinned rule stacks two bands
again on the workspace where they were reported. Dropping the kind from the key
answers a promotion in advance and silences the one conflation
`functions/files.ts` exists to prevent. Dropping the workspace from it lets one
context answer for every context somebody is ever shared into. Making the band
permanent again is this section in reverse; deleting it instead would leave a
stranger, landed by a team link in a listing with things absent from it, told
nothing at all. `apps/mobile/__tests__/contextIntroNotice.test.ts` and the
Browse cases in `consoleVisibilityRender.test.ts` fail.

## A workspace can wear a face, and the letter is what it falls back to

**Built.** The mark was one letter derived from the slug, and `WorkspaceMark`'s
own header argued for it well: a `Dot` could not say *which* workspace this is,
and a letter can. What the letter cannot do is survive a second workspace whose
name starts the same. `@seyi` and `@supa` draw the same **S**, in the same
square, in the same colour, side by side in the switcher, the foot row and the
settings panel — a control whose entire purpose is identity, telling you
nothing. That is the whole reason this exists, and it is why the answer is not
"a nicer letter".

**An icon is a photo, an emoji, or absent — and absent is the letter.** A union
on the row rather than two optional fields, because a mark shows one thing and
"photo set, emoji also set" would leave four drawing surfaces to invent their
own tie-break. Nothing is backfilled and no workspace is migrated: a context
that has chosen nothing draws exactly what it drew before, which is what makes
this additive rather than a change to every rail in existence.

**This reverses a comment, deliberately, and the comment is worth quoting
because its reasoning was sound.** `OverviewPanel` said of its monogram: *"the
initial of the name, not an avatar. There are no pictures anywhere in this
product and inventing one here would be the only place a context had a face."*
Every clause of that is true and the conclusion still does not follow, for one
reason: the face is no longer *invented*. A picture nobody chose is decoration,
and a product with one decoration is inconsistent. A picture its owner chose is
data — the same kind of data as `displayName`, and load-bearing in the same way.

**The photo is content, so it lives in the customer's bucket.** In the opaque
image store under `IMAGE_PREFIX`, where a pasted image already goes, named from
a content hash with an `icon-` prefix so somebody reading their own objects can
see where each came from. **The control plane records the leaf and never the
bytes** — non-negotiable #1, and the concrete consequence is that revoking our
credential leaves a person with their workspace icons, in a folder, as files.
An emoji is not content: it is a handful of code points that mean nothing
outside the row, so it sits beside `displayName` where every reader of the row
already is.

### The read path takes no object name, and that is the security argument

An image in the opaque store **has no visibility of its own.** It borrows the
visibility of the notes that reference it, which is what keeps the store from
drifting out of step with `privacy.md`, and `read_image` and `readNoteImage` are
both built on exactly that gate: name a note you can see, and the image must be
mentioned in it.

**A workspace icon has no note.** The obvious move is to widen the gate, and it
is the wrong one — a second way into the image store is a second thing to keep
correct forever. So `workspaceIconPhoto` takes **only a `workspaceId`**, and
reads the leaf off the workspace row. There is no argument through which a
caller can name an object, so it cannot be turned into a general object reader
however it is called: the set of objects it can ever return is at most one per
workspace, chosen by that workspace's owner. That makes it strictly *narrower*
than the note path rather than wider, which is the only reason it is allowed to
exist beside it. `workspaceIcon.test.ts` asserts the argument shape off the
registered validator — not off the source text — because "there is no leaf
argument" is the property doing the work, and a later convenience parameter
would end it in silence.

**Owner-only, and the role is stricter than the paste path's on purpose.**
`storeNoteImage` takes an editor, because writing bytes to the bucket is editor
work. Setting an icon writes bytes *and* changes what every member of a shared
workspace sees on their own screen, so it takes the role that owns the
workspace's other facts. A sabotage run found the suite could not see that outer
check at all — `recordWorkspaceIconPhoto` refuses a non-owner too, so the action
still failed and every assertion still held, while an editor's bytes had by then
reached the customer's bucket. The test now asserts that the refusal happens
*before* the write, which is what the outer check is actually for.

### The emoji rule is structural, and the list is ours

`isSingleEmoji` is not a length check. The value is drawn in an 18pt square on
the screen of every member of the workspace, so what has to be refused is not
"too long" but "not one glyph": plain text, a right-to-left override, a
combining stack that draws over the row above. The rule is one emoji *unit* —
pictographic base, regional-indicator pair, tag sequence, or keycap — optionally
joined by ZWJ, and nothing else in the string. It lives in `packages/shared`
because the picker pre-flights the same function, and two copies of it would be
a picker offering what the server refuses.

The picker offers a **curated list** rather than the system keyboard: React
Native has no emoji picker, the OS keyboard is unavailable on web, and a
free-text field is how the override above gets in. The list is the picker's
offer and never the API's rule — anything `isSingleEmoji` accepts is storable.

### Drawing a mark must not need a backend

The first version of the console half put `useAction` inside the hook that
resolves an icon, which is the obvious shape and is a **product** bug rather
than a testing inconvenience: `useAction` throws outside a `ConvexProvider`, and
three of the four surfaces that draw a mark are mounted without one — the
landing page mounts a picture of the console, and the demo console has no
backend at all. A mark that needs a Convex client is a marketing page that
crashes.

So reading is separated from fetching. `useWorkspaceIcons` imports nothing from
Convex and only reads a module-scope cache; `prefetchWorkspacePhotos` is called
from `useLiveConsoleData`, the one place a client is guaranteed because it is the
hook that runs the queries. A surface with no backend draws emoji and letters
correctly and never asks for a photo, which is right — it has no real workspace
to ask about.

**The cache is keyed on workspace *and* leaf, and that is isolation rather than
bookkeeping.** A leaf is a hash of the bytes, so the same leaf in two workspaces
is two objects in two buckets; a cache keyed on the leaf alone would serve one
customer's photo to another with no request ever crossing a boundary the server
could refuse. The client is the only place that can be wrong about this, so it
is the only place that can guard it, and `workspaceIcon.test.ts` in the app does.

Cached forever, because the leaf is a content hash: the same key is the same
bytes in this session and every other, and changing an icon changes its leaf. A
photo that fails to load is remembered as missing so a broken bucket costs one
request rather than one per render — the mark falls back to the letter, so that
failure is invisible and therefore has to be cheap.

**A photo keeps the status ring.** The mark's fill is `tone`, which is how a
workspace whose storage is in trouble stays the thing your eye lands on, and a
photo covers the fill. It is inset by a point so the tone survives as the edge
around it: two facts on one 18pt object, whose it is and whether it is working.

### What is not built, stated rather than implied

There is **no image resizing**: `expo-image-manipulator` is not a dependency and
adding it would mean a native module and a new development build for every
contributor, so the square crop and the compression are the system picker's
(`allowsEditing`, `aspect: [1,1]`, `quality`). A photo that is still over
`WORKSPACE_ICON_MAX_BYTES` after that is refused in words rather than silently
downscaled. The cap is a mebibyte — a fifth of what the image store allows a
paste — because the console draws this square once per workspace per paint.

`gif`, `heic` and `heif` are accepted by the image store and **not** by an icon:
a `gif` is the only one that can move, and an avatar that animates in a settings
rail is a decision nobody asked for; `heic`/`heif` are what an iPhone holds a
photo as and what no browser draws, so a mark chosen on a phone would be a blank
square on the web app.

Clearing an icon **does not delete the object**. The store is content-addressed,
so those bytes may equally be another workspace's icon or a note's embed, and it
is the customer's bucket: an object we put there is theirs to remove.

A **person** still has no picture. `AccountBlock`'s `Avatar` is a 26pt circle
with initials in it and stays that way — this is a fact about a workspace, and
the two are different objects, which is the same reason they were never one
component.

## The allowed-sender list stays beside the address it gates

Integrations stopped being a page of settings on 2026-09-18 (#710): three
Google panels became one list of connected things, and every control on it went
— the per-service destination fields, the eighteen schedule buttons, the
attachment policy, the target-folder picker. One stayed, and after the page
shipped there was a real question about whether it belonged somewhere else, a
Privacy or Security screen among them.

**It stays on Integrations, directly under the ingestion address**, and the
reasons are in this order:

- **The list has no meaning apart from the address.** "Who may write into this
  context by email" is unreadable on a page that does not show the address they
  would write to. Beside it, it needs no explanation at all — the address, then
  who may use it.
- **Splitting a control from the thing it controls is a known defect in this
  console, not a hypothetical.** The storage-update banner asked the same
  question of every new workspace (#718) because a fact was rendered somewhere
  that did not hold the fact it was about.
- **Ingestion is a property of a personal workspace** — a shared context has no
  capture address at all — and Integrations is already the page that knows
  that, refuses in its own words, and says why. A privacy screen would have to
  re-derive it.
- **It is the one control that is not a convenience.** Everything else removed
  was a preference with a good default; this one decides who can put notes into
  somebody's bucket, and the alternative to a list is an open drop-box on a
  semi-public address. A control of that weight is worth drawing where the
  reader is already looking at what it protects.

**Nothing about the security semantics rides on the placement**, and that is
what makes this reversible rather than load-bearing: the boundary is enforced
server-side in `functions/lib/ingestion.ts`, and the page draws what the policy
row already says. Moving the row later is a one-screen change.

The check is `the one control left on the page is the one that says who may
write into the bucket`, in `settingsOverlayRender.test.ts` — asserted on the
*page*, not on the panel, because a guard that mounts a component in isolation
proves the component and not the call site. Its neighbour, `...and the accounts
and the forwarding address are the other half of it`, exists for the same
reason: `sourcesPanel.test.ts` stays green with `SourcesPanel` deleted from
`SettingsPane` entirely, which is measured — removing that one line fails
exactly these two checks and none of the eleven that mount the panel directly.

## The tree is drawn from the press, and `privacy.md` is what it may not guess

Moving or renaming a folder used to repaint nothing until `moveEntry` had
answered *and* a `listFiles` had come back for each folder it touched. Two
serial round trips before one pixel changed, with the row still sitting where
it was — and the honest reading of a screen that does not react is that the
gesture did not take, so people did it again.

For a folder it was worse than slow. Listings are keyed by path, so every
listing beneath the moved folder was still filed at a path the bucket no longer
had, and `expanded` still named those paths too. The refresh reloaded the two
parents and nothing else, so the subtree you had open collapsed and had to be
re-expanded a folder at a time, each one its own request.

**The console now draws the operation on the press and reconciles afterwards.**
`files/optimistic.ts` is a pure function from the listings on screen to the
listings after the change, with the moved folder's subtree re-keyed and carried
across; `useFileBrowser` paints that, sends the mutation, and hands `run` the
**inverse operation** as a rollback.

The inverse and not a snapshot, and that is the part worth writing down: a
snapshot taken before the send would also roll back whatever landed while the
mutation was in flight — a background refresh, another folder's listing, a note
somebody saved — and a rollback that quietly reverts an unrelated fact is worse
than the stale row it was fixing. A move's inverse is the move with its ends
swapped, which is what `moveEntry` itself is, so there is exactly one thing to
get right.

**What it may not do is guess a visibility.** `privacy.md` is folder defaults
plus exact-note exceptions, keyed by *path*, so moving a folder can change what
everything under it inherits. Three restraints follow, and each is the
difference between a fast console and one that tells somebody a shared note is
private:

- **A folder nobody has read is left alone.** If the destination's listing has
  never been fetched, the moved row is not put anywhere. A listing invented for
  it would draw a folder that appears to hold exactly one note; absent is true,
  a listing of one is not.
- **A new folder inherits its parent's default**, exactly as the server gives a
  new key with no exception of its own — and `private` when the parent is
  unknown, so nothing drawn optimistically ever claims to be shared. The same
  rule, for the same reason, as `offline/overlay.ts`'s `fileEntry`.
- **Visibility is never recomputed locally.** The carried subtree keeps what the
  server last stated, which is stale until the refresh lands. That is not a new
  staleness — it is the same data the console displayed for the whole of the
  round trip this removes, at the right path and for less time. What makes it
  correct rather than merely shorter is `cascadeFrom`: a folder move reloads its
  whole re-keyed subtree, and `refresh` commits each folder as its page arrives
  rather than batching every page behind the slowest, so the marks settle from
  the top down.

**A timeout is deliberately not rolled back.** "No answer yet" is not "it did
not happen" — the socket may still deliver, and `TIMED_OUT_MESSAGE` says exactly
that. Putting the row back would state the opposite. A refusal *is* rolled back,
including the early refusal a read-only console gets: that console keeps all
fourteen mutating methods (`useDemoFileBrowser` sets each to a no-op), so a call
that slips past `canEdit` reaches `run` rather than throwing, and before the
drawing existed it was silent.

The checks are `optimisticStructure.test.ts` for the arithmetic and
`optimisticFolderMove.test.ts` for the wiring. The second holds the mutation
open — the action does not resolve until the test lets it — and asserts on what
is on screen while it is in flight, because a version that awaited the operation
first would pass against the code this replaced.

## What the sidebar can do to a folder, the listing can do to it too

The tree and the folder page are one listing shown twice, which this document
has said since `FolderView` was written. They were not one set of *gestures*:

- **Drag was the tree's alone.** `dnd.ts` has driven it since it was written and
  the folder page had nothing, so a folder you could reorganise by dragging went
  inert the moment you opened it — and at compact density, where `frame.ts`
  draws no file tree at all, there was no drag anywhere in the product.
- **On native, a listing row had no menu at all.** Its rows went through
  `useRightClick`, whose native half is a documented no-op. That surface is the
  *only* browse surface a phone has, so rename, move, duplicate, visibility,
  archive and delete were unreachable there.

Both are fixed by pointing the listing at what the tree already uses rather than
by giving it its own: `useRowInteractions` for the gesture, `dnd.ts`'s own
verdict for what a drop means. A rule that exists in one place cannot drift from
itself, and a drop refused in the tree is now refused in the listing with the
same sentence — said out loud through `files.say`, because a row that springs
back in silence teaches nothing.

One change to the shared hook came out of it. It suppressed the browser's own
context menu whenever a handler existed, which is safe for a tree row (always
has something to offer) and wrong for a listing row (`menu.ts` returns an empty
list for a read-only console). `onMenu` may now report back, and the web half
suppresses only what actually opened — the rule `rightClick.web.ts` already
stated at length, now shared rather than restated. `void` goes on meaning "it
opened", so no tree call site changed.

**What the listing still offers less of is "Share…", and that is deliberate.** A
share sheet is about one note's access, and the members, groups and removal
routes it needs are assembled for the *selected* note — a row you right-clicked
in a listing is not that. An item that cannot show who currently has access is
worse than no item in a product where `team` means named people.

The checks are `folderViewDrag.test.ts` (the pointer half, asserted on real DOM
events) and `folderRowNativeMenu.test.ts` (the half no DOM assertion reaches:
that every row goes through the shared hook, carrying its own menu and its own
drag verdicts).

### The sort control was a third instance, and it had nothing to point at

Drag and the row menu were fixed by aiming the listing at modules the tree
already used. The sort direction was not that shape: it lived in `Explorer`'s
own `useState`, so pressing "Sort Z to A" reordered the sidebar and left the
very same folder, drawn as a page beside it, still A to Z. `FolderView.tsx`
opens by calling itself "the tree, in the other place", and the one screen where
a person would check that claim was where it was false.

So the state got a home: `files/listingOrder.ts`, on `readMode.ts`'s shape and
for its reasons — `Explorer` and `BrowsePane` are siblings with `ConsoleShell`
between them, neither may import the other, and both may import a module that
knows about neither. What it costs is written in its header and is the same
bill `readMode` pays: not persisted, not in the URL, process-wide rather than
per context. A reload comes back A to Z. None of that is load-bearing, because
nothing here reaches storage — `orderedEntries` reverses a *presentation* of the
server's one order rather than inventing a second one.

`listingOrderShared.test.ts` asserts on the **drawn order of the rows**, not on
the store's value: a store that flips a boolean nobody renders from is the
version of this that passes a test and changes nothing on screen.

### The evidence is the drawn tree, because a hook's state is not a screen

`optimisticFolderMove.test.ts` holds the mutation open and asserts on
`browser.listings`, which proves the data moved and is one step short of the
complaint. The complaint was about a screen that did not react, and a hook whose
state changes while the tree still draws the old rows is indistinguishable, to
the person waiting, from no fix at all — which is the failure mode an optimistic
update is most likely to have, since it satisfies every state assertion on the
way to it.

`optimisticRepaint.test.ts` is the one that closes that: the real `FileTree`,
fed by a real `useFileBrowser` through the real `buildTreeRows`, in a real
reconciler, with the rows read **out of the DOM** while `moveEntry` is still
unresolved. Nothing in it inspects the hook. It also holds the part the tests
above cannot see at all — that an *open subtree* is still drawn, under the new
name, at that same moment.

### The corner makes five things, and one of them needs a key (2026-09-19)

The `+` replaced the microphone in the console's corner
([meetings](./meetings.md), *A meeting opens in the panel, and the corner is a
`+`*). What it offers is decided here, because it is a console question rather
than a capture one.

**Five items in three groups.** A meeting, then a note, a drawing and a folder,
then a chat. The middle group is a group because those three share a
*destination* — the folder you have selected, by `targetFolder`'s rule. A meeting
sits above them because it starts a recording rather than a file; a conversation
sits below because it makes nothing at all. The separators are that grouping and
not decoration.

They also shared a naming dialog when this was written, and two of them no longer
do: a note and a drawing are made on the press and take their name from what is
typed into them, and only the folder still asks. See *Nothing is named before it
is written* below.

**New chat is drawn only where the context has a model key.** The agent answers
through a key configured on the workspace, so without one the row opens a
composer whose first send errors — "a control that appears to work and does
nothing", which this console refuses everywhere else. `ConsoleData.modelConnected`
carries one bit; `listProviders` returns fingerprints and connection times and
never a key, and the projection keeps only whether the list is empty.

**It is gated on `=== true`, and the third value is the point.** `undefined` is
"the subscription has not answered", which is not "there is no key". Absent then
present is the honest direction for an offer; present then withdrawn is an offer
somebody may already have pressed. The Chat **tab** is deliberately not gated: it
is a place somebody goes on purpose and says in a sentence what it is for, where
a menu row is an offer made to somebody who was doing something else.

The checks are `pressing it offers everything a console starts`, `a context with
no model key is not offered a conversation` and `...and neither is one whose
answer has not landed yet`, in `consoleChrome.test.ts`.

### A control mounted by nobody passes every test of itself

`CreateButton` shipped with its own tests — what it draws, what its menu offers,
that it stands down at compact — and `console-create` appeared in exactly one
file in the repository: the component's own. Every one of those tests passes if
no screen ever renders it, which is **the same defect the microphone it replaced
actually had**: the corner was drawn by `NoteEditor`, so it existed on a note and
nowhere else, and the requirement it failed was "it should show up all the time,
even when on a folder page".

So the mount is asserted through the real layout — the corner on a context route
and on Map, the menu's contents, the absence of a second microphone beside it,
and the absence of the button at compact. `routeReachability.ts` makes the same
argument for routes; this is it for a control that is not a route.

Two things follow, and both were found by sabotaging the new guard rather than by
reading it. A jsdom test that reads `document.body` — which every test of a
portal-drawing control must — leaks its whole tree to the next test when an
assertion throws before its teardown line; and a test that sets a module-level
route and fails leaves the next one mounting a console somewhere else. Both are
torn down in `afterEach` now, and the symptom of the second was a sabotage run
reporting the phone's bottom bar missing, which was true of the route it had been
left on and nothing to do with the injected defect.

### A fixture that cannot show the thing under review is reporting on itself

`AppFrameVisualFixture` exists to answer "does the console look like the design",
and when the corner and the right panel changed it could show neither: the `+` is
mounted by the console layout that this fixture replaces, and the panel defaults
shut. It draws the `+` the way the layout does, and `?panel=meetings` opens the
panel on a running meeting — behind a parameter, because the artboards draw the
console with it closed and a fixture that changes the resting state is reviewing
a screen the design does not have.

Two defects were then found by looking at it in a browser, and neither was
visible to any test:

- **A menu anchored at the press point opened on top of the button.** `place()`
  puts a popover's top-left at the anchor and flips rather than clips, so a press
  inside a 56pt control against the bottom-right corner flipped the menu to *end*
  at the pointer, under the button. It anchors on the trigger's own top-right
  corner now, measured at press time — and opens *outside* that measurement,
  because `measureInWindow` never answers under jsdom and a button that does
  nothing there is worse than a menu placed at the margin.
- **An action row used the hero CTA beside a bare label.** `Button`'s own header
  prescribes `dialogPrimary` and `dialog` as a pair — "one shape, differing only
  in fill" — and ignoring it put a black slab with twice the padding next to a
  Discard with no shape at all.

The lesson is the one the fixture's header already carried and had not been
applied to a new control: a green suite is not evidence about a screen.

## Nothing is named before it is written, and the phone's `+` is the only key

Two things the owner asked for on 2026-09-19, in one sentence, and they are one
decision: *"when clicking the plus, there is new note, new chat (should be off
btw if no LLM api key configured), there should also be new folder, and new
drawing, and then also for new note, new drawing etc should not ask you to title
it, it should be called untitled-date, but the user should be able to title the
note while writing in it, this should be the same for mobile, we no longer need
a dedicated mic button on the bottom row, just a plus button that opens
different options"*.

The first half of that list is *The corner makes five things* above, and the
chat gate with it. What follows is the rest.

### A new note is never a dialog

Every route into a new note used to raise `NamePrompt`: the explorer's `+`, a
row's "New note here", ⌘N, the `?quickAction=note` widget link, and the phone's
bottom row. **The field asked for the one thing nobody has yet.** A note is named
after it says something, so the file is created immediately as
`untitled-<date>.md` and the name catches up: `files/untitled.ts` reads the
document's first heading, and `useFileBrowser` renames the file to match the
first time that heading settles into something other than the placeholder.

What a "simplification" of this would cost, in the order the mistakes are likely:

- **Put the prompt back for "safety".** It is not safety. It is a modal in front
  of the product's primary verb, and it is what made the widget link — one press
  from anywhere — end in a text field.
- **Rename on every heading edit rather than once.** The path is what every note
  link, share row and offline copy is keyed by. A file that moves whenever its
  title is edited is a file whose links rot while somebody writes. The adoption
  happens **once**, and after that the heading and the filename are two things
  the person owns separately, like every other note in the bucket.
- **Rename on the keystroke, or on `dirty`.** `performSave` captures the path
  when it is called, so a `moveEntry` that lands mid-write leaves a conditional
  write aimed at a name the bucket no longer has. It waits for `clean` or
  `saved` — the two states where nothing is in flight. (`saved` is `clean`
  wearing a chip that decays, so gating on `clean` alone makes the rename wait
  on a *UI* timer; written that way first, it never fired at all.) A note created
  offline is `queued` and is not titled until its drain lands, which is the
  honest order: the bucket does not have it yet.
- **Match the *word* `untitled` rather than the date.** A note somebody genuinely
  called "untitled thoughts" is their name for it. The date tells the two apart —
  and on top of that only a path this session created without a name is eligible,
  so opening an old file can never move it.
- **Sanitize a heading into a filename.** A slash quietly turned into a folder is
  worse than an untitled note: they can see `untitled-2026-09-19` and fix it, and
  they cannot see that their note moved. `nameFromTitle` refuses and leaves the
  name alone.
- **Use UTC for the date.** A note made at 9pm in New York would be dated
  tomorrow, on their own screen, in their own bucket.
- **Name it without loading the destination.** Listings are fetched per folder,
  so an unopened destination reads as *empty* and every note made into it gets
  the same unsuffixed name. The quick-note widget files into `0-inbox` on a
  console that has loaded the root and nothing else, so the second capture of a
  day was a refusal from the server. `createUntitled` loads the folder first, and
  `refresh` answers the pages it fetched as well as storing them — `setListings`
  has not committed when its promise resolves.

**A folder is the deliberate exception and still asks.** The reason a note needs
no prompt is that it has a title field inside it — its first line — and a folder
has no inside to type in. `untitled-2026-09-19/` in somebody's bucket, renameable
only from a row menu they have to find, costs more than one text field.

The checks are `untitledNames.test.ts` (18) and `untitledTitleAdoption.test.ts`
(11, driven through the real hook against a fake bucket and asserting on what was
*called*), plus the "made, not asked about" pairs in `menuActions.test.ts`,
`rowCommands.test.ts`, `createPrompt.test.ts`, `consoleChrome.test.ts` and
`consoleIdentityChrome.test.ts`.

### The phone's bottom row is six keys, and the `+` is all of them

The row's seventh key was a microphone that opened the meeting flow. It is gone,
with the separator that marked it off, and recording is a row in the sheet the
`+` raises — see [meetings](./meetings.md), *The seventh key became a row in the
`+`*, for what that costs the capture route (nothing) and why.

Two consequences that look like details:

- **The key is unconditional where it was gated on `canEdit`.** That was right
  while it meant *note*. A meeting is something a member of somebody else's
  context can still start, so `canEdit` would have taken capture off every shared
  context somebody reads. The read-only rule moved a row lower: the sheet draws
  no Note, Drawing or Folder row without it.
- **And `canCreateAnything` still hides the key when the sheet would have no rows
  at all.** A `+` that opens a dialog containing one Cancel button is worse than
  no `+`, and a read-only context on a surface with no meeting flow is exactly
  where that happens. `files/createSheet.ts` answers both questions — which rows,
  and whether there are any — because two answers computed in two places is how
  the second one goes stale.

`createSheet.ts` decides the **phone's** list and not the corner's. The corner's
menu is mounted only where every row applies (the layout draws it on no
read-only console and on no demo one), so its list is a literal with its grouping
argument in its own comments; the sheet's is what varies. Both draw the same rows
in the same order, and `createSheetRows.test.ts` holds the order as well as the
conditions, because a `+` whose rows move between the phone and the desktop is
two controls wearing one glyph.

The checks are `createSheetRows.test.ts` (8), `is six keys, ending at Save, with
no separator and no microphone` in `bottomRowWidth.test.ts` — which keeps the
seven-key solve as a probe of `BottomBar`, the shape the geometry must survive if
a destination is ever added back — and, in `consoleChrome.test.ts`, `the app's
other place is a row in the + sheet, and choosing it records` and `the + offers
the three files, and Note writes one without asking`.

### A phone can ask its context a question, and could not before (2026-09-19)

Both `+`s offer a Chat row, and on a phone that row raises `AgentPanel` directly
rather than the right panel it has none of.

**It was absent, and the absence was never decided.** `CreateButton`'s handler is
`null` "where a conversation cannot be had", and one of its three reasons read
*no panel to answer in (a phone)* — which was a true statement about the code and
not a product choice. The only thing that raised `AgentPanel` was the floating
microphone `NoteEditor` mounts, and that microphone stands down while the bottom
row is on the glass (*The seventh key became a row in the `+`*,
[meetings](./meetings.md)). So the whole route to the agent on a phone was: open a
note, put the keyboard up until the bottom row hides, press the microphone that
comes back, choose the agent row. The desktop menu offered it in one press.

**The fix is one line of routing, because the panel was already the right shape.**
`AgentPanel` is a `Modal`, and its own header says it is one so it can "appear
identically on a surface that has no console around it at all" — written for the
fixtures, and it pays for this too. `startNewChat` picks the surface by density;
the gate above it is unchanged and still `modelConnected === true`, so a context
with no model key is not offered a conversation on either.

What a "simplification" would cost:

- **Putting `hasAside` back in the gate.** That is the original defect: the row
  vanishes from the phone's sheet and the only route back is the one through the
  keyboard. Held by `the + offers a chat, and choosing it opens the panel`.
- **Mounting the card inside `NoteEditor` instead**, where the microphone raises
  it. Then it exists over a note and nowhere else — no folder page, no map, no
  search — which is the complaint the `+` itself was created to answer.
- **Building a second `agentPage`.** `agentPage`'s comment already asks for one
  builder, and the object is a set of *references*: a second copy is a second
  chance to put a note's body in one, which
  `__tests__/agentPage.test.ts` exists to catch. The layout now builds
  `agentPlace` once and hands the same object to both surfaces.
- **Dropping the `key`.** It is the timestamp, so each press is a fresh
  conversation rather than the last one reopened — which is what "New chat" says.

The checks are `the + offers a chat, and choosing it opens the panel` and `and no
chat row on a phone in a context with no model key`, in `consoleChrome.test.ts`,
both driven through the real layout at 390pt. Four sabotages are recorded in that
file's header.

### The feed is a file, and the console is a viewing layer over it

The ask, from the leadership meeting of 2026-09-19, in its own words: *"How
does Shay even know that this meeting note is here? Is there any type of
indication, especially in shared workspaces too?"*, *"there's logging, but it's
not human readable"*, *"maybe even like on the bottom, just like a number of
updates"*, and — the reason it matters — *"the workspace can feel dead
otherwise. You're working in chat, you open context, and it feels like nothing
happened, but really ChatGPT changed this and Claude changed this."*

The first design answered a different question. It added a third context view
at `/console/@name/activity`, with filters and a two-pane layout, and it was
rejected the same day for being invasive. What was asked for is an indicator,
and the version that shipped adds exactly three things to a console that had no
room to spare: a 5pt dot on a tree row, the note-count line at the foot of the
tree rewritten when something is new, and a dot on another workspace's mark.
Everything else is one popover.

**The thing underneath it is `activity.md`, a note at the root of the
customer's bucket.** Not a table in Convex, and not a rendering of
`.context/audit/` computed per request. That is non-negotiable #3 applied to a
feature every other product would have put in a database: open it in Obsidian
and it reads as a dated list; export the bucket and the history comes with it;
cancel and it is still a file somebody owns. The console draws it as rows, and
`NoteEditor` dispatches on the path exactly as it does for a drawing — so
opening it in a new tab, linking to it, and reading it on a phone all work
without a route of their own, and there is one answer to "which is the real
thing": the file is.

What a simplification of any of this costs, and the test that fails:

- **Making it a table.** The feed stops being the customer's, the export
  promise acquires an exception, and a person reading their bucket in Obsidian
  sees a context with no history in it. `activity.md is a note in your own
  storage` in `ActivityPage` says so on the screen itself.
- **Deriving it from the audit trail on read.** `.context/audit/` is one object
  per change — the shape that is right for a record that must never be
  rewritten and wrong for a list somebody opens. That is what `list_changes`
  does and why it is an agent's tool rather than a screen's.
- **Letting it be team-readable.** It names paths from every corner of a
  context, so it is stored `private` and re-asserted private on any write that
  finds it otherwise; a member gets a *rendering* through `readActivity`, never
  the file. `is refused to a member, and taken back if somebody publishes it`
  fails, and the failure is an index of every private filename in the context.
- **Filtering on the stored flag alone.** A note taken back into private must
  drop out of lines written while it was shared, so `canSee` is re-derived per
  reader at read time. `drops a note out of the member's view when it is taken
  back` fails.
- **Counting what is hidden.** A gap a reader can count is the disclosure the
  flag was there to prevent. `and never sees the private one, nor a count of
  what is missing` fails.
- **Recording every write.** A revision under 80 stored bytes is not one, and
  repeat saves by one hand inside half an hour are one line — without which the
  console's own 2-second autosave writes a line per keystroke burst and the
  list becomes the log the meeting already rejected. `does not write a line per
  autosave` fails, and it asserts the file is *byte-identical* rather than
  merely short, because the cheap path is "write nothing at all".
- **Marking every ancestor with the dot.** The path to the root lights up
  permanently and the mark comes to mean "this context has notes".
  `markedRows` marking every ancestor fails four checks across the two app
  suites.
- **Clearing the marker on open.** A list that marks itself read the moment it
  appears is one you cannot look away from and come back to. `opening the list
  does not mark it read` fails.

**A line points at a note, not at a path it once had.** An entry written on
Tuesday names where the note was on Tuesday, so every path is forwarded through
`.context/forwarding.json` — the ledger "A move leaves a forwarding address"
added, the same trail a share link follows — before a row is drawn or filtered.
Following a row then lands on the note rather than on a gone path, and `canSee`
is asked about where the note *is*, so one moved into a private folder drops
out of lines written while it was shared. The historical path is not lost:
`.context/audit/` keeps it and `list_changes` prints it. `a line written before
a move points at where the note is now` fails on both sides without it.

**What an agent contributes to it is one optional sentence.** `write_note`
takes a `summary` and the orientation text asks for one, so a row can read
"recorded the 2-products rename" instead of a folder path. It is the second
line and never the first: who, what and where come from the change record, so
a client that says nothing costs a path, and a client that says something wrong
costs a sentence rather than a false fact. This reverses the first design's
"no agent summaries", which was wrong on the evidence — the meeting asked for
exactly this and the owner's answer to whether a team might not want it was
*"I think we should enforce it"*.

**The list is a default, and the Markdown is a press away.** The first version
had no way to the file at all: the console drew the list and the editor was
unreachable on that path. For a feature whose own footer says *"a note in your
own storage"*, that was the product saying "your file, our screen" — so the
file now declares `view: read` in its frontmatter (which Obsidian honours too)
and `declaredView` holds the same default by path for every file written before
the line existed, and the pencil opens the source like any other note's. An
owner who types `view: edit` into their own `activity.md` lands in the source
from then on, because a default a person has overruled in writing is not a
default any more. This is **not** the drawing's trade next to it and must not be
confused with it: one keystroke in a drawing's base64 destroys the diagram, so
`DrawingEditor` genuinely refuses the text editor. Nothing here is destroyed by
typing, so refusing would be taste dressed as safety.

**Editing it is the owner's, and viewing it is everyone's.** Hand-editing this
file is editing the record of who changed what — the authority `canShare` and
`canSetVisibility` are, not the "may write notes" an editor has — so
`canEditActivity` gates the pencil. That is the *affordance*; the guard is
older and stronger, and unchanged: the file is stored `private`, so a member or
an editor cannot read it at all and is served the filtered rendering through
`readActivity`. "Members view" has always meant the rendering, and it has to:
the raw file names paths from every corner of a context.

**The writer splices rather than regenerates, and that is what makes the
sentence true.** `renderFile` rebuilt the whole file from a template on every
write, so anything a person typed into it survived until the next agent wrote a
line — an honest description of which is "you may edit this until something
happens". Now the contract is one sentence, and it is stated in the file
itself: **between the markers is the machine's, everything else is yours.** The
region between them is rebuilt from `.context/audit/` because a derived copy
that drifts is worse than no copy; everything either side is carried through
untouched, forever. `a later write keeps prose above the markers` and `and
keeps what is below them` fail without it. The one shape it will not guess at
is a file whose markers were deleted: there is no boundary to find, so it lays
down a fresh header rather than deciding for itself where somebody's text
ended.

**A row somebody broke is named, not swept up.** Editing a row's words is free
— the `<!--ctx …-->` comment is what is read. Deleting that comment, or
breaking its JSON, makes the row stop existing for every reader, and the next
change drops it. The console counts those (`strayRows`) and says so, because
silence is how a person edits a file, watches rows vanish and concludes the
product ate them. What it does **not** offer is the obvious button: a one-press
"fix" that deletes what somebody typed is the product taking the file back the
moment it looks untidy, in the one feature whose whole subject is that the file
is theirs. So it hands over a prompt to give an AI client, and that prompt
forbids the one thing a client must never do here — invent a `<!--ctx -->`
comment, which is the record, and a fabricated one is a fabricated fact about
somebody's context. `and forbids inventing a record` fails if that line goes.

**The column is the note's column.** `noteColumnWidth` and `layout.notePadX`,
centred — the same measure `LiveEditor` spends in CSS and `noteGutterFor`
describes, not a resemblance: the pencil swaps the list for that editor over
the same file, and text that moved sideways at the press would make the two
read as different documents. It shipped as a hard 760 pinned to the left edge,
and was found in a screenshot rather than by any of 7,600 tests, because
react-native-web compiles styles to classes and jsdom lays nothing out. That
claim now lives in `e2e/webkit/activityPage.spec.ts`, and the demo tree carries
an `activity.md` — a real `renderFile` output, not a hand-drawn one — so there
is a page for a browser to open at all. It is the third time on this feature
that the fixture not being able to show the thing under review was the whole
defect.

**Three numbers decide what is substantial, and they are thresholds rather
than tuning.** They live in one place — `packages/shared/src/activity.cjs`, the
module both writers import — because a gateway that disagreed with the console
about what counts would produce a feed whose density depended on which client
you happened to use.

- **80 stored bytes** (`MIN_REVISION_BYTES`), measured in either direction so a
  deletion counts. About a sentence: it drops a fixed typo, a frontmatter
  `updated:` bump and the whitespace an editor churns on open, and keeps
  anything a person would call an edit. Set it to zero and every autosave is a
  line — `does not write a line per autosave` fails. Raise it much and a
  one-line correction to a decision note, which is exactly the change somebody
  needs to hear about, vanishes.
- **30 minutes** (`GROUP_WINDOW_MS`), or **6 hours** for a saved session. Two
  changes by one hand inside the window are one line, so the row reads "added 3
  notes in `1-projects/`" rather than three rows a minute apart. The session
  window is longer because an active context collects dozens of saves a day and
  every one of them is the same sentence. Widen the general window past an
  afternoon and this morning's edit merges into this afternoon's — a line that
  says the wrong time about the wrong edit, which is why `MERGE_LOOKBACK` caps
  the scan at 8 entries as well as the clock.
- **5 minutes** (`REFRESH_MS`). This one is not about readability; it is what
  makes the console's 2-second autosave affordable. When the line a change
  would write is already on file, unchanged and less than five minutes old,
  **nothing is written at all** — no read, no conditional put, no request. The
  price is that "revised" can read five minutes behind the last keystroke,
  which is imperceptible in a list whose finest grain is a minute. Remove it
  and every save rewrites a 60 KB file. `the REFRESH_MS early return removed`
  is a live sabotage entry in the gateway suite.

The file is capped at **400 entries**, about 60 KB and roughly three months of
a busy shared context, because every write rewrites the whole file. What falls
off the end is not lost: `.context/audit/` keeps every change record and this
file is rebuildable from it, which is the third non-negotiable holding — the
feed is a derivative that happens to be canonical Markdown.

**A row cites a path, because a note has no identity to cite.** This is worth
stating because the forwarding it leans on could easily be mistaken for one.
`.context/forwarding.json` is a *trail between paths* — where a thing that was
here went — and deliberately not a note id and not an index of what refers to a
note. Nothing in this product gives a note a stable identifier, and adding one
to make the feed simpler would put an identifier in the customer's Markdown
that only we can read, against the first non-negotiable. So an entry stores the
path as it was at the time, and every path is re-derived through the live
forwarding ledger at read time, on both sides: a row is *drawn* at where the
note is now, and `canSee` is *asked about* where it is now. The historical path
stays in `.context/audit/`, where `list_changes` prints it. Skip the
re-derivation and `a line written before a move points at where the note is
now` fails in two suites; replace it with an id and the exit promise acquires
an asterisk.

**The dot on another context's mark is a timestamp, not a read.** A console
that showed "something changed in @acme" by opening every bucket its person can
reach would cost one storage round trip per workspace on every load, for a
6pt dot. Instead each workspace row carries an `activityAt`, stamped forward
only when a line is actually written — by the console through
`markWorkspaceActivity`, and by the gateway through `POST /gateway/activity`,
whose entire body is one workspace id. The reader's own `activitySeenAt` is
already on their membership for the same feature's foot line, so the dot is one
comparison over data the console already loads.

**Being in a quiet context catches you up, and that is not a softening of
"closing the list marks it read".** One timestamp per workspace cannot say
whose line it was, so a person's own console edit stamps `activityAt` and
lights a dot on their own context. Inside that context the edit is correctly
not news — `isUnseen` drops it for `me` — so the foot line never appears, so
there is no list to close, so nothing calls `markSeen` and **the dot never goes
out**. A mark that is always lit means nothing, which is worse than no mark.
So `shouldCatchUp` moves the marker when a loaded context has nothing this
reader has not seen and the marker is behind the newest line: at most one
mutation per visit to a context somebody else quietly moved. It returns false
the instant one line is unread, which is the rule the popover's behaviour
rests on, untouched. Your own edit *through a client* is still news to you —
that is the whole feature, in the meeting's words: *"ChatGPT changed this and
Claude changed this but you don't really see it"*. `being in a context whose
newest line is your own catches you up` and `but one line you have not seen is
enough to stay behind` are the pair.

**And one timestamp per context would have leaked.** `activityAt` says when a
context last moved; served to every member, it tells somebody who is not the
owner the exact minute of a change the file refuses them, the tree hides and
`list_changes` filters out — a private write's clock, in the one corner of the
product nobody would think to audit. So the row carries two stamps:
`activityAt`, which counts every line, and `activityTeamAt`, which counts only
the `team` ones. `listMyWorkspaces` hands the owner the first and everybody
else the second, narrowed in the query rather than on the client, because a
number that reached a device has been disclosed whatever the device then does
with it. That is the coarser of the two privacy gates and deliberately so:
nothing per-reader can be computed from a row every member reads, and a
`team`-tier line pointed at a named group is a thing the folder already
published to the workspace. It is also why the gateway's report carries a
boolean beside the id — not a fact about the note, but which of the two stamps
may move; absent reads as private, so a caller that omits it can only
under-report. `a private change never reaches a member's row` and `and the
private write does not move the team stamp it sits after` are the pair, and
`and a private one reports false, so no member's dot moves for it` is the
gateway's half.

Two things are load-bearing about that. **The stamp follows the line, not the
operation** — a change the feed declines to mention stamps nothing, or the dot
sends somebody looking for something that was never written down; `a change
nobody would mention stamps nothing` and `a change too small to mention reports
nothing` fail. And **an id and a tier are the whole of what may cross
the boundary**: what changed, who changed it and where are in the customer's
bucket, and a second copy on our side built so a dot can be drawn is the first
non-negotiable spent on a pixel. `with the context it was written into, its
tier, and nothing else` asserts that over the serialized request body rather
than over a field list, so a field added later is caught by the shape rather
than by somebody remembering to look. The route answers `{ok: true}`
identically on every path, including an id that is no workspace, because the
difference between "no such context" and "not yours" is the oracle a
gateway-authenticated route must not be. Counting unread *for* the reader was
rejected on the same boundary: an unread count is a question about what that
one member may see, over a row every member reads. `usageActiveDaily` was
rejected for a different reason — it is day-granular and counts reads, so it
would light the dot for somebody opening a note.

**And then it was looked at in a browser, which found three things no test
had.** `activityRender.test.ts` mounts `<Explorer>` with a prop it supplies
itself, so the console's own slot — `activity={data.activity}` in the layout —
was covered by nothing: delete that line and the suite stays green. The visual
fixture now carries an activity view and `e2e/webkit/activityIndicator.spec.ts`
drives it in a real engine, which is where these turned up:

- **Rows spent their width on paths.** The shared module's sentence names the
  full path, which is right for the file and wrong in a 240pt column: `A
  meeting landed: 0-inbox/meetings/2026-0…` had said nothing by the time it ran
  out. The console names the note and puts the folder underneath — and names it
  the way the tree does, without the sort number or the `.md`, because two
  names for one row is worse than either.
- **The unread marker read `Before 18h`.** A relative age is not a heading. It
  says `Earlier`; when you last looked is the foot line's sentence.
- **`4 min` wrapped to two lines** and grew the row, because nothing in jsdom
  lays anything out.

The first draft of the fixture data also named three notes in a folder the demo
tree has never had, so the console drew no dot and the board was reporting on
itself — the failure that page's own header warns about, reproduced while
guarding against it.

## A share card wears the app's palette, and leads with the workspace

Decided with the owner, 2026-09-21, from a screenshot of a short link
unfurling in iMessage and four words: "the app colors and designs have
changed so we should probably follow suit".

**The card was two design generations behind and nothing could have said so.**
It drew on `#050506` with a `#3B82F6` accent — the blue-black world and a
Tailwind default blue — while `apps/mobile/features/design/tokens.ts` had long
since replaced both with **Graphite and Paper**. That file's own header names
the reason it did: "a palette assembled from a framework's defaults looks like
every other application assembled from them". The card was still assembled
from them, so every link this product minted unfurled in a palette the product
itself no longer used anywhere. It had also kept Onest, which
`features/design/fonts.ts` stopped loading.

`apps/convex` cannot import from `apps/mobile`, so the values are restated in
`lib/cardArt.ts` — and **the restatement is compared against the token file in
`__tests__/cardArt.test.ts`**, which reads it as text and looks each colour up.
That is the guard the first drift did not have. Petrol is the only hue on the
card, which is the token file's rationing rule applied here: petrol means
"here, active, yours" and is never a status, and a card reports no status.

**One face, and the mono is drawn in it.** The chip and the domain line wanted
JetBrains Mono, which is a second binary and a second glyph-coverage surface
for two short Latin strings. `cardCoverage.ts` reads the cmap of whatever font
it is handed, so one bundled face is one question about tofu rather than two.

### The workspace leads and the domain is a footnote

`context.lc` sat in the position of most emphasis, which made every share look
like an advertisement for us rather than like somebody's note being handed to
somebody else. The lockup is now the handle.

**It is drawn only where the link's own address already carries it.** A short
link has told the crawler `@seyi` before it asked for anything; a token link is
`/s/<64 hex>` and says nothing about whose context it is, so a handle there
would be a new fact for everyone the link is ever forwarded to — and
`privacy-and-sharing.md` has a standing rule that link previews reveal nothing
about a context. A card cannot be recalled once a platform has copied it, so
this is decided in the direction that can be widened later. Claiming or
releasing a slug re-renders the card, because that is the moment the answer
changes.

### The chip is tied to the listing, not to the row

`NOTE`, `FOLDER` or `FORM`, from the share row and never from the note. The
folder case is narrowed by `drawnKind`: **a folder with nothing team-visible
inside it draws as a note, chip included.** The folder mark this chip replaced
already followed that rule — the mark and the listing appeared together or not
at all — and a `FOLDER` chip over an otherwise empty card would say "this is a
folder and there is nothing in it for you", permanently, to everyone the link
reached. That nearly shipped; `drawnKind` and its test are what stop it.

`FORM` is the one chip whose subtitle differs, and it has to: a collect link
takes answers from people with no account, so a card telling them to sign in
would contradict the page it points at.

### What a "simplification" would cost

Each has a test in `__tests__/cardArt.test.ts`, sabotaged to confirm it fails.

- Restating the palette without comparing it to the token file is how the card
  fell two generations behind in the first place.
- Tying the chip to the row rather than to the listing discloses an empty
  folder, in a picture that cannot be taken back.
- Supplying the handle for every share publishes the workspace on links whose
  address never did.
- Drawing the domain unconditionally puts `context.lc` on the card twice,
  which is what it did when this was written.

### One image, not two

An `og:image` is a single static PNG a crawler fetches once. There is no media
query and no theme signal, so the card cannot follow the reader's appearance
the way the app does — Paper exists in the product and cannot ship here, and on
a white message bubble a `#FFFDF9` card has no edges at all. Graphite holds on
both. The share *page* is HTML and is a different object; making it follow the
reader is open and unforeclosed.

### The static card's pipeline is a script now, because the old one was unrunnable

`og-card.source.html`'s comment carried a regeneration command — headless
Chrome plus ImageMagick — and neither is installed in this repository's own
environment. A command nobody can run is how a source file and the artefact
beside it drift into disagreeing, quietly. `infra/router/scripts/render-og-card.mjs`
uses what the repository already installs, and the first thing it caught was
itself: rendering against Google Fonts behind a TLS-proxying environment fails
with `ERR_CERT_AUTHORITY_INVALID`, the page falls back to the system sans, and
the screenshot **succeeds**. The face is injected from the repository's one
copy of Instrument Sans instead, and the script asserts `document.fonts.size`
rather than `document.fonts.check` — which answered `true` with zero faces
loaded, because it reports whether text can be rendered and a fallback can.

## The room binds to a document it agrees with, and a different note unbinds first

Found from three screenshots and one sentence — *"whatever I'm selecting on the
left is not the content that shows up in the middle"* — where the tab, the
breadcrumb, the path and the word count all named the note that had been
clicked and the text on the glass was a different note entirely.

**Two rules came out of it, and each one had already cost a note.**

### A different note is the `notePath` effect's, not the `value` effect's

`usePresence` builds the shared document for a note in the *parent's* effect,
and a child's effects run first — so the commit carrying the new note's `value`
still carries the previous note's `presence.shared`. `LiveEditor.web.tsx`'s
authoritative-value effect stands down while a document is bound, correctly and
for the reason its own comment gives, and the new note's text was landing in
that guard and being dropped. Nothing wrote it again. The editor was frozen on
the first note it had ever been given while everything around it moved.

So a change of `notePath` is now its own effect, and it takes the binding down
before it writes: while a binding is up, `YSyncPluginValue.update` relays every
document change into that room, so writing note B into an editor still bound to
note A's room would send B down A's wire as an edit of the note other people
are reading. It compares before it writes, because a rename changes the path
under a document that is not changing and a caret in the middle of a sentence
belongs where it is.

### A binding needs the same text on both sides, so an empty room is waited on

`yCollab` maps editor offsets straight onto `Y.Text` offsets and reconciles
nothing at construction. Two consequences, both silent:

- Binding an empty room to a document that already holds the note means the
  seed arrives as an insert at 0 of text the editor is already showing — the
  duplicated note `sharedDoc.ts` is written to prevent, arriving from the one
  direction it did not cover — and any keystroke before that lands at an offset
  the room does not have.
- `ySync` is one module-level `ViewPlugin`, and CodeMirror keeps a plugin's
  value across a reconfiguration that still contains that plugin. Swapping
  `yCollab(a)` for `yCollab(b)` in a single dispatch therefore leaves the *same*
  plugin in place, still holding the `Y.Text` it was built with: bound in name,
  relaying into a room nobody is in. Removing it and adding it back are two
  transactions for that reason.

A room that already holds the note is authoritative and is written in; a room
that holds nothing yet is waited on rather than bound, so the note stays on the
glass and `value` stays its authority until the seed or the replay gives the
two of them the same text.

### What a "simplification" would cost

Each has a test in `apps/mobile/__tests__/liveEditorNoteSwitch.test.ts`,
sabotaged to confirm the right one fails.

- Letting the `value` effect carry a note change again is the reported bug: the
  editor shows the note before the one that was clicked, indefinitely.
- Writing the new note in without unbinding first replaces the text of the note
  being left, in its room, for everybody in it.
- Swapping the binding in one dispatch is the freeze that hid this: every room
  after the first is bound in name only.
- Binding an empty room writes the note twice when the seed lands, or blanks it
  if the document is reconciled to a room that has nothing in it yet.

## Several rows are one operation, and a pick is what the keyboard acts on

⌘-click (ctrl-click off a Mac) and shift-click pick rows in the file tree, and
a right-click, a drag or a row chord on a picked row acts on the whole pick.
`selection.ts` holds the click rules, `useFileBrowser`'s `…Many` methods the
batches.

**A batch is one `run`, never a loop over the single-path methods.** Each
single call is its own `run`, and a newer `run` supersedes an older one: it
clears the older one's toast, skips its refresh and takes the busy flag. Five
moves in a row was one toast offering to undo the fifth. So a batch works
through its paths in order inside one `run`, says one sentence, and offers one
Undo that inverts every step last first. The first failure stops it: nothing
done is an ordinary failure, something done is a **notice** saying how far it
got and no Undo — `run` already reserves the notice for a half-failure, and an
Undo for the part that happened reads as an Undo of the whole. `bulkFileOps.test.ts`.

**With a pick up, a row chord acts on the pick or on nothing.** The open note
is still `selectedPath` underneath, but it is not what the tree draws selected
any more; ⌘⇧⌫ trashing it while three other rows sat highlighted would delete a
row nobody was looking at. So the pick is held by the console layout beside
`Shortcuts`, and the single-target chords (rename, duplicate, copy, cut) do
nothing while it is up. `rowCommands.test.ts`, "with several rows picked".

**The selection menu offers move, archive or restore, copy paths and trash —
not copy, cut or visibility.** The clipboard holds one path, so "Copy 3 items"
would paste one. Visibility has no batch write and no single Undo, so a "Share
3 items with the team" that stopped after the second would leave a privacy
change half made; that is the one item where half made is a disclosure, and it
waits for a server-side batch. `fileMenu.test.ts`.

A pick holds only rows on screen: collapsing a folder drops what was picked
inside it, and a folder with a picked note inside it moves as one path.
Moving into another context stays one item at a time — `moveToContext` has no
batch form and no Undo.

## No UI ships without a design audit first (2026-09-23)

The owner, on the first meeting-Resume UI: "SO ugly, never ship anything like
that without having a UI/UX subagent audit and design based on a principle of
simplicity, beauty, not making things feel clunky, and making things feel like
it naturally just fits there." That version was built straight from a feature
spec: one verb on five surfaces, a floating teal bar, a teal band in the note,
and the hero button four times. Every piece passed its tests, and nobody looked
at the surfaces together before they merged.

So any change that adds or changes user-facing UI gets a design pass before it
is built, and a second look at screenshots of the built result before it
merges. The pass audits against those four words, and in practice that means:

- **One place per verb**, where the thing it acts on already is. A second
  entry point needs a reason that the first one cannot serve.
- **Nothing drawn until it is reached for.** An offer that costs no pixels
  until somebody goes to use it never needs a dismiss.
- **No new styles.** Reuse the component the neighbours use, the way they use
  it. The accent means "here, active, yours" and is never a status; the white
  hero button is the landing page's.
- **Show, don't explain.** Copy about the plumbing (parts, files, paths) is a
  sign the UI is explaining a gap it could close.
- **Screenshots, both densities, both schemes**, shown to the owner. A surface
  that is not reachable in a browser gets a fixture (`features/e2e/`) so that
  it can be photographed; `scripts/capture-resume-shots.mjs` is the example.

What a "simplification" would cost: skipping the pass is how the Resume UI
shipped, and how it was rebuilt the same day.
