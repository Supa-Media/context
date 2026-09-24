# Storage and credentials — verification and the model key

## A verification snapshot is never read as live state

`scaffoldReason`, `scaffolded`, `scaffoldMissing`, `noteCount`,
`noteCountTruncated` and `noteCountedAt` are all written by exactly one thing:
the pass `verifyStorageBinding` makes when a binding is connected or
re-verified. Nothing that puts a note in a bucket touches any of them — not the
gateway, not `write_note`, not email ingestion, not the console's own editor —
because none of those opens the binding to record what it did, and a per-write
counter on the control plane would be a second source of truth for something
the bucket already knows.

That is the right design and it has one consequence, which has now cost us a
shipped defect: **every one of these fields is a measurement taken at a past
instant, and a live claim built on one is a guess.** The first version of the
console's empty-context card read `scaffoldReason === "empty"` as "this bucket
is empty" and drew *This context is empty*, with an offer to scaffold, over a
workspace whose tree was full of the owner's notes. The binding was telling the
truth about a moment months earlier; the card turned it into the present tense.

The rule, in the two shapes it takes:

**A decision reads the live thing.** Whether a context is empty is answered by
the listing in front of the person, never by the binding. The binding may still
be read *to stay quiet* — `existing-context` and `created` are reasons not to
offer — but it can never be the reason to assert. The pattern generalises:
snapshots may veto, only live reads may claim.

**A number says when it was taken.** Settings → Storage had this right from the
start — "412 notes — counted 3 weeks ago" — and the two surfaces that printed
the same walk bare have been brought into line: the Premium panel's usage line,
and the console's "notes across all" tile, which is dated by its *oldest*
contributing walk because a sum is only as fresh as its stalest part. A `+` is
not a substitute: notes are deleted as well as written, so a stale count can be
over as easily as under, and a floor would be a second false claim rather than
a hedge.

Two readers are legitimate and stay: onboarding's `structureStepFor` and the
Dropbox callback both read the field within seconds of the walk that wrote it,
standing in front of a bucket they have just watched being verified.
`applyStructure`'s server-side guards read it too, but they are a pre-filter and
not the safety boundary — `hasExistingContext` re-lists the bucket, and every
individual write is preceded by a `get`, so a stale `empty` costs a wasted round
trip and never a write over somebody's notes.

