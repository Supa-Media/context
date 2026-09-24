# Storage and credentials — credential basics

### The gateway is a Cloudflare Worker, not Convex

Convex would remove a service boundary and a shared secret, which is a real
argument and was seriously considered. It loses on two counts: self-hosting
("clone this, deploy one dependency-free file, your bucket still works") is a
published commitment, not a preference, and Convex actions bill compute on the
hottest path in the system for a product whose pitch is free.

### Credential retrieval takes two independent proofs

The gateway secret proves the caller is the gateway. The end user's access
token, forwarded verbatim, proves a real person authorized that workspace right
now. Convex resolves the workspace **from the token's grant** — the gateway
cannot name the workspace it wants, only be told, and any id it sends is a veto
rather than a lookup key.

An earlier draft made the gateway secret sufficient on its own. That would have
been the highest-value credential in the system: one leak and every customer's
bucket keys are retrievable in bulk. **A change that lets the gateway name its
own workspace would look like a cleanup and would be a catastrophe.** There is
a test asserting `expectedWorkspaceId` is never used as a lookup key.

### Never cache a decrypted credential across requests

Workers reuse isolates across tenants. A cache keyed even slightly wrong is a
cross-tenant leak. This costs roughly 20–60ms per call and that is the right
trade. Per-request caching is fine; anything that outlives a request is not.

### Scheduling is not calling

In the credential-reachability graph, `ctx.runQuery/runMutation/runAction`
propagates taint — it awaits a value and hands it to the caller.
`ctx.scheduler.runAfter` does not: it enqueues a job in a separate transaction
whose return value the scheduler discards, so there is no channel back.

Without that distinction no public function could trigger a bucket probe, and
"verify the credential the user just pasted" would have to be a polling cron
chosen to satisfy a static check rather than because it is right. Scheduled
targets must still be statically resolvable `internal.` references.

### Credential barriers are enumerated, never inferred

Reading a bucket needs a credential, so a console read path cannot exist under
a blanket "no public function may reach a decrypt". Taint stops at an
explicitly listed barrier — see `CREDENTIAL_BARRIERS` in
`apps/convex/__tests__/structure/analyzer/pins.helpers.ts`. Barriers must be internal actions whose return
validators are checked for credential fields.

This is a genuine relaxation with a real residual risk: a future operation that
returns a credential from inside a barrier would not be caught statically. The
enumeration is the mitigation — adding a second barrier fails CI loudly, which
forces the conversation.

### The credential graph follows imports, and refuses what it cannot follow

