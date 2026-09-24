# App and console — offline conflicts and startup

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
redundant, and retiring it is a change to [desktop](../desktop.md)'s own argued
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

