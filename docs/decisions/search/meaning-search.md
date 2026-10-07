# Search — by meaning

### Search by meaning is on for every workspace, free and Premium, and an owner can turn it off

Decided by the owner on 2026-10-07: "yes build it, and for free plan too", then,
on the two questions that followed, **one list** (results found by meaning sit
in the same list as the word matches, marked "Same topic, different words") and
**on for everyone** (every workspace gets it without asking; the owner can
switch it off).

That second answer deliberately reverses, for this one derivative, the rule in
[A database we own holds a copy of somebody's notes only where they asked](./gateway-search-and-projection.md#a-database-we-own-holds-a-copy-of-somebodys-notes-only-where-they-asked).
Fast search stays opt-in and Premium. Search by meaning is the owner's call to
make differently, and it is recorded here so nobody "fixes" it back to opt-in,
or extends it to fast search because the two look alike.

**What is kept, and where.** One Cloudflare Vectorize index per workspace,
named `context-meaning-<workspaceId>` from the immutable id, in the same account
and under the same credential as the per-context search databases
(`SEARCH_D1_API_TOKEN`, `SEARCH_D1_ACCOUNT_ID`). One index each, never a shared
index with a filter per tenant, for non-negotiable #2's reason: the index is
deleted whole when the workspace turns it off or is deleted, and one tenant's
query cannot reach another's vectors because it names a different index. The
account allows 50,000 indexes; that ceiling is a constraint on the product and
the reason this cannot fall back to namespaces inside one index.

Each note becomes at most twelve passages of about 1,500 characters
(`apps/mcp/src/search/meaning/project.js`), each embedded with Workers AI
`@cf/baai/bge-m3`. A vector's id is a hash of the note's path, never the path,
and its metadata is the path, the passage number and a tier. **No text is
stored in the index**: a snippet is read from the bucket at answer time. A
vector is not the note, but it is not nothing either. Embeddings can be partly
inverted, which is why this is a decision rather than an implementation detail,
and why off deletes the index rather than hiding it.

**Privacy is decided when the answer is served, never by the index.** The tier
(`team`, or `private` for private and group-addressed notes; a visibility we do
not recognise indexes nothing) is a ranking aid that keeps a member's top
results from filling up with notes they cannot open. Every hit still goes
through `canSee` against the live `privacy.md` before it is returned, so a note
whose visibility changed since it was indexed is filtered on the next search, not
on the next re-index.

**The row outlives the index.** `meaningIndexes` follows fast search's
discipline: no row means never set up, `disable` marks the row `releasing` and
schedules the delete, and the row goes only when Cloudflare confirms the index
is gone (a 404 counts). Deleting a workspace turns it off through the same path.
A failed delete leaves the row `releasing`, which is something to find, rather
than an index nothing points at.

What a "simplification" would cost: storing passage text in the metadata makes
snippets one request cheaper and puts note content in a second place we hold;
filtering by tier alone instead of `canSee` serves a note that was made private
an hour ago; a single shared index ends the clean delete. The tests that fail:
`apps/convex/__tests__/meaningSearch.test.ts` (setup, adoption, release order,
cascade) and `apps/mcp/test/meaningSearch.test.mjs` (passages, ids, tier, the
filter, nothing sent before every vector is checked).

### Notes reach the index two ways, and a map in the bucket says which are in

Decided 2026-10-07 while building it. A note saved by an AI client or a form is
embedded behind the response (`apps/mcp/src/search/meaning/store.js`).
Everything else reaches the index through a **catch-up pass**
(`catchup.js`, run by the control plane in `lib/filesFns/meaningPass.ts`):
notes that existed before the index, what a move adds, edits made outside
the product, and edits made in the live editor, which skips the write path
because it commits every typing pause and re-embedding twelve passages per
pause buys nothing.

The pass diffs the R2 index's own census (`[path, version]`) against a map of
what it last embedded, kept at `.context/search/meaning/v1/state.json`. That
is a **new file in the on-bucket layout**, and it is allowed for the reason
the R2 index is: Context-owned plumbing under `.context/search/`, a
disposable derivative, rebuildable from the notes, never the only copy of
anything. Losing it costs one full re-embed. It does not live in the control
plane because the control plane holds metadata and never a list of somebody's
note paths; it does not live in Vectorize because an index has nowhere to keep
one. It carries a `generation` (when the index was turned on), so an index
recreated after an off and an on is not mistaken for the old one.

The pass is scheduled when the index is set up and chains while it moves. A
sweep every fifteen minutes restarts a stalled chain, catches each `ready`
index up once a day, and retries a failure that waiting can fix. A `ready`
index stays `ready` while it catches up, because the notes it holds are still
worth searching. An encrypted note is embedded as its title only, as fast
search projects it.

### An AI search asks both ways at once, and meaning can only add

Decided 2026-10-07 while building it, on the owner's "one list". `search_notes`
and ChatGPT's `search` ask the word search and the meaning index together
(`apps/mcp/src/search/meaning/serve.js`) and merge the two by reciprocal rank,
so a note both find rises and a note only meaning finds places among the word
hits. **Every word hit stays**; meaning adds at most three notes the words
missed, each marked "Same topic, different words" and shown with a snippet read
from the bucket at answer time. A note that cannot be read now (moved, deleted,
or outside what this connection's store will open) is dropped rather than
listed blind. Matches below a closeness of 0.55 are noise and dropped.

A failing model or index costs nothing but the merge: the word answer comes
back unchanged, the miss text says it searched words only, and one log line
carries a closed code. The extra cost per search is one embedding, one query,
and up to three reads, inside the free tier's 50-subrequest ceiling that the
word search's 40-op budget was set under. The tests that fail if any of this
is loosened: `apps/mcp/test/meaningServe.test.mjs`.

The app's own search asks the same way (`lib/fileOps/search.ts`, merging into
whichever word index answered), keyed by `path`, with the hit carrying
`meaningOnly` for the "Same topic, different words" label. The barrier looks
the index up beside fast search's database and, like it, **a search never
writes the row**: a deployment with no credential searches words only rather
than marking the index failed because somebody typed. A member who answers to
a group asks the index for every tier, since a group note is indexed as
`private`, and `canSee` with their granted names decides as it does for words.
Tests: `apps/convex/__tests__/consoleMeaningSearch.test.ts` and the "a console
search" block of `meaningPass.test.ts`.

### On for everyone means a walk over storage, a proof first, and an off that sticks

Decided 2026-10-07 while building the owner's "on for everyone". The
15-minute sweep walks `storageBindings` a page at a time and turns search by
meaning on for each bound workspace that has no `meaningIndexes` row
(`lib/meaningFns/rollout.ts`); at the end it starts over, so a workspace that
connects storage later is reached on a later lap. Bindings rather than
workspaces, because an index is built from a bucket: a workspace with no
storage has nothing to embed.

**A row of any kind is a decision, and the rollout never overrides one.** The
owner's switch (`meaningSearch.set`, owner-only like fast search) turning it
off keeps the row through the index's deletion and ends it at `off`; only the
owner turning it back on clears that. Losing storage releases the index too
(`fastSearch.releaseForStorage` releases both) and removes the row, unless the
owner had switched it off, so a reconnected workspace is picked up again.
Deleting the workspace keeps nothing.

**The credential is proven on one workspace before it is spent on all.** It
needs Vectorize and Workers AI permissions fast search never did. Until one
index is serving, the rollout turns on one workspace at a time and waits while
that one is being set up or has failed, so a missing permission costs one
failed row, retried every six hours, rather than one per workspace.
`MEANING_SEARCH_ROLLOUT=disabled` on the deployment stops the walk without a
deploy. Tests: `apps/convex/__tests__/meaningRollout.test.ts`.