`apps/convex/__tests__/structure/` proves that no public Convex function or
unlisted HTTP route can reach a decrypted credential. Its nodes are registered
functions, and until this decision its edges were read only from the text of
each one's own export block: `ctx.run…(internal.…)`, `scheduler.run…`, and
`decryptSecret(`. A module under `functions/lib/` registers nothing, so a
dispatch or a decrypt written there belonged to no node, and a public function
that imported the helper contained neither string and passed. No credential
path went through that gap — `ctx.run…` and the decrypt stayed out of helpers
by convention, and that convention is what kept `storage.ts`, `shares.ts` and `http.ts` from being split into
helpers. A guard that holds only while nobody refactors is exactly what
[a guard nobody has checked is not a guard](../testing.md#a-guard-nobody-has-checked-is-not-a-guard)
is about.

**What the analyzer does now.** Beside the text rules (which stay, unchanged,
and can only be added to), every registered function's reach is walked over a
real TypeScript parse (`analyzer/imports.helpers.ts`, `moduleIndex.helpers.ts`,
`references.helpers.ts`): from its own statement, through every name it uses
in value position, into same-module helpers and static imports — named,
default, namespace, `export { … } from`, `export *`, `import x = require(…)` —
transitively, each top-level statement at most once per reach, so a cycle ends.
Each helper's calls, schedules and decrypt become edges of *every* registered
function that reaches it, held to exactly the rules its caller is held to
(`facts.helpers.ts` is the one reading of a piece of text). A registered
function named directly is an edge, because Convex runs its handler inline. A
module entered also contributes its load-time statements. Packages and
`_generated/` are not walked; a relative import that leaves `apps/convex` (the
gateway's modules, `packages/*`) is not walked either, and
`helperDispatch.test.ts` reads every file such an import reaches, transitively,
and requires that none can dispatch into Convex, name the decrypt, or import
back in.

**What it refuses.** Every pattern the walk cannot resolve is a violation on
each registered function whose reach includes it, never an assumption that it
is safe: `import()` of anything but a string-literal package, `require()`, a
namespace import indexed with `[…]` or passed as a value, a relative import
naming no module, a name its module does not export, `_handler`/`invoke*`, a
dispatch in any form but `x.runQuery(internal.a.b)` with the reference written
out (destructured off the context, `.call`, bracketed, reached through
`Reflect` or a string, a computed member of `ctx`, a target behind a type
argument that the text pattern never saw), a call through any computed member,
an `internal.a` chain that stops short of one registered function, and the
generated `api`/`internal` bound under another name, imported whole or
re-exported.

**What its first run found.** Run against the real codebase and dumped per
function, old against new: no edge removed, no change to which functions can
reach a decrypt, no new violation — and new edges on 52 functions. None touched
a credential, and each was an edge the guard could not see:

- *Through lib helpers, the attack itself* (6). Every share mutation schedules
  its card render through `lib/shares/{mint,linkRow,manage}.ts`, which call
  `scheduleCardRender` — an ordinary exported function in `shareCard.ts`. The
  old graph gave that `runAfter` to whichever export's block the helper sits
  in. Schedule edges only, so no taint moved; a `runAction` in the same place
  would have been invisible the same way.
- *Same-module helpers in someone else's block* (15). A helper written between
  two exports sits in the earlier one's block, so its edges went to that export
  rather than to the function calling it: `runForm` in `formActor`'s block,
  calling `files.runFileOperation` for all four form actions;
  `listOrCreateDataKeyRows` in `insertDataKeyIfAbsent`'s;
  `deleteWorkspaceCascade` in `deleteAccount`'s, scheduling the grant
  revocations for `deleteWorkspace` too.
- *Over-reading, harmless* (31, every `http.ts` route). The router's load-time
  `auth.addHttpRoutes(http)` reaches the `createSupaAuth` statement in
  `auth.ts`, whose comment spells `api.auth.signIn`. The text rules have always
  read comments; over-reading only ever adds an edge.

**What simplifying it would cost.**

- *Dropping the follower* reopens laundering by refactor. Measured: moving the
  real `providers.openProviderForGateway` handler, decrypt and all, into a
  `functions/lib/` helper leaves the new analyzer's graph unchanged, while the
  old one loses the taint on that function and on `/gateway/provider`; add a
  public action whose handler is that helper and the new analyzer reports it,
  the old one reports nothing. With the follower switched off, 23 of the 28
  tests in `helperImports.test.ts` and `helperDispatch.test.ts` fail; the five
  that pass are three negative controls, the text rule's own case and the
  outside-module check, none of which use the follower.
- *Treating a refusal as "probably fine"* turns each refused pattern into a
  one-line bypass. The list is long because each entry is one.
- *Reading names with regexes instead of a parse* reads comments, strings and
  property names as references — `row.open` as `open` — and cannot tell a
  parameter from the import it shadows.
- *Retiring `DECRYPT_IMPORTERS` because the graph now sees helpers* loses the
  other question. The follower answers "can a public function reach this";
  the pin answers "should this module be able to open a credential at all",
  which is a conversation, not an inference.
- *Looking keys up with `in`*: `"valueOf" in exports` is true for every module,
  and the first version resolved a helper named `valueOf` to a registered
  function that did not exist and never read its body. The text rule had the
  same bug for an `export const constructor` block. Both are pinned.

**What it still cannot see, said rather than implied.** It is static analysis
of source, and a dispatch name *built* at run time and reached through an
alias of the context (`const c = ctx; const run = c["run" + kind]`) is
outside it, as is
`eval`. `adminSurface.test.ts` still reads `admin.ts` per export for its own,
narrower claims; a decrypt moved out of `admin.ts` into a helper is invisible
to that file and caught here. And granularity is one top-level declaration: a
function reaches the statements it names, and a module-level `let` or fresh
container pulls in every statement of its module that names it, because what
it holds is decided by whoever writes to it.

### The setup credential is not a stored credential

Provisioning a bucket in a customer's Cloudflare account needs a credential that
can create buckets and mint further credentials — categorically worse than the
bucket key it produces. It is sealed for the length of one attempt and no
longer: `cloudflareProvisioning` holds the envelope, the scheduled action opens
it, and the row is deleted on success and stripped of the envelope on failure.
**There is no steady state in which the control plane holds an account-level
cloud credential**, which is why that table has no `succeeded` status and why a
failed row keeps its reason and loses its credential.

What persists is byte-for-byte what a manual connect would have left, written
through `applyBinding` rather than a second copy of it. A "simplification" that
inserted the binding directly would fork the field resets, the audit event and
the scheduled verification, and the direction that fork fails is a bucket
nothing ever probed.

Two invariants a tidy-up would quietly break: the permission group is resolved
**by name at runtime and the flow stops if it is absent** — there is no branch
that mints a broader key to get past it, and a hardcoded id is a guess about
what a token may do; and an opaque envelope is still the credential, so no
public function may return one (`encryptedsetupcredential` is in
`structure.test.ts`'s forbidden return-validator fields for the same reason
`encryptedsecretaccesskey` is).

Cloudflare error **10042** is a billing prerequisite, not a storage error. R2
requires a payment method even inside the free tier, and the same error
reappears months later when a card fails — Cloudflare blocks bucket access and
leaves the data intact. Reporting it as "storage error" makes us answer for
somebody else's billing rule and reads as us losing their notes.

**A failure must say what is in the customer's account now.** Three calls run
in order — resolve the permission group, create the bucket, mint the key — and
a classifier that does not know which one failed will happily say "nothing was
changed" after creating a bucket. It then tells the person to try again, and
the retry is refused by the bucket we made and never mentioned. That is the
documented likely failure, not a corner: only R2's API-token template key is
published, so a pasted credential can create a bucket and be refused at the
mint. Every recorded failure therefore carries the stage it reached, and a 5xx
or a dead socket at the create step says the outcome is _unknown_ rather than
guessing in either direction.

**Reuse is proved from Cloudflare's record, never from our memory.** A taken
name is a question. The answer is the bucket's own `creation_date`: reuse it
only if it was created at or after the moment the attempt was first written,
because a bucket the customer already had cannot have been created after they
started an attempt they had not started yet. Every unknown — no date, an
unparseable one, a lookup that failed — answers no, so the direction this fails
is "leave the customer's bucket alone". A stored "we made this" flag would be
our word for it, and deleting the orphan instead would be customer data loss
the first time R2 returns success for a bucket that already existed.

**And the attempt expires.** The invariant above says there is no steady state
holding an account-level credential; without a deadline, a run lost to a deploy
holds one forever _and_ blocks the person from retrying, because a pending row
refuses a second attempt. The row expires, an hourly sweep destroys the
envelope, and a pending row past its deadline stops blocking.

### Staff is an environment allowlist, never a column

The admin console reads figures across every tenant and holds the platform's
own integration credentials, which is a strictly larger capability than any
workspace role — so it is granted by a strictly different mechanism.
`users.isAdmin` is the obvious implementation and it is a privilege-escalation
path: the console can write to the database, so any bug in it, or anything that
reaches an admin's session, mints another admin, and a database compromise
mints one silently. A boolean in the table the console edits is a lock whose key
is kept inside the box.

`ADMIN_EMAILS` cannot be written by anything this codebase executes. Three
properties go with it and each is the failure it prevents: **unset authorizes
nobody** (the other direction publishes every tenant's figures to whoever signs
up first), **the address must be verified** (otherwise typing a staff address
into a signup form is enough), and **matching is exact with no domain rule** —
the same reasoning `ingestionSettings` gives about policies that admit more than
their author meant. There is no development bypass, because a bypass that exists
is a bypass that ships.

The cost is that granting admin is not self-service. For a founding team that is
the right trade and not a limitation to engineer away.

### Platform credentials seal to a scope, customers' seal to a workspace

`appSecrets` holds credentials belonging to Context.LC — the token that
provisions search databases, a payment key, a mail key. No tenant is on the
other end of one, so `CredentialContext` became a union rather than growing an
optional field: `{workspaceId}` or `{platform}`, never both and never neither.

**The AAD carries the kind as a literal segment** (`v2:<keyId>:workspace:<id>`
against `v2:<keyId>:platform:<scope>`). Without it, a workspace whose id
happened to equal a scope label would open the platform's envelope — the class
of bug an AAD exists to make impossible rather than unlikely, and it is tested
in exactly that collision. The `workspace:` segment is spelled as it always was;
changing it would make every stored storage binding undecryptable, which is
data loss no other test would catch.

The two live in different modules for the same reason: one keyset call away from
the wrong context object is one cross-domain decrypt.

### Anything needed before this table can be read cannot live in it

`STORAGE_SECRET_ENCRYPTION_KEY` is the key `appSecrets` rows are sealed with, so
a row holding it is a safe with its own combination inside — and worse, a
plausible-looking one: the console would accept the paste and report success
while the value is either unrecoverable or, if somebody "fixed" that by storing
it in the clear, the most damaging plaintext this control plane could hold.
`GATEWAY_SECRET` has to be checkable before any database content is trusted, so
it cannot be a database read. The auth signing key and the deploy key follow.

`RESERVED_SECRET_NAMES` is a **refusal, not a warning**. A warning is advice,
and somebody in a hurry — or an agent following an instruction — takes the path
that appears to work.

The console can set a credential and can never read one back. That is not a
property of its screens: `__tests__/structure.test.ts` forbids any public
function reaching `decryptSecret`, so a `getSecret` fails the suite rather than
merely being a bad idea. What it shows instead is 8 hex of SHA-256 — a hash and
not a prefix or a last-four, so what appears in screenshots and log lines is not
a fragment of the real credential.

### Usage is counted, never logged

The record of what somebody did in their own context already exists, in their
own bucket, under `.audit/`, where they can read and delete it. Mining that for
our dashboards would convert a customer-owned record into a product-analytics
pipeline, which is the first non-negotiable spent on a chart.

So `usageDaily` holds an integer per day per metric per optional workspace, and
`usageActiveDaily` one row per context per day per surface. There is
**structurally no field** a path, a query, a note title or a sub-day timestamp
could occupy, the metric name comes from a closed vocabulary and an
unrecognized one is dropped rather than stored, and the day is derived from this
deployment's clock so a report cannot be backdated into a window somebody has
already read. The gateway maps a tool name to a metric through a lookup table
and sends the metric — never the name, which is the difference between counting
traffic and recording behaviour.

Two shapes to keep: a cross-context call is counted against the context it was
**routed to**, not the connection's default, or one tenant's figures silently
include another's; and a counter may never fail the thing it counts, so the
report is deferred behind the response and dropped entirely on a host that
cannot defer.
