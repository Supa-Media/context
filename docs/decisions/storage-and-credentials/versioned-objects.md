# Storage and credentials — versioned objects

### Context-owned objects have one versioned namespace

Every object Context creates that is not a user-authored note or attachment
lives under `.context/`: audit records, search indexes, meeting session state,
generated image objects, legacy ACLs, integration queues, proposals, probes and
migration journals each have a purpose-named child. User-authored roots remain
untouched, and `.obsidian/` remains the user's rather than ours.

Storage-layout v1 replaces the former sibling dot folders. Readers prefer v1
and fall back to legacy durable data; new writes use only v1. Search indexes are
disposable and may rebuild instead of paying a second read for a legacy index.
The owner-only migration copies bounded batches, refuses storage without
conditional create/write, byte-verifies every destination, records resumable
progress at `.context/migrations/storage-layout-v1.json`, and never overwrites a
different destination. Copy completion writes `.context/manifest.json`.
Deletion is a distinct explicit phase, unavailable until a seven-day rollback
window has elapsed, and re-verifies each source/destination pair before removing
the source. Re-running either phase is safe.

The console exposes this as an owner-only control in **Settings → Storage**,
and as a **dismissible notice** in the browse pane's existing notice band. It
is deliberately not chrome: it was briefly a gear in the file tree's toolbar,
beside the four controls somebody uses every day, and a maintenance operation
run once or never does not earn permanent room there. Both entry points are
gated on the same owner-only action and raise the same confirmation, which
names the boundary before anything runs: only reserved Context objects move;
notes, folders, `privacy.md`, and `index.md` do not. The notice carries one
further condition the settings row does not — a connected binding — because an
offer that appears in front of somebody has to earn the interruption, while a
row they went looking for should still be there while a probe is in flight;
neither condition decides who may run it. Its dismissal is remembered per
workspace on the device, because nothing tells the console whether a given
bucket still needs the update, so an offer drawn from availability alone would
return for ever.

One press queues a fresh capability check, bounded copy batches until copying
is complete, and safe cleanup for the end of the rollback window, so an owner
does not need to call an internal migration function or keep the console open.
A backend without verified conditional delete keeps its legacy copies rather
than risk deleting an object that changed; a stopped run is resumed by pressing
the same control again.

The connect-time capability probe persists conditional create and delete
alongside conditional writes. Older binding rows omit those fields and
therefore fail closed until they are reverified; claiming an adapter's support
without recording what the owner's bucket actually honored would make the
migration control an unsafe overwrite button.

**What a simplification of this would cost.** Writing another top-level hidden
folder recreates the clutter this layout removes; deleting during copy removes
rollback; unconditional copy can destroy a user's manually recovered object;
and requiring migration before reads breaks existing buckets. The gateway
migration checks pin all four properties, while producer tests pin the new
paths.

### Version history is the customer's object versioning, not a copy we keep

Every write path in this product used to snapshot the body it was about to
replace into `.history/<path>.<stamp>.md` — six paths in the gateway, two more
in the console. The stated premise, in the gateway's header comment, was that
"object storage has no dependable versioning".

**The premise was false.** R2, S3, B2 and Wasabi all version at the bucket. It
costs no write amplification, it is a setting on storage the customer owns, and
it captures something our snapshots never could: the writes Obsidian's sync
plugin and rclone make directly, which never pass through us at all. A product
whose first non-negotiable is that the customer owns the storage was hand-rolling
a worse version of a feature that storage already has.

What the snapshots actually bought:

- **Write amplification on somebody else's bill.** `app-and-console.md` measures
  it: tens of thousands of objects standing for a few hundred notes, in the
  customer's bucket, synced down to every Obsidian vault, and paid for by them.
- **A rollback that was never built**, and could not be read back if it were:
  `isPlumbing` refuses every dot-prefixed segment at every scope, personal
  included, so no tool could reach one. For a move or an archive it was not even
  insurance — the body still exists at the destination.
- **A permanent delete that had to hunt.** `deletePath` grew a whole purge —
  prefix-matched across five snapshot spellings written by four functions —
  because "permanently delete" was otherwise a lie. That machinery exists to
  clean up after a feature nobody used.

So the snapshots are gone and the honest consequence is stated rather than
dressed up: **with versioning off, an overwrite is final.** The setup guide tells
people to turn it on, `describeDeleteForever` says what deletion can and cannot
reach, and the offline conflict UI says "unless you turned on versioning, the
version it replaces is gone" instead of pointing at a `.history/` copy.

