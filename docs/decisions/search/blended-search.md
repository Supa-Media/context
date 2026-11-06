# Search — blended search

### A blended search over several contexts fuses ranks, and the control plane is where it happens

"Making wikis: people's own personal Google for their organization's workspaces
or their own workspace." A new teammate types *review cycle* and reconstructs the
concept out of four notes in three contexts, none of which is a canonical page.
That is a different question from the one `search_notes` and the console's
palette answer, and it is the only question in this system that spans more than
one workspace — so every decision it forced is here rather than inferable.

**The fan-out is in the control plane, and it calls the same `searchNotes`
everything else calls.** `apps/convex/functions/files.ts`'s `searchContexts`
resolves a scope, runs one `search` operation per context concurrently, and
blends the answers. It contains no ranker, no snippet, no store and — the part
that matters — **no privacy filter**: `searchNotes` owns all of it, once, for
the console, the blended page and `search_notes` alike. The rule two sections
above ("the console searches through the gateway's search, not a copy of it") is
the same rule, extended to a fourth caller; a blended search that re-derived who
may see a hit would be the copy that is hardest to notice is wrong, because
nobody would think to test it per tier.

The gateway was the alternative and is the wrong home twice. A Worker has a
fifty-subrequest ceiling per invocation, which a fan-out over eight customers'
buckets walks into on its own; and the console would then need one request per
context per page, which is the property the page exists to avoid — one request
per page, whatever the scope.

**Ranks are fused, not scores, because there are no comparable scores.** BM25 is
scored against a corpus, and `N`, `df` and `avglen` are properties of the
context a note lives in and the *tier* the caller reads it at. A twelve-point
hit in a four-note workspace and a twelve-point hit in a four-thousand-note
workspace are not the same quantity; min-maxing them into a shared 0..1 invents a
comparison and hides that it was invented, and the failure it produces is the
obvious one — the biggest context sweeps every page, because a big corpus
produces a big spread. So each source contributes `1 / (60 + rank)` in its own
list: same ladder from every context, and a context's first result always beats
any context's third. The numbers themselves never leave the ranking modules,
which is also why they *could* not be normalized without exporting the one thing
that lets a caller tell which derivative answered.

**Corpus-independent evidence is added on top of the fused ranks (decided by the owner,
2026-11-03).** The ranks are still fused for BM25, and nothing above changes. But two facts about a
hit do not depend on any workspace's corpus, because they are read from the query and the hit alone:
whether its title or file name holds the query's words (the share of the query's terms,
`titleCoverage`), and whether the whole query appears as one phrase in its title, file name or a
snippet (`hasPhrase`). Those are comparable across workspaces, so the gateway's `search_notes`
(`apps/mcp`, `fuseEverywhere`, the pure rules in `search/evidence.js`) adds `TITLE_WEIGHT` times the
coverage, plus `PHRASE_BONUS` for a phrase, to each counted word hit before the path prior
multiplies the score. The bonus is sized against the rank ladder, not against BM25 scores:
`TITLE_WEIGHT` is 1/305, a fifth of a rank-0 hit, and `PHRASE_BONUS` is 1/122, half of one. Starting
at 1/61 for the title, as first proposed, does not hold: a hit ranked tenth on words and meaning,
with its title holding every word, would then score above a note first on both. A loose any-word hit
gets no bonus while any workspace has a strict one, so the existing rule on loose hits covers the
new evidence too. Why: production, 2026-11-03, "workers comp renewal" put another workspace's rank-0
hit, a note that only links to the renewal, above the page titled with every word, and "2027 plan
objectives owners" put the plan's overview third, below an archived chat log and two other notes.
Rank fusion cannot see that a title holding the whole query is more than a rank-0 body match in a
workspace whose BM25 scores are on another scale. What this does not change: the control plane's
blended palette (`searchContexts`) fuses its own answers and is not changed by this decision;
bringing it to the same evidence is a separate decision. Reverting the bonus fails the two
production-shaped cases in `apps/mcp/test/searchEverywhere.test.mjs`; dropping the query on the way
from `searchEverywhere` to the fusion fails "the query reaches the fusion" in the same file, which
drives `toolSearchNotes` across two workspaces (the fusion tests pass their own query, so only that
one sees the wiring); "a title match alone does not beat a note strong on both word rank and
meaning" fails if the title weight goes back to 1/61, and "a loose hit gets no title bonus while a
strict hit exists" fails if a loose hit is credited.

