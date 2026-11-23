# Search and the derived index

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Search answers from a derived index, and the index is budgeted, filtered, and disposable

Moved to [Search answers from a derived index, and the index is budgeted, filtered, and disposable](./search/shard-routing.md#search-answers-from-a-derived-index-and-the-index-is-budgeted-filtered-and-disposable).

### A search reads a ready index, and never builds one

Moved to [A search reads a ready index, and never builds one](./search/shard-routing.md#a-search-reads-a-ready-index-and-never-builds-one).

### A write indexes its own note, and only a listing decides what is gone

Moved to [A write indexes its own note, and only a listing decides what is gone](./search/shard-routing.md#a-write-indexes-its-own-note-and-only-a-listing-decides-what-is-gone).

### …and it opens the shards that can answer it, not all of them

Moved to […and it opens the shards that can answer it, not all of them](./search/shard-routing.md#and-it-opens-the-shards-that-can-answer-it-not-all-of-them).

### The manifest is the query surface, and the diff moved out from under it

Moved to [The manifest is the query surface, and the diff moved out from under it](./search/shard-routing.md#the-manifest-is-the-query-surface-and-the-diff-moved-out-from-under-it).

### The console searches through the gateway's search, not a copy of it

Moved to [The console searches through the gateway's search, not a copy of it](./search/gateway-search-and-projection.md#the-console-searches-through-the-gateways-search-not-a-copy-of-it).

### A database we own holds a copy of somebody's notes only where they asked

Moved to [A database we own holds a copy of somebody's notes only where they asked](./search/gateway-search-and-projection.md#a-database-we-own-holds-a-copy-of-somebodys-notes-only-where-they-asked).

### A name already taken in our own account is this context's database

Moved to [A name already taken in our own account is this context's database](./search/gateway-search-and-projection.md#a-name-already-taken-in-our-own-account-is-this-contexts-database).

### The gateway writes the projection, so the credential rides on the binding

Moved to [The gateway writes the projection, so the credential rides on the binding](./search/gateway-search-and-projection.md#the-gateway-writes-the-projection-so-the-credential-rides-on-the-binding).

### A context with a search database is answered by it alone, never by the bucket

Moved to [A context with a search database is answered by it alone, never by the bucket](./search/gateway-search-and-projection.md#a-context-with-a-search-database-is-answered-by-it-alone-never-by-the-bucket).

### Progress is reported to the control plane, which owns the row

Moved to [Progress is reported to the control plane, which owns the row](./search/backfill-and-switch.md#progress-is-reported-to-the-control-plane-which-owns-the-row).

### The backfill percentage is derived, and inherits the census's owner-only gate

Moved to [The backfill percentage is derived, and inherits the census's owner-only gate](./search/backfill-and-switch.md#the-backfill-percentage-is-derived-and-inherits-the-censuss-owner-only-gate).

### The switch lives in a context's settings, and the server owns who may throw it

Moved to [The switch lives in a context's settings, and the server owns who may throw it](./search/backfill-and-switch.md#the-switch-lives-in-a-contexts-settings-and-the-server-owns-who-may-throw-it).

### Corpus statistics are per tenant, which is why it is a database each

Moved to [Corpus statistics are per tenant, which is why it is a database each](./search/backfill-and-switch.md#corpus-statistics-are-per-tenant-which-is-why-it-is-a-database-each).

### The gateway copies the notes, and a search is what starts it

Moved to [The gateway copies the notes, and a search is what starts it](./search/copy-pass-and-descriptor.md#the-gateway-copies-the-notes-and-a-search-is-what-starts-it).

### …and the control plane runs the same pass for a person who is not there

Moved to […and the control plane runs the same pass for a person who is not there](./search/copy-pass-and-descriptor.md#and-the-control-plane-runs-the-same-pass-for-a-person-who-is-not-there).

### …and a search reads it, which for a year it did not

Moved to […and a search reads it, which for a year it did not](./search/copy-pass-and-descriptor.md#and-a-search-reads-it-which-for-a-year-it-did-not).

### The descriptor is a sibling of the binding, and the gateway reads it there

Moved to [The descriptor is a sibling of the binding, and the gateway reads it there](./search/copy-pass-and-descriptor.md#the-descriptor-is-a-sibling-of-the-binding-and-the-gateway-reads-it-there).

### …and the console asks the same projection, through the same answer

Moved to […and the console asks the same projection, through the same answer](./search/copy-pass-and-descriptor.md#and-the-console-asks-the-same-projection-through-the-same-answer).

### One round trip, and why it cannot be zero

Moved to [One round trip, and why it cannot be zero](./search/copy-pass-and-descriptor.md#one-round-trip-and-why-it-cannot-be-zero).

### A blended search over several contexts fuses ranks, and the control plane is where it happens

Moved to [A blended search over several contexts fuses ranks, and the control plane is where it happens](./search/blended-search.md#a-blended-search-over-several-contexts-fuses-ranks-and-the-control-plane-is-where-it-happens).

### A note is the unit of the index, except when it is bundled mail

Moved to [A note is the unit of the index, except when it is bundled mail](./search/index-sizing-and-sharding.md#a-note-is-the-unit-of-the-index-except-when-it-is-bundled-mail).

### The index is sized by the volume it has to hold, and an oversized part sheds rather than taking the rest with it

Moved to [The index is sized by the volume it has to hold, and an oversized part sheds rather than taking the rest with it](./search/index-sizing-and-sharding.md#the-index-is-sized-by-the-volume-it-has-to-hold-and-an-oversized-part-sheds-rather-than-taking-the-rest-with-it).

### A shed index must say so to the caller it happened to, not only to the operator

Moved to [A shed index must say so to the caller it happened to, not only to the operator](./search/index-sizing-and-sharding.md#a-shed-index-must-say-so-to-the-caller-it-happened-to-not-only-to-the-operator).

### With no connection, search reads the copy on the device, and says so

Moved to [With no connection, search reads the copy on the device, and says so](./search/offline-search.md#with-no-connection-search-reads-the-copy-on-the-device-and-says-so).

### The map's graph is read per shard at request time, and stored nowhere

Moved to [The map's graph is read per shard at request time, and stored nowhere](./search/workspace-map.md#the-maps-graph-is-read-per-shard-at-request-time-and-stored-nowhere).

### Related notes are the map's links for one note, plus one search

Moved to [Related notes are the map's links for one note, plus one search](./search/workspace-map.md#related-notes-are-the-maps-links-for-one-note-plus-one-search).

### Every search is timed, and the time is all that is kept

Moved to [Every search is timed, and the time is all that is kept](./search/search-timings.md#every-search-is-timed-and-the-time-is-all-that-is-kept).

### Which result was opened, keyed so the control plane cannot read it back

Moved to [Which result was opened, keyed so the control plane cannot read it back](./search/search-timings.md#which-result-was-opened-keyed-so-the-control-plane-cannot-read-it-back).

### Search by meaning is on for every workspace, free and Premium, and an owner can turn it off

Moved to [Search by meaning is on for every workspace, free and Premium, and an owner can turn it off](./search/meaning-search.md#search-by-meaning-is-on-for-every-workspace-free-and-premium-and-an-owner-can-turn-it-off).

### Notes reach the index two ways, and a map in the bucket says which are in

Moved to [Notes reach the index two ways, and a map in the bucket says which are in](./search/meaning-search.md#notes-reach-the-index-two-ways-and-a-map-in-the-bucket-says-which-are-in).

### A workspace object keeps its own word index

Moved to [A workspace object keeps its own word index](./search/object-word-index.md).

### A workspace object keeps its own meaning index

Moved to [A workspace object keeps its own meaning index](./search/object-meaning-index.md).

### Days, whole lines, and the pinned workspace (2026-11-05)

Moved to [Days, whole lines, and the pinned workspace](./search/dates-and-lines.md).

### Tex searches every workspace; a named one is a boost, never a fence (2026-11-19)

Decided by the owner, 2026-11-19: for a find or lookup question, Tex searches every workspace the person reaches and ranks the results together. A workspace named in the question, or the one Tex is in, may rank its notes higher; it never narrows the search. Only the person's own instruction ("only in @x") restricts it.

The incident: asked for "the <org> reading list", Tex read the org's name as a workspace and pinned every search to `context: "@org"`, so the note in the person's own workspace, which a plain search ranks first, was never seen, and a job's answer said "a search across all your workspaces didn't turn one up".

- **Tex's resolver, not the gateway contract** (`agent/sixTools.js`). A Tex `search` (or older-name `search_notes`) that names a workspace in `context`, with no folder `prefix` and no day range, is sent as the person's ordinary unscoped search with `boost: "@x"`. With `args: { only: true }` beside `context` it stays scoped. An MCP client's `context` still means "this workspace only". `search_notes` gains one optional argument, `boost: "@name"`, which any client may pass (tool news, 2026-11-19); a client that never sends it sees no change.
- **The boost ranks, it never filters** (`tools/search.js` `fuseEverywhere`, `BOOST_FACTOR`). The wide search is the one an unscoped call already makes: every workspace opened under the person's role there and its own rules, all at once, each with the small per-workspace list a search of several takes. Nothing is added or dropped because of a boost. A boost that names Context.LC's pinned workspace reaches it, as asking it by name does.
- **The result says what it searched.** A search that covered more than one workspace, was boosted, or could not open one ends with `Searched: @a, @b.`, and names any workspace it could not open as not searched. The list is built from the workspaces that answered, never from the ones asked, and the result carries it as `searched`.
- **Saying it in the reply is structural on the front door.** The front door's 1:1 turns run no reply checks ([front-door](./texting-assistant/front-door.md)), and this keeps that. The search tool's description asking Tex to copy the workspaces the result lists was not enough: on 2026-11-19 a live reply to "whats on the public worship reading list?" left the line out though the result carried it. So the front door appends it in code: each search's `Searched:` line is kept from the tool record as the turn runs (`agent/searchClaims.js` `withSearchRecord`), and a 1:1 front-door reply that does not already carry the last one gets it on its own line (`withSearchedLine`, `texEntryPoint/sendTheReply.js`), the "Not reachable" clause included. Nothing is invented: a turn whose searches covered one workspace has no such line, and nothing is appended. Where reply checks do run (a job's parts, group chats), `agent/searchClaims.js` still sends back an answer that claims every workspace when no search of the turn covered them.

This replaces the same day's fallback (`tools/searchNamed.js`), which appended title matches from elsewhere to a scoped search for every client. It changed the gateway's answer for all clients and still let Tex fence a search.

**What a simplification would cost:** with `context` passed through as a filter, Tex answers "not written down" whenever a workspace shares a word with the question, and workspaces are named for their topics. Without the `Searched:` line, a reply can name a search it never ran. **Tests:** `agentSixTools.test.mjs` (a named workspace resolves to `boost`, `only` keeps it scoped), `searchEverywhereBoost.test.mjs` (the boost never drops a hit; `Searched:` lists only workspaces that answered), the replay case `search-names-google-chat` (the texted reply ends with the result's `Searched:` line though the model left it out), `searchedLine.test.mjs`, and the Training cases `reading-list-app` and `reading-list-text`.

### Search runs from a config of its own, and its ranking constants are that config's settings

Moved to [Search runs from a config of its own, and its ranking constants are that config's settings](./search/search-config.md#search-runs-from-a-config-of-its-own-and-its-ranking-constants-are-that-configs-settings).

### Search is measured on three sets, and a search change merges only if the right note stays first

Moved to [Search is measured on three sets, and a search change merges only if the right note stays first](./search/search-suite.md#search-is-measured-on-three-sets-and-a-search-change-merges-only-if-the-right-note-stays-first).

### Across workspaces, word hits are scored on one scale (and a workspace can be weighed by its evidence)

Moved to [Across workspaces, word hits are scored on one scale (and a workspace can be weighed by its evidence)](./search/shared-word-scale.md#across-workspaces-word-hits-are-scored-on-one-scale-and-a-workspace-can-be-weighed-by-its-evidence).

### Every open of a note is logged in its workspace's object, and search ranks a note that holds every word by its opens

Moved to [Every open of a note is logged in its workspace's object, and search ranks a note that holds every word by its opens](./search/note-opens.md#every-open-of-a-note-is-logged-in-its-workspaces-object-and-search-ranks-a-note-that-holds-every-word-by-its-opens).

### The words that only say how a question is asked are left out of the word index's query

Moved to [The words that only say how a question is asked are left out of the word index's query](./search/asked-questions.md#the-words-that-only-say-how-a-question-is-asked-are-left-out-of-the-word-indexs-query).