**What a "simplification" of this would cost.** Restoring snapshots to any one
write path re-creates every line above, quietly, in a customer's bucket. The
guard is a sweep over the whole bucket after every gateway write path has run,
not an assertion per path; sabotage `write_note` to snapshot again and it fails.

**Three things this decision deliberately keeps:**

- **`.history/` stays plumbing, and the purge stays.** Every bucket connected
  before this change is full of snapshots. Nothing writes them, everything still
  hides them, and `deletePath` is the only thing that removes them. Delete the
  purge when no such bucket can exist, which is not a date anyone can name.
- **`.context/recover/` is not a replacement history.** One file goes there: the
  unreadable `privacy.md` that `resetPrivacyManifest` repairs, whose other forty
  lines are the owner's record of what was shared. It is owner-triggered, one
  copy per repair, and the test for whether anything else belongs beside it is
  whether that thing is recoverable from anywhere else — from versioning, or from
  the notes. A note always is. `.context/` needed no plumbing changes: both
  privacy engines already refuse every dot-prefixed segment, and `.context-probe/`
  is a different segment that no prefix test collides with.
- **We do not ask for `DeleteObjectVersion`.** Permanent delete cannot remove the
  customer's noncurrent versions, and should not try. Reaching into version
  history we told them to enable, with a permission the binding does not
  currently need, to delete data in a bucket they own, is the opposite of the
  arrangement. The console names the condition instead — it cannot see the
  setting, so it does not guess which side of it somebody is on.

**Large moves are durable; their physical copy is still provider-bound.** A
large owner-scoped folder move now makes one logical cutover, persists its
marker in the customer's bucket, and materializes bounded batches through the
Cloudflare Queue. A queue ticket is hashed in the control plane and carries no
credential, note path, or note content. The owner can see only its phase and
measured object counts in Settings; source and destination names remain in the
bucket marker because a folder name can itself be private. Completed rows stay
visible for one day so progress does not disappear at 99 percent.

The storage adapter still has `get`/`put`/`delete`/`list` and no portable
server-side `copy`, so each backend pays its own read, write, verify, and delete
cost. A provider-specific `CopyObject` capability can reduce that cost later,
but it must preserve the same marker, conditional cleanup, retry, and progress
contract. The console's direct Convex move action remains synchronous; this
durable path and its progress describe gateway-triggered large moves until the
console starts the same job rather than its separate 45-second request.

### Dropbox's client secret is optional hardening, not a second credential to guard

The Dropbox app was registered as a public client on purpose: PKCE — a
verifier parked server-side in `dropboxConnectAttempts`, never in the browser
— already proves which flow a code belongs to, with no secret in the system
at all. `DROPBOX_APP_SECRET` exists on both of this project's deployments
anyway, unused, because Dropbox's app console hands one out whether or not the
app asks to be confidential.

That secret is now read — `readAppSecret()` in `functions/dropboxConnect.ts`
— and passed to `exchangeDropboxCode` and `refreshDropboxToken` as an
**optional** `clientSecret`, included in the token request only when present.
It is not required the way `DROPBOX_APP_KEY` is: PKCE already carries the
proof this flow needs, so a deployment with no secret configured — a
self-hoster mid-setup, or this repository's own tests — degrades to exactly
the public-client behaviour that shipped, rather than refusing to connect.
Where the secret **is** present, Dropbox now refuses a token request that
gets the PKCE proof right but does not also come from a process holding it —
a second, independent check that costs nothing because the exchange and every
refresh already run from a scheduled Convex action, never from a browser.

**What a "simplification" of this would cost.** Sending the secret
unconditionally (`client_secret: options.clientSecret ?? ""`) would send the
literal empty string the day a deployment's env var is unset, which Dropbox
refuses outright — turning a deployment with no secret configured into one
that cannot connect Dropbox at all instead of one that behaves as it always
did. The three call sites — `exchangeAndBind`, `revokeDropboxGrant`, and the
gateway's on-demand refresh in `functions/storage.ts` — all read the env var
themselves rather than through a shared "requireAppSecret", because requiring
it in one place while the other two stayed optional is exactly the kind of
drift nobody would notice until a refresh started failing on a deployment
that connects fine.
