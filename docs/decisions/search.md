# Search and the derived index

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Search answers from a derived index, and the index is budgeted, filtered, and disposable

Moved to [Search answers from a derived index, and the index is budgeted, filtered, and disposable](./search/shard-routing.md#search-answers-from-a-derived-index-and-the-index-is-budgeted-filtered-and-disposable).

### A search reads a ready index, and never builds one

Moved to [A search reads a ready index, and never builds one](./search/shard-routing.md#a-search-reads-a-ready-index-and-never-builds-one).

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