**A note whose name answers the question is a word hit, and leads the word hits (2026-11-06).**
Each workspace's word search also asks the query's content words against titles and file names
alone, one row per note (`search/named.js`, `toNameMatchExpression`). Where some note held every word
of the query, a hit from either search whose title or file name holds at least half of the query's
content words, and at least two of them, moves to the front of that workspace's word hits, most of
the words first; it is a word hit, not a loose one, even if it lacks a word the others hold. Where no
note held every word, nothing moves and the any-word order stands. Content words are the query's
words of three letters or more without the ones that only say how it is asked (`FILLER_WORDS`:
"how", "why", "against", "other"), and a word counts as held in any of its forms ("positioning"
holds "position"); title coverage for the evidence bonus above reads them the same way. Why: the
real-search check of 2026-11-04 missed "why I started Context" (`why-context-started.page.md`) and
"how we position Context against other AI memory tools" (`positioning.md`) from every workspace,
while each ranked first or second inside its own folder: meeting transcripts holding every common
word many times outranked them, and the words that pick them out are only in their names. The
condition on a strict hit is the search benchmark's q54 ("book club snack rules"): without it, notes
named with the workspace's own words ("book club") lifted over the rules note, a loose hit, and
pushed it out. Reverting the lift fails the checks in
`apps/mcp/test/searchProjection/named.test.mjs`; reading the name search from every chunk fails "a
long note asks the name search once".

**Every context the caller is in is searched, and each one says which index
answered it.** This reverses the rule that shipped with the blended page, and
the reversal is the most useful thing in this section, so both sides are kept.

The original rule was *eligibility is fast-search-only*: a blended page searched
only the contexts whose projection the control plane calls `ready`, because a
context without one answers from the R2 shard index in the customer's own bucket
— a manifest, some shards and a read per snippet — which is fine for one context
with one person watching one spinner and does not obviously fan out: eight
buckets' round trips inside one deadline, most of them for contexts the word is
not in. `backfilling` was excluded as well as `off`, on the theory that a
half-filled projection answers a query about a note it has not copied with a
silence a blended list renders as "nothing here". The cost was carried as copy
rather than as an absence — a person with no eligible contexts was told that
nothing *looked*, which is a different sentence from "nothing matched" — and
`fastSearch.searchableContexts` answered `{ eligible, notEligible }` so the page
could nudge an owner toward the switch.

**What that produced was a search page that searched nothing**, for the ordinary
account: fast search is off by default and is a paid entitlement, so somebody
with four contexts and a question got four lines naming a setting. The sentence
was true, the page was a dead end, and the person had notes in every one of
those buckets. Two things settle it. First, `functions/lib/fastSearch.ts` had
already decided what "off" means and this page was the one surface disagreeing:
*"either condition false means the existing R2 shard index serves the search,
exactly as it does today… the fast path is an upgrade, and its absence is the
product as it already is, rather than a broken search waiting for a toggle."*
Second, the cost was already bounded in the right place — `SOURCE_DEADLINE_MS`
gives every source its own deadline, so a slow context costs its own row and
never the page.

So `searchScopeFor` answers one list, `{ contexts }`, holding every live
membership, and each entry carries `search: "fast" | "slow"` beside the settings
card's own `FastSearchState` and `owner`. `searchableCount` (was
`eligibleCount`) is now zero only for somebody in no context at all, which is
the one thing that sentence was ever true of.

**`backfilling` is searched too, and cannot lose a result.** The silence it was
excluded for was never real: `search/d1/serve.js` treats a projection miss as a
reason to go and ask the R2 index the expensive way — *only a hit
short-circuits* — so a half-built index can be slower than a finished one and
cannot be wrong. That is a sentence on the page, not a reason to leave a context
out of somebody's own search.

**The nudge became an upsell, and the distinction is the point.** A nudge stood
in place of results; the upsell sits under them. Rows name each slow context and
carry a press only where one exists, to one of *two* destinations, because
`lib/fastSearch.ts` keeps entitlement and opt-in apart and this is the surface
where that separation earns itself: an owner who is not entitled goes to
Premium, an owner who is and has not opted in goes to the switch. A member gets
the sentence and no button — what a person can do about a fact is not what
decides whether they are told it, which is the same rule `noteworthySources`
already follows for a source mid-search. What is still refused is the thing the
old paragraph was really refusing: a **silent** fan-out over the R2 index, one
that made the page look populated without saying that four of these answers came
from buckets and could be instant.

**What reverting any of this costs, and what reddens.** Narrowing the scope back
to `ready` projections returns the dead end to every account that is not paying,
which is the defect this section exists because of;
`__tests__/blendedSearch.test.ts` asserts that a context with `optedIn: false`
and a context mid-`backfilling` both return **results**, where the same tests
previously asserted an empty page and a count of zero. Dropping the per-context
`search` field collapses the upsell into either silence or a claim that every
answer was instant; `consoleSearchPage.test.ts` holds the sentence per state and
the two destinations, and `searchUpsell.test.ts` holds them mounted. And
widening the scope to every membership is precisely the change that makes this
file's isolation assertions worth re-reading, so they stayed as they were: a
workspace the caller is not a member of appears in no list, and the other
tenant's **recorded bucket requests** do not move.

