# Storage and credentials — conditional writes and the archive

## A conditional write is the guard a conditional delete would have been

A move is copy-then-delete, and the delete is the half that can destroy work:
an edit landing between the two is lost, and the copy already taken is the
older version. So every move required `conditionalDelete` and refused without
it — the right instinct, applied to the wrong primitive.

**R2 does not enforce `If-Match` on DELETE.** Measured, after the capability
backfill above made it measurable: the probe declares the capability, tests it,
and every binding in production answered `false`. The consequence was total and
went unnoticed because it was worded as somebody else's fault — no note could
be moved, renamed, batched or handed to another workspace, on the storage this
product runs on, and each refusal named the storage provider. `conditionalWrite`
and `conditionalCreate` were `true` throughout.

The substitute is a conditional **write**, in `retireMovedSource`:

1. PUT the source path with `If-Match` on the etag that was copied. Atomic, and
   it fails if anybody touched the note — the same conflict the conditional
   delete reported, from the same evidence.
2. The object at that path is now a zero-byte marker of ours, so the DELETE
   that follows needs no precondition: there is nothing there left to lose.

`moveSafetyRefusal` therefore accepts **either** conditional, and a store with
neither is still refused by name. That is not a softening: a store that cannot
claim a path cannot move a note safely, and B2 and Wasabi remain refused.

**Trash is a cross-workspace concern only.** A same-workspace move needs no
extra copy, because the destination *is* the copy — a third one in the same
bucket is storage the customer pays for to hold what they already have. A
cross-workspace move is the exception, and the reason is the one thing it
cannot promise: its destination is a different bucket, which the owner may stop
being able to reach. So that move alone leaves the source bytes under
`.context/trash/<timestamp>/<original path>`, plumbing and therefore invisible
to every listing, search and privacy decision.

**What a simplification of this would cost.** Dropping the conditional claim
and deleting outright is the silent data loss, and it is three checks in
`test/moveWithoutConditionalDelete.test.mjs` — measured by sabotage, not
assumed. Accepting a store with neither conditional lets a move start that can
only finish unsafely. Taking the trash copy after the claim archives the
marker instead of the note. Keeping the old requirement in
`deleteObjectForMove` lets a large folder cut over logically and then never
materialize, which is worse than refusing up front.

## Which folder is "the archive" is a question, not a constant

`4-archive` was a literal in two places that had to agree and did not.
`archive_note` refused any context whose manifest did not declare it;
`archivePath`, behind the console's archive button, created it regardless. That
disagreement was invisible while `4-archive` was the only archive this product
shipped, and stopped being invisible the moment the `company` preset shipped
`5-archive` — **the default layout for a shared workspace**. The most common
shared context we create therefore had a folder plainly named the archive,
declared in its manifest and sitting in its own root listing, that Claude
refused to use while the console quietly opened a second archive beside it, in
a bucket the owner also reads in Obsidian. A customer archived a note by hand
and was told their context had no archive.

The refusal was right and its premise was wrong. Refusing to *invent* a
destination in somebody's bucket is the same rule `save_context` and the
connect instructions were purged for breaking — a layout is the owner's, and
an agent tidying up must not create a top-level folder they did not choose.
What was wrong was reading "has an archive" as "declares this exact string".

So `archiveRoot` resolves it from the manifest, and both surfaces call it:
`<number>-archive` or plain `archive`, case-insensitive, matched on the rule's
root segment so a rule naming something *inside* the archive still says the
folder exists. **A shape and not a list** — a list is the same assumption with
one more entry, and the next preset would reintroduce the bug it was written
for. `SESSION_FOLDERS` and the router's preview mirror are computed off the
archive roots this product ships for the same reason.

**It resolves; it does not guess.** `retired`, `old` and `cold-storage` all name
the same idea, and a folder name is not enough to know one is meant. Widening a
shape must not drift into inferring intent, so those still refuse, and
`archiveResolution.test.ts` pins the line — including `archived`, `archives` and
`my-archive-notes`, which merely contain the word.

**`4-archive` wins whenever it is declared at all.** Every context that already
had an archive keeps filing where its history is, so the installed base cannot
be moved by this. Absent that, the answer is the first in sorted order — a
property of the *set*, never of manifest order, because reordering `privacy.md`
must not silently repoint archiving. And "already archived" is measured against
**every** archive a context has, not the one that would be written to, or a note
put away in `5-archive` would be picked up and moved again into a `4-archive`
declared beside it.

Two consequences worth naming rather than discovering. `defaultSessionFolder`
resolves through the same function, so a context whose archive is not
`4-archive` now files new sessions beside its archive instead of into
`0-inbox/sessions` — the behaviour that function always described, reaching
contexts it had been failing to recognise; sessions already written stay where
they are. And `archivePath` adopts the gateway's refusal, so a layout with no
archive at all is now told so by the console instead of being given one: a
capability removed on purpose, because the thing it did was the invention the
gateway refuses.

**What a simplification costs.** Going back to a literal restores a bug whose
blast radius is "the default shared layout". Letting the two surfaces keep
their own copies of the answer puts one bucket's archive in two folders
depending on which one the person used, with neither reporting anything wrong —
which is why the differential in `archiveResolution.test.ts` drives the
gateway's real resolver rather than a restatement. Dropping the `4-archive`
preference moves the archive of every PARA context that ever gains a second
one. Narrowing "already archived" to the write destination re-archives notes
that were already put away. Both of those last two were **measured**: each was
sabotaged, each left the suite green, and the manifests and the check that now
catch them were added because of it.
