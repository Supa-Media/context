# The mobile app and the console

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### The note count is measured, stamped, and allowed to be a floor

For two issues running (#20, #25) the console printed facts about somebody's
bucket that nothing had measured: "1,284 notes across all", "2.4 GB in your own
bucket", "Reachable — 1,284 objects" — over a live bucket holding six. The fix
then was to delete the tiles, because there was no honest number available. The
tile is back, and four things are what make it safe.

**It counts notes, not objects.** `.history/` on a real context holds every
revision of every file: tens of thousands of objects standing for a few hundred
notes. An object count wearing the label "your notes" is the original bug with
a measurement attached.

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

`app/+html.tsx` cannot ask React — it is rendered at build time and paints the
page before any app code runs — so it carries the two grounds as literals under
a `prefers-color-scheme` query, pinned against the palettes by
`__tests__/htmlShell.test.ts`.

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

**Nothing is lost by either answer, including the one that overwrites.**
`writeFile` snapshots the outgoing body into `.history/` before every write, so
"Keep mine" leaves the replaced version recoverable from the customer's own
bucket.

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