**A miss does not buy a listing here.** `searchIndexedNotes`' rule — an empty
answer over a converged index may pay for one bucket listing and ask again — is
right for a single context and wrong multiplied. A fan-out misses in most of its
scope by construction, so the rule would spend a full listing per context per
keystroke, on each of those customers' request quotas, to rediscover that a word
is not in seven of eight workspaces. `searchNotes` takes `refreshOnMiss` and the
fan-out passes false. Nothing is lost from the honesty the rule bought: a source
whose index is behind still reports itself `indexing` per source, and the page
draws that beside the results rather than folding it into "no matches".

**A source that failed makes the blended total a floor**, which is the rule at
the top of this file applied to a fan-out: a walk cut short stops the count
claiming to be exact. It is worth stating separately because the shape of this
answer makes it easy to lose — nine contexts answered, the tenth threw, and
summing the nine into `matchCount` with `matchCountIsFloor: false` prints a
confident number over a scope that was only half searched, on the one page whose
whole promise is "everything you can reach".

**It schedules maintenance for one case only: a context with no index at all.**
The single-context search schedules a pass behind any lagging index, because
somebody searching one context is the cheapest possible trigger for catching
that context up. Multiplying that by the width of a scope would put a bucket
listing per context behind every keystroke, on each of those customers' quotas,
so a merely *incomplete* index is still left to the passes that ride the
gateway's own searches.

A **missing** one is different in kind, and it is a state this page created for
itself the moment it started searching contexts without a projection: a context
nobody has ever searched directly has no shard index, answers every query
`indexMissing`, and would report "still being indexed" here forever — a
permanent apology no amount of waiting resolves. So the first page of a search
schedules one `INDEX_SYNC_CHAIN` per such context and no more: later pages of
the same query schedule nothing, and the condition is self-limiting, because a
context indexed once is never `indexMissing` again. It is scheduled and never
called, for the reason every pass in this system is — `ctx.runAction` would put
a full listing of somebody's bucket in front of the person waiting for the page.

**Paging is a per-source cursor, and the cursor carries no query text.** Each
page records how far down *each* context's own ranked list the reader has come,
so page two resumes each one where page one stopped — a single global offset
would re-read a context that contributed one result from the top. The depth
ceiling is `MAX_RESULTS`, where the ranking itself is cut, so a blended search
reaches fifty notes per context and going deeper is a change to the ranker
rather than to the page.

The cursor holds a 32-bit fingerprint of the query and integers, never the
words. `?q=` in the URL is a restorable search somebody typed on purpose and is
worth the trade — a search you cannot link to or reload is not a page — but a
cursor is machinery, it rides in retries and logs, and a second copy of the same
vocabulary travelling in something nobody reads is how note text escapes the
surfaces that were reviewed for it. **A cursor also cannot name a context to
search**: the scope comes from the live searchable list every page, the offsets
are consulted only for keys that list already contains, and every value is
clamped — a negative offset would otherwise slice from the *end* of a ranked
list, which is a page nobody could otherwise reach. `__tests__/blendedSearch.test.ts`
asserts the crafted cursor over the other tenant's **recorded bucket requests**
rather than over the response, because a response that omits what it read is
still a read.

**A scope list can only narrow, and a forbidden id is dropped rather than
refused.** `isolation.test.ts`'s rule applied to a list: an endpoint that
answered differently for a real-but-forbidden workspace than for an invented one
is an oracle, and this one accepts a hundred guesses per request. So the
requested ids are intersected with the live searchable set and the remainder
disappears silently, whether they name another tenant's context or nothing at
all. (A context whose owner has fast search off used to disappear here as well,
and no longer does — it is in the scope, marked slow.)

**The palette asks the words and the meaning as two halves** (the search
tune-up, Dev2's pick, 2026-10-27). A merged answer waited, in every
workspace, for the meaning lookup and its snippets before any row was drawn.
`searchContexts`
takes `half: "words" | "meaning"`: the app asks both at once, draws the words
the moment they land, and appends the meaning rows below them when they
arrive, so no drawn row moves (`withMeaningRows`). The words half reads no
meaning credential. The meaning half ranks its rows across
workspaces by closeness (one model scored them all, so here the scores are
comparable), has one page, and marks each row `close` when it reaches
`MEANING_EXTRA_FLOOR_WITH_WORDS`; when the words found notes with every word,
only close rows join. Absent `half` is the merged search, which older apps and
AI clients still get. Only the half a person waits on records a timing row.
Each workspace still embeds the question for itself, in parallel: embedding
once in the action would read the integration secret from a public function,
which `__tests__/structure/` forbids, and the wait is the same.
Reverting fails `apps/convex/__tests__/consoleSearchHalves.test.ts` and "words
are drawn while meaning is still out" (`apps/mobile/__tests__/blendedSearchHook.test.ts`).

**What v1 does not have, and why.** No author, no content type, and no
updated-date filter. The projection stores `notes.uploaded` as `null` by
construction — the backfill has no listing of its own — and neither index
carries an author at all, so all three would be new index fields, which this
change deliberately does not add. The date filter is the one worth revisiting:
it needs the listing plumbed through the projection pass, which is a change to
what the sync returns, not to the page.