**What a simplification costs.** Re-deriving "is this context empty" from the
binding puts the scaffold offer back on live workspaces. Printing any of these
counts undated re-asserts a figure nobody measured recently — #25's shape, with
a real number instead of a constant. Dating the notes tile by its newest walk
rather than its oldest flatters a total whose other half is a year stale.
`apps/mobile/__tests__/contextSetup.test.ts`,
`browseSetupPrompt.test.ts` ("a context whose notes arrived after it was
verified"), `noteTotals.test.ts` ("how old the number is"),
`liveConsoleFacts.test.ts` ("dates the number rather than implying it is
current") and the two usage-line checks in `premiumSettings.test.ts` fail.

### A move between two contexts is three calls, not one function holding two keys

Moving a note or a folder from one context into another crosses a tenancy
boundary: two buckets, usually two credentials, often two customers' accounts.
The storage adapter has `get`, `put`, `delete` and `list` and **no portable
server-side copy**, so the bytes have to be read out of one bucket and written
into the other by something that can reach both.

The obvious shape is one internal action that opens both credentials. It is
refused. `runFileOperation` is one of the two members of `CREDENTIAL_BARRIERS`
and the whole argument for that enumeration — see "Credential barriers are
enumerated, never inferred" above — is that a barrier is small enough to audit
by reading it: it opens **one** workspace's credential, performs one operation,
and hands back a result that by construction cannot contain a key. A barrier
holding two customers' plaintext secrets in one scope is a different object with
a different blast radius, and it would need that argument made again from
scratch.

So a batch is three trips through the one barrier — `contextMoveExport` against
the source, `contextMoveImport` against the destination, `contextMoveDelete`
against the source — and the orchestrator that sequences them,
`functions/contextMoves.ts`, holds no credential at all. Note bodies pass
through it in flight, bounded by `CONTEXT_MOVE_BATCH_BYTES`; nothing is stored.
That is the same transit every `readNote` already makes and is not what
non-negotiable #1 forbids, which is the control plane *holding* note content.

**Copy, verify, then retire, per object.** The destination answers with an etag
before the source key is touched. A batch that dies leaves objects in both
places, which the next pass simply does not see — the recoverable direction. The
opposite order loses notes. A source edited between the copy and the retirement
keeps the newer text: the copy is rolled back and the move stops, because
silently deleting the newer one is the only outcome here that destroys work.

**"Retire" and not "delete", because a conditional DELETE is not a guard on the
storage this runs on.** R2 accepts `If-Match` on DELETE and ignores it, so the
obvious `delete(path, { onlyIf: { etagMatches } })` either refuses every move or
silently destroys that edit. `retireMovedSource` here is the gateway's, ported
rather than reinvented so two engines cannot drift on a data-loss guard: claim
the source path with a zero-byte marker under a conditional **PUT** on the
copied etag — atomic, and it fails if anybody touched the note — then delete the
marker, which by then is the only thing at that key. Either conditional
satisfies the source and `conditionalCreate` is required at the destination;
both are asked before a byte moves, and a store with neither is refused by name.

**No trash copy, and that is a divergence from the gateway's single-note
cross-workspace move, which keeps one.** The argument there is that this is the
one move whose destination is a bucket the owner may stop being able to reach.
It holds, and what does not carry to this path is the arithmetic: the gateway
trashes one note moved by an agent on a tool call, and this moves a folder a
person picked a destination for in a dialog that names it — so the copy would
scale with the folder and double a nine-thousand-note move in the customer's own
bucket until somebody empties trash. The content is not lost either way; access
to it is, and giving it away is what the press meant. Reversing this is a
`trashBody` away and would be a reasonable call to make differently.

**This is also why a cross-context move has no size limit.**
`FOLDER_OPERATION_CAP` refuses a single-store folder move past 500 files, and
that refusal is right where it is: `movePath` rewrites `privacy.md` as though
the whole walk happened, so a partial walk cannot be operated on. Here the
all-or-nothing unit is one *object*, so nine thousand notes is not a bigger
operation — it is more batches, carried by a `contextMoves` row and a chain of
scheduled passes that outlive the request that started them. Each pass lists the
subtree **from the beginning**, which costs nothing because the previous batch's
objects are gone by then, and which avoids the cursor-over-a-mutating-listing
skip that `clearVaultBatch` documents one function up.

**The row holds paths, and `gatewayJobs` beside it deliberately does not.** That
row is minted for a queue ticket and read again with nobody present, so the less
it knows the better. A `contextMoves` row exists only because a person pressed
Move, it is readable only by an owner of the context the move is leaving, and
the audit trail already records `file.move` with both paths for every
same-context move. A move job that could not name what was moving could not tell
that person which of their folders is still going.

**Authorization is asymmetric: `owner` on the source, `editor` on the
destination.** Taking something out of a context removes it from everybody who
could read it there, which is not a call an editor invited to help with one
project gets to make. Putting something in is an ordinary write. The
destination's own clearance is then re-checked by the same
`assertDestinationsVisible` a single-store move uses, so an editor cannot land
anything in a folder that context keeps private — this is the one place a write
arrives in a context from outside it, and a second implementation of "may they
write here" is a second one to get wrong.

**What a "simplification" of this would cost.** One action with two credentials
puts a second, wider entry in `CREDENTIAL_BARRIERS` and every argument that
enumeration exists to force. Deleting before the destination answers loses notes
on any failure. An unconditional delete loses the edit somebody made while the
move ran. A persisted listing cursor skips objects on S3-compatible providers. Trusting a
conditional DELETE destroys an edit made mid-move on R2, silently, while the
code claims it is kept.
Doing it in one request reintroduces the 500-file ceiling on the operation whose
whole point is not having one. `apps/convex/__tests__/contextMove.test.ts` and
`contextMoves.test.ts` fail — in particular "a folder larger than a single-store
move could touch still moves, whole", "a note edited between the copy and the
delete keeps the newer text", "on storage that ignores a conditional delete, the edit is still kept",
and the endpoint enumeration that makes a fourth public function in that module
impossible to add without an isolation test.

## The model key is a fourth credential route, not a fifth sibling on the binding

The agent spends the customer's own Anthropic or OpenAI account, so the control
plane holds an API key per workspace (`providerCredentials`, encrypted with the
workspace as AAD, exactly like a storage secret). The gateway has to have it in
plaintext for the length of one request, which makes it the fourth thing
`CREDENTIAL_HTTP_ROUTES` enumerates: `/gateway/provider`.

**Every previous gateway-facing credential deliberately avoided being a route.**
`searchIndex`, `encryptionKey` and `rotation` are all *siblings* on
`/gateway/binding`'s response, and `apps/convex/http.ts` says why in as many
words: a second route handing out a credential would be another entry in that
set, "which that comment says is a conversation". This is the conversation, and
it comes out the other way — for a reason that is about #661 rather than about
taste.

#661 was a **returns validator** accident. `storageBindings.capabilities` gained
a fourth key while two routes in `controlPlane.ts` restated the capability shape
inline; `v.object` is exact, so `openStorageBinding`'s own `returns` refused the
object it had just built, and `ReturnsValidationError` named what it rejected.
`s3BindingValidator` carries `secretAccessKey`, so a live R2 secret and a D1
token went into the production logs. Everything folded into that one validator
shares that fate: one drift anywhere in the shape serializes everything in the
shape. Adding a model key to it would make a single future accident spill a
storage secret *and* a credential issued by somebody else's console — which,
unlike ours, **we cannot rotate**.

So the model key gets a validator of its own: two flat fields, `provider` and
`apiKey`, with nothing nested in it to drift. That is a strictly smaller blast
radius than the sibling, bought with a door — and the door is the same door.
`/gateway/provider` is built by the same `gatewayRoute` factory, spends the same
gateway secret, resolves the same access token to a live grant independently,
applies the same rule that `expectedWorkspaceId` **selects within the grant's own
set and is never a lookup key**, and answers `{"credential": null}` for
everything that is not a hit — an unknown token, an expired or revoked grant, a
workspace outside the set, a provider this build does not know, a provider
nobody connected, and a decrypt that failed.

Two smaller things fall out of it, both worth keeping:

- **The key is opened only by the request about to spend it.** An ordinary MCP
  call fetches `/gateway/binding`; a model key riding that payload would be
  decrypted on every `list_notes` in the product.
- **No scope beyond a live grant**, and that is not an omission. A token that can
  open this can already open the same workspace's *storage* credential through
  `/gateway/binding` — the whole bucket, read and write. A model key that bills
  the owner's own provider account is strictly less than that, so a further check
  here would be theatre rather than a bound. What bounds it is what bounds the
  binding: the grant is live, it is revocable, and the connection is in the audit
  trail. A *member* of a shared context can therefore spend its owner's model
  account, the same way a member can already rewrite every note in it.

**What a "simplification" of this would cost.** Folding the credential back into
`/gateway/binding` puts a key we cannot rotate inside the validator that has
already leaked one we could. Letting the route's argument validator refuse an
unknown provider makes the refusal a *different* answer from every other one,
which is an oracle for the provider set — so the closed set is checked in the
handler, where the refusal is the same `null`. Letting anything ride beside the
credential in the response — a workspace id, a fingerprint, a grant id — makes
two refusals distinguishable and puts a fact about a customer next to a secret.
`apps/convex/__tests__/providerCredentials.test.ts` fails, in particular "a hit
names the provider and the key, and nothing else", "an unknown provider is
answered exactly like an unknown token" and "a token for one workspace cannot
open another's credential"; `apps/mcp/test/providerCredential.test.mjs` fails
"a token cannot reach another tenant's model account" and "a refusal is a 200
with a null, never a status the caller can count"; and
`apps/convex/__tests__/structure.test.ts` fails on the enumeration itself.

### A moved note leaves a forwarding address, and it is a trail rather than an index

`links.js` already rewrites every reference **inside** the bucket when
something moves: rename a folder and the wikilinks and Markdown links in every
note that can see it follow, by default. That is the whole of the problem for
references we can reach, and none of it for references we cannot. A share link
pasted into a thread last month, a deep link in somebody's chat log, a path an
agent wrote down — none of those live in a file, so no rewrite reaches them,
and until this landed every one of them died the first time a context was
tidied. Quietly, and to the wrong person: whoever moved the note is not whoever
is holding the link.

So a move appends to `.context/forwarding.json`: `{ from, to, kind, at }`,
written by the gateway and by the console through one module
(`apps/mcp/src/forwarding.js`, imported by `fileOps.ts` exactly as the search
modules are), so a rename through the app and the same rename through an MCP
client leave the same trail.

**The shape is a trail between paths, not an index of references, and that is
the decision.** An index — "who links to what" — is the obvious way to make a
move cheap, and it is the wrong thing to keep in a bucket that Obsidian,
`rclone` and a text editor also write. It would be a second copy of every link
in the context, drifting the moment somebody edits a note outside the gateway,
and a *stale* copy of a reference is worse than no copy because it names a
relationship that no longer exists. The links stay in the files, where they are
canonical and where the customer can read them without us (non-negotiable #3).
What is kept is the one fact a holder of a stale path needs, which is a fact
about the move rather than about any reference: where the thing went.

Four properties carry it, and each fails a test if removed:

- **A folder move is one entry.** Renaming `2-areas/` writes a single prefix
  rule, so the ledger's size follows the number of *moves* rather than the
  number of files, and a nine-thousand-note rename is one row. The prefix
  matches on a segment boundary, so `2-areas-old/x.md` is never carried by a
  rule written for `2-areas` — the same trailing-slash care `withinSharedFolder`
  takes.
- **Chains collapse as they are recorded.** Recording `b → c` rewrites an
  existing `a → b` into `a → c`, and an entry that would point at itself is
  dropped, so a note moved back where it started forwards nowhere rather than in
  a circle.
- **The most specific rule wins, never the newest.** An exact entry outranks a
  folder entry, because a note that left a folder before the folder moved has
  two possible answers and only its own is true — and between two folder
  entries that both contain a path, the longer prefix wins for the same reason.
  Move `2-areas/apps` out to `1-projects/apps`, then rename `2-areas`, and the
  newer rule is the wrong answer for everything under `apps`.
- **It is bounded and it expires rather than breaks.** Past
  `FORWARDING_ENTRY_CAP` the oldest entries are dropped, and a cold forwarding
  address is a link that stops working — which is what it did before this
  existed.

**It is never the only copy of anything**, which is what makes it safe to cap
and safe to lose. Delete the file and the bucket is unchanged: every in-bucket
link still resolves, because those were rewritten in place at move time. A
write failure is therefore swallowed rather than raised — by the time it runs
the objects have already moved, and an exception would fail an operation that
has already succeeded. The write is still conditional (`onlyIf`), because two
moves landing at once must not lose one to last-writer-wins; a store that
cannot do conditional writes simply does not keep the address.

**An absent ledger is a valid state, so this is not a layout migration.** The
on-bucket layout is a versioned stable format and changing it needs dual reads
and a verified migration. Adding a plumbing file whose absence already means
"no forwarding addresses" changes no existing key, is dual-read by
construction, and leaves a bucket that has never seen this code working exactly
as it did. A *future* change to the file's own shape is what needs the
migration, which is why it carries a `version` and why an unknown version reads
as empty rather than being guessed at.

**Two orders, and collapsing them would be a bug.** `readFile` takes
`forward: "never" | "onMiss"`. A deep link is `onMiss` — a path means what it
says today, so a note that exists where the address points wins, and only a
dead address is forwarded, which also keeps the extra GET off every successful
read. A share needs the opposite order and resolves through the `forward`
operation before it reads anything, argued in
[privacy-and-sharing](../privacy-and-sharing.md).

**What a "simplification" of this would cost.** Writing one entry per file in a
folder move turns a PARA reorganisation into thousands of rows in a file every
share read fetches. Matching the prefix with `startsWith` hands
`2-areas-old/x.md` to a rule written for `2-areas`. Dropping the collapse makes
a five-move note a five-hop resolution and lets a cycle exist. Resolving
overlapping folder rules by recency rather than by longest prefix sends
everything under a subfolder that moved out first to wherever its old parent
was later renamed. Letting
`recordForwarding` throw fails moves that already happened. Growing this into a
reference index puts a drifting second copy of the customer's links in their
own bucket and breaks non-negotiable #3's "never the only copy of anything" in
the other direction. `apps/mcp/test/forwarding.test.mjs` fails, in particular
"a folder move is one entry, not one per file", "a sibling whose name merely
starts the same is not carried", "a chain resolves to the end of the chain" and
"the oldest expired rather than corrupting the file"; the wired half of
`apps/mcp/test/links.test.mjs` fails "a path renamed and then carried by a
folder move still arrives" and "the forwarding ledger cannot be read as a note";
and `apps/convex/__tests__/shareSurvivesMove.test.ts` fails throughout.
