# App and console — links and routing

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

It also carries its own guard, per [testing](../testing.md)'s one rule: every
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

