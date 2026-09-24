# App and console — offline mutations and team links

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

