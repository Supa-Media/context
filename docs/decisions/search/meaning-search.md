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
