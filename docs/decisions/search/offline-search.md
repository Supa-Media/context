# Search — offline search

### With no connection, search reads the copy on the device, and says so

The owner wants this app to replace Apple Notes and Obsidian, and both of those
search with no signal. Ours did not: the palette's search is a Convex action and
the page's is another, so offline the palette spun for ten seconds and said the
search could not be run, and the page drew "nothing to search" because its scope
is a subscription — on a phone whose mirror (see
[app & console](../app-and-console.md), *Every note on the device: the mirror*)
holds every note body the person can see.

`features/offline/mirrorSearch.ts` searches that copy. Four decisions, and what
reversing each costs:

**It is a disposable derivative of a disposable derivative, reconciled on every
query.** An in-memory map of the mirror's bodies, pre-folded for comparison,
never written anywhere; deleting it costs one slower search (non-negotiable #3).
The section *The console searches through the gateway's search, not a copy of
it* is not reversed by this: online, the gateway still answers and the device is
never preferred over it. What makes a memo acceptable here — `palette.ts` argues
at length that a memo is how you rank notes that are gone — is that the mirror's
**index is re-read before every search** and the memo keeps exactly the notes it
names at the etags it names. A note a sync pruned (a grant lost elsewhere) is gone
from the next search, a changed note is re-read, and the index being byte-for-byte
unchanged is what lets a keystroke skip the reconcile. Remove the reconcile and a
note the server stopped letting this person see stays searchable until the app
restarts: "a note the index stopped naming is not found…", "a note that changed is
searched at its new version", "a note that became encrypted drops out…"
(`offlineMirrorSearch.test.ts`) all redden.

**One clearance, one workspace, never ciphertext.** It reads the index and the
bodies at exactly the tier `visibilityTierForRole` gives — the tier the sync filed
them under — and never through `readableAt`'s widening, under which an owner's
offline *open* may fall back to a `team` copy. `mirroredBodyAt` exists so a body
is only ever read from the clearance whose index named it. An encrypted note is
skipped whole, name included, and counted, so "2 encrypted notes were not
searched" is true. The memo is dropped whole when the session epoch changes, and
`forget.ts` drops it beside every clear of the mirror (sign-out, Leave, a
membership that ended elsewhere); a first search that is still reading bodies
when either lands answers nothing. The cost of exact-tier-only: somebody promoted
from member to owner finds nothing offline until the next sync, while a note can
still be opened from the old `team` copy. Sabotaged: reading at `private`
regardless reddens "a team search never reads a body filed at the private
clearance"; searching encrypted entries reddens "an encrypted note's ciphertext
is never searched"; a memo keyed without the workspace reddens "one workspace's
search never sees another's notes"; dropping the epoch or forget checks reddens
the two "in the middle of the first search" tests; dropping `forgetMirrorSearch`
from `forget.ts` reddens "every ending also drops what the device search holds
in memory" (`offlineMirrorForget.test.ts`).

**When it answers is the smallest rule that removes the defect.** Offline, the
device answers after the debounce and the bucket is **not asked** — asking buys
the ten-second spinner for an answer that cannot arrive. Online (and `unknown`,
for `connectionLine`'s reason), the bucket answers as before; only a refusal or
a timeout falls back to the device. Showing the device's answer first and
swapping in the bucket's was considered and not done: the two rank differently,
so the list would reorder under a thumb about to press a row. The same rule runs
on the search page, which takes the console's own context list (remembered on a
cold start) because its `searchableContexts` subscription is empty offline, and
blends per-context answers by rank with the control plane's `1 / (60 + rank)` —
a device score counts occurrences in notes of different sizes and is no more
comparable across contexts than BM25 is. Tests: `contextSearchDevice.test.ts`
("offline never waits on the bucket", the two fallbacks) and
`blendedSearchDevice.test.ts`; asking the server first while offline reddens
four and two of them respectively.

**It says so, every time.** Every device answer carries a notice: that it is the
device's copy, why ("Your bucket did not answer, so…"), how much of the context
is there from `mirrorStatus` ("Only 340 of 1,204 notes are on this device yet"),
and the encrypted count. A context with nothing mirrored is named rather than
answered as "no matches", partial copies make the page's total a floor, and the
fast-search upsell is hidden under a device answer because "searched from your
own bucket" would describe a search that did not happen. A browser with no
mirror (a private window) says search needs a connection there instead of
spinning. Quick open by name, offline, lists every path in the mirror's index
rather than only the folders expanded before the signal went (`itemsFromPaths`).

**Matching is deliberately not the gateway's.** Case- and accent-insensitive
substring matching, every term required somewhere in title, path or body, title
and path matches ranked above body matches, snippets cut from the line the hit is
on (around the hit on a long line), in the server's `{ path, title, snippets }`
shape. The gateway stems; agreeing with it word for word would mean shipping its
tokenizer and index to the phone, and substring finds a superset of a stem. So
the same query can rank differently online and off — acceptable because every
offline answer is labelled.

**What it costs, and what is unmeasured.** The first search after a launch reads
every body (one file per note on native, one IndexedDB record on the web); later
searches scan folded strings in memory. Measured in node over 3,000 synthetic
notes of ~2.5KB: ~70ms cold, under 20ms warm (the test asserts < 60ms warm).
Hermes is slower than V8 and the first read is one `expo-file-system` read per
note, so the cold number on a phone is unverified until somebody runs it on one.
Memory is about twice the searched text; each note is searched and held up to
`MAX_SEARCHED_CHARS` (200,000), past which a term is a miss. Not built: showing
device results when the gateway answers `indexMissing`, which would be strictly
better than "still being indexed" and is the obvious next step.
