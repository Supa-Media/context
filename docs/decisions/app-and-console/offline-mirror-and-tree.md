# App and console — offline mirror and tree

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
five-minute pass, the walk opening a context asks for, and the walk a tree
hint asks for (next section). A walk is a whole-bucket
listing, so a context of tens of thousands of keys costs that many listed keys
per walk; a truncated walk leaves missing folders to `listFiles` as before, and
never reads an absence as a deletion. The device's tree is keyed by workspace
and clearance, not by storage binding, so a context reconnected to a different
bucket shows the old bucket's folders until the root listing and the first
complete walk replace them — seconds, and only to somebody who could see both.

### Somebody else's change reaches an open tree as a hint per audience, never as the change

A folder a colleague or an agent made used to appear at the next five-minute
walk. Now every write that changes the tree moves a timestamp in Convex, the
console subscribes to it for the context it has open, and a new value asks the
mirror for a walk — which is what redraws, through the path above. The hint
says *when* to ask, never *what*: the walk is `syncManifest`, `canSee` at the
reader's clearance, and nothing reaches the device that a walk would not have
brought anyway. It rides the Convex connection the app already holds, so there
is no socket per note or per folder.

**One stamp per audience, and a reader sees only their own.** A single stamp
per workspace would tell a team member *when* the owner touched a private
note — timing is information. So `treeSignals` holds one row per
(workspace, audience), where an audience is `private`, `team` or `@group`;
a change moves only the audiences that can see one of the paths it touched,
judged against `privacy.md` both **before and after** the change (a note made
private must still tell the team it left; a note moved out of a private folder
must not tell the team it existed there), plus any rule nested under a touched
folder. `treeSignal` serves a reader the newest stamp among the audiences
their clearance holds — `private` for the owner's clearance, `team` and each
granted group otherwise — and `null`, the same answer as "never changed", to
anybody the file resolver refuses, rather than an error `useQuery` would throw
into the page.

**Every writer is covered, or reconciled.** Console operations announce from
`runFileOperation` (`treeChangeOf` names the paths each operation touches; a
save carrying an etag is an edit and announces nothing). The gateway announces
agent writes from `recordChange` through `POST /gateway/tree`, computing the
audiences with its own privacy engine so no path crosses the boundary — the
body is a workspace id and labels. The reporter is bound per store, to the
workspace that store reaches, so an agent connected to its own context and
writing with `context: "@name"` announces to `@name`'s consoles — the first
release bound it only on the connection's own store, and every such write
(the common way an agent writes into a shared workspace) was announced to
nobody. A hint that is lost — a crash between the
write and the stamp, a writer that sends none (Obsidian writing to the bucket
directly, the email worker's store, calendar and mail sync) — costs freshness
and nothing else: the five-minute walk reconciles it.

What a simplification costs, and what fails:

- One stamp per workspace, or judging only the state after the change: "a
  private note moves the owner's hint and not a member's" and "making a shared
  note private tells the member it went" (`treeSignals.test.ts`), and "a note held back
  from a shared folder moves without telling the team" / "a shared note moved
  somewhere private still tells the team it went" (`treeHints.test.mjs`).
- Stamping every save: "an edit to an existing note moves nobody's hint" and
  "an edit to an existing note sends nothing".
- Throwing to a refused caller: "a non-member is told nothing, the same
  nothing as a context that never changed".
- A store `openContext` builds without its own reporters: "a cross-context
  create tells the context it landed in that its tree changed"
  (`crossContext/changeReporting.test.mjs`).
- Not asking for a walk on a new value: "a hint that the tree changed asks for
  a walk, and its first value does not" (`fileTreeMetadata.test.ts`).

**Limits.** A hint triggers a whole-manifest walk, so a very large bucket pays
a full listing per burst of changes (the refresh is single-flight per context,
so a burst is one extra walk, not one per write). A gateway move reports its
source's audience only where the tool records `source_visibility`; elsewhere a
reader who could see only the source converges at the next periodic walk. The
writer's own console also receives its hint and walks once more; that walk
confirms what the optimistic listing already drew.

