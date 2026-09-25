# App and console — design tokens and interaction

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

### An action row is primary first, and the way out sits beside it (2026-09-25)

The owner's review of staging: "We need to fix the layout issue with button
placement across the app" — a "Skip for now" floating at the far end of a
row, a "Remove" that read as loose text, primaries in two different colours.

One order for every action row outside a dialog: **the primary first and
left-aligned, in the accent; the secondary action immediately beside it**,
as an underlined `TextLink` (Skip, Cancel, Back, "I'll do this later") or a
bordered button when it is a real second choice ("Bring my own bucket",
"Resend code"). Never `justifyContent: "space-between"` between two actions
and never a spacer pushing them apart: a secondary action at the opposite
edge reads as unrelated to the one it qualifies.

- **`Button variant="ghost"` is not an action.** It draws a bare label with no
  colour, underline or box; beside a filled button it looked like stray text.
  Every ghost action became a `TextLink`.
- **The accent is the primary everywhere but the landing page**, whose white
  hero button stays its own (as "No UI ships without a design audit first"
  already says). The owner's canvas draws every primary teal.
- **Deleting something somebody just typed is a bin** (`DeleteButton`);
  removing something that already exists stays the two-step Remove → Confirm.
  A chip's remove is a close mark with a label naming what it removes.
- **Exceptions, deliberately:** a dialog keeps Cancel then Confirm at its
  trailing edge (the platform's order); a list row keeps its trailing action;
  A-02 keeps "Resend code" and "Continue →" at opposite ends because the
  canvas draws them there.

What a "simplification" would cost: a ghost button or a space-between action
row is the review's complaint coming back one screen at a time.

