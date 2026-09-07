# Per-note encryption

_See `docs/decisions/README.md` for the index. This file is the design for
password-/key-protected note content, and it is also the **normative envelope
spec**: a third party who wants to decrypt their own notes without us reads
"The on-bucket format" and "The envelope" below and nothing else._

The product ask is `1-projects/context-lc-per-note-encryption/overview.md` in
the Supa Media workspace, dictated by the owner and scoped 2026-09-07. Where
that note already decided something — a random 256-bit data key per note, a
wrapped key so a password change does not rewrite note bodies, authenticated
encryption, a versioned language-neutral envelope, keys and plaintext out of
URLs and logs and caches, old decryptors and test vectors kept — this file
**cites it rather than re-arguing it**. What this file adds is the part the
note left open: how any of that survives the five non-negotiables, and in
particular how a note nobody can read is still a note every AI client can
reach.

---

### Encryption is confidentiality, and it is not access control

The product note says it in one line — "Encryption adds content
confidentiality, not access control, deletion protection, or availability" —
and every decision below falls out of taking that literally.

`privacy.md` decides **who may ask**. Encryption decides **what the bytes are
while nobody is asking**. They are asked in that order, they compose, and
neither is allowed to answer for the other:

- `canSee` runs first and is unchanged. A team-tier caller on a private
  encrypted note gets `not found`, byte-identical to a path that never existed.
  Encryption adds **no** new inference channel, because the caller never
  reaches the code that would know an envelope is there.
- Visibility is still two-valued. There is no `encrypted` tier, no third word
  in `privacy.md`, no `Scope` value beyond `private` and `team` — for exactly
  the reason the unlisted share is a row and not a tier
  ([privacy-and-sharing](./privacy-and-sharing.md), "An unlisted share is the
  third audience"): the manifest is a stable on-bucket format that the gateway
  fails **closed** on, so a word an older deployment cannot parse turns every
  note in that bucket private on a rollback. A rollback may cost a feature. It
  may not cost somebody their context.
- An encrypted **team** note is readable by the team, decrypted, through the
  gateway. That is not a bug to be closed later; it is what "orthogonal" means,
  and it is why the copy may never say "only you can read this" (see "What we
  can still read, and saying so").

**What a simplification would cost.** Folding encryption into visibility —
"encrypted means private" — is one line and it deletes the feature: the
customer who wants a note their storage provider cannot read *and* their
co-founder can is the customer who asked for this.

**The test that fails if this is reversed.** A team-tier caller on a private
encrypted note gets the same three bytes as on a nonexistent path, and a
team-tier caller on a team encrypted note gets plaintext. Both are asserted in
`apps/mcp/test/`; the first is the isolation half and is sabotage-tested by
making the refusal say "encrypted".

---

### The threat model, written as a list of names

A threat model that says "encryption protects your notes" protects nothing,
because nobody can check it. This one is a table of who holds what.

**Cannot read the plaintext of an encrypted note:**

| Who | Why not |
| --- | --- |
| The storage provider — Cloudflare, AWS, Backblaze, Wasabi, Dropbox | The object holds ciphertext. The key is not in the bucket. |
| Anyone who obtains the bucket's bytes — a misconfigured ACL, a stolen backup, a subpoena served on the provider | Same. |
| **A leaked bucket credential** — the customer's own S3 secret, or one lifted out of `storageBindings` | This is the one that matters. Today a leaked bucket key is the entire context in plaintext. After this, it is the entire context in ciphertext plus whatever is not encrypted. |
| A team-tier caller, on a **private** encrypted note | `canSee`. Unchanged, and it refuses before the envelope is ever loaded. |
| Obsidian, rclone, the Files app, any client syncing the bucket directly | They see a real file at a real path whose body is ciphertext. See "The on-bucket format". |
| The D1 search projection | An encrypted note is not projected — not its plaintext, not its ciphertext, not a row saying it exists. See "What search does". |
| The R2 shard index | Same, by default, and for a sharper reason: that index lives *in the same bucket*, under the same credential. |

**Can read it:**

| Who | How |
| --- | --- |
| The owner, and any member whose visibility tier reaches the note | Through the gateway, at request time. |
| The gateway | In-process, for the length of one request, and never across one. |
| A named grantee's AI client | Because that is the product: an encrypted note that no assistant can read is a note in a different app. |
| **Supa Media**, in Phase 1 | Stated out loud below. |

**Explicitly not defended against**, restating the product note's own "Threat
boundaries" rather than softening it: a hostile device, a keylogger, a browser
extension, a screenshot, or access while a session is unlocked. A delivered web
client can in principle capture a passphrase. Stronger assurance needs signed
clients, reproducible builds, and the independent review the product note puts
at delivery step 6.

---

### What we can still read, and saying so

**Phase 1 is encryption at rest against the storage provider and a leaked
bucket credential. It is not end-to-end encryption, and no surface may imply
that it is.**

The workspace data key that opens these notes is held by the control plane, as
a `v2:` envelope, and the gateway opens it once per request. So a compromise of
the control plane's `STORAGE_SECRET_ENCRYPTION_KEY` *plus* its database, or a
legal order served on Supa Media, reaches the plaintext. That is a smaller set
than today — today the same compromise reaches the bucket key, which reaches
everything — but it is not zero, and a product that says "we cannot read your
notes" while this is true has told its customers something false about the one
subject they most need the truth on.

So the words are fixed here and are a decision, not copy:

- **May say:** "Encrypted at rest in your bucket. Your storage provider cannot
  read it. A stolen bucket key cannot read it."
- **May not say:** "Only you can read this", "we cannot read this",
  "zero-knowledge", "end-to-end".
- The second list becomes available exactly when the passphrase recipient ships
  and the note carries **only** a passphrase recipient — not before, and per
  note, not per product.

**What a simplification would cost.** Shipping the honest sentence is what
makes the dishonest one worth something later. A product that overclaims in
Phase 1 has no way to announce Phase 2.

---

### The key model: three layers, because two cannot do the job

```
note plaintext
   └─ encrypted with ── note key (DEK)          random 256-bit, per note
                          │
                          ├─ wrapped for ── recipient "workspace"
                          │                    └─ workspace data key (WDK)   random 256-bit, per workspace
                          │                         └─ sealed in ── v2: envelope, AAD-bound to workspace:<id>
                          │                                            └─ opened by ── STORAGE_SECRET_ENCRYPTION_KEY
                          │
                          └─ wrapped for ── recipient "passphrase"    [Phase 2]
                                               └─ KEK derived from the owner's passphrase
```

**1. A note key per note**, random 256-bit, AES-GCM. The product note decided
this ("Generate a random 256-bit data-encryption key per note") and the reason
it is right is rotation: a passphrase change, a workspace-key rotation and a
future re-share all have to be possible **without rewriting note bodies**. A
scheme with no per-note key makes every one of those a full re-encrypt of every
encrypted note in somebody's bucket — a bulk write on storage we do not own,
that a Worker invocation cannot finish, that Obsidian then syncs down in full,
and that leaves half the notes undecryptable if it stops in the middle.

**2. A recipient list, not a key.** The note key is stored **wrapped, once per
recipient**, inside the note's own envelope. A recipient is
`{kind, id, alg, iv, wrapped}`. Two kinds are specified; one is built now.

This is the join that lets the brief and the product note both be satisfied
instead of one of them losing. The brief needs the gateway to decrypt at
request time, so that members, MCP clients, the console and (opt-in) search
keep working — that is the `workspace` recipient. The product note needs a
passphrase Context.LC cannot recover — that is the `passphrase` recipient.
**They are two wrappings of the same note key, and adding the second is adding
an array element, not changing a format.**

**3. A workspace data key**, random 256-bit AES-GCM, one per workspace. It is
held by the control plane **only** as a `v2:<keyId>:<iv>:<ct>` envelope
produced by the existing `apps/convex/functions/lib/crypto.ts`, AAD-bound to
`workspace:<workspaceId>` — the same scheme, the same keyset, the same
rotation, the same `CredentialContext` union that already protects every
customer's bucket secret. It is not a new cryptosystem; it is a second row in
one that has already been argued through and tested
([storage-and-credentials](./storage-and-credentials.md), "Platform credentials
seal to a scope, customers' seal to a workspace").

It reaches the gateway **exactly the way a bucket credential does**, and by the
same route for the same reasons: on the `/gateway/binding` response, behind the
two independent proofs, decrypted inside an enumerated barrier, alive for one
request and cached across none.

Three properties of the WDK are non-negotiable restatements, listed here so a
future change has to argue with them by name:

- **It is never in Markdown, never in the bucket, never on a device, never in a
  URL, never in a log.** The one exception is the owner's own deliberate
  export, which is a decision with its own section below.
- **It belongs to a `workspaceId`, never a `userId`.** A storage binding does;
  a privacy manifest does; an audit trail does. The key that opens the notes in
  a context is the same kind of object and lives on the same owner.
- **It is generated on first use and never regenerated implicitly.** A code
  path that mints a second WDK for a workspace that already has one makes every
  existing encrypted note in that bucket undecryptable, and it would look
  exactly like a bug fix for "the key was missing".

**What a simplification would cost.** Deriving the note key from the workspace
key and the path — no wrapped key, no recipients, no per-note randomness —
saves 200 bytes per note and costs: a rotation that rewrites every body, a move
that changes a note's key, and a passphrase mode that cannot be added without a
format break.

**The tests that fail if this is reversed.** A workspace's key never decrypts
another workspace's note (both halves: the wrap is AAD-bound, and the keys
differ); a second call to the get-or-create key path returns the same key; and
`structure.test.ts` refuses any public Convex function that can reach the WDK
decrypt, on the same enumeration that already refuses one reaching
`decryptSecret`.

---

### A customer-held key is in scope as a design and out of scope as a shipped mode

The question the brief asks directly: is a customer-held key, with a "we cannot
recover it" mode, in Phase 1? **No, and the format is built so that is a
sequencing decision rather than a rejection.** Three reasons, in order of how
hard they are to argue with.

1. **Every consumer that exists today decrypts in the gateway.** MCP clients,
   the console editor, link rewriting, the search projection, an unlisted share
   — all of them read through the gateway, and none of them can present a
   passphrase. So the first shipped version of "only the customer holds the key"
   would also be the version where an encrypted note is invisible to every AI
   client a person has connected, which is the product. The passphrase recipient
   needs a client-side unlock session first, and that is app work, not crypto
   work.

2. **Web Crypto has no Argon2id, and the gateway takes zero npm
   dependencies.** The product note names Argon2id, correctly — PBKDF2 is what
   `crypto.subtle` offers and it is not a memory-hard KDF, so it is the wrong
   answer against the offline guessing the note already warns about
   ("Anyone holding the ciphertext can attempt unlimited offline password
   guesses"). Deriving the KEK therefore belongs on the client, where a real
   Argon2id exists, and the gateway never sees the passphrase or the KEK at
   all. That is a better design than the one a hurried Phase 1 would have
   produced, and it is the reason not to produce one.

3. **An unrecoverable mode is the one failure here that cannot be rolled
   back.** Everything else in this design fails toward "the note is still
   there". A lost passphrase is somebody's notes gone, permanently, by design.
   The product note's own delivery plan puts KDF benchmarking at step 2 and an
   independent cryptographic review at step 6, *before* production rollout.
   Shipping the irreversible half ahead of the review is the decision this
   project would least be able to undo.

What Phase 1 therefore does is make Phase 2 additive: the envelope has a
recipient **array** from its first byte, the ciphertext is bound to the
workspace and not to a recipient, and a note may end up with a passphrase
recipient and no workspace recipient — at which point it is genuinely
unreadable by us, and the sentences in "What we can still read" unlock for that
note.

**Two open questions belong to the owner and are not answered here**, because
they are product decisions with no engineering-correct answer, and the product
note lists them under its own "Decisions": whether a note may drop its
workspace recipient entirely (which makes it invisible to every AI client — the
feature working as asked, and also the feature nobody uses), and whether a
signed offline decryptor is required at launch or is satisfied by this spec
plus the MIT-licensed module.

---

### The on-bucket format: an encrypted note is still a file at its path

Non-negotiable 3, and the constraint that shapes everything visible.

**The path does not change.** `1-projects/foo.md` stays `1-projects/foo.md`. No
`.enc` suffix, no `.encrypted/` folder, no sidecar object. Each of those was
considered and each breaks something the product promises:

- A **suffix** changes the key, which breaks every wikilink pointing at the
  note, every exact-note override in `privacy.md`, every link somebody has in a
  message, and the Obsidian vault the customer syncs. Non-negotiable 2 says a
  brain connects and works unchanged; renaming a file on encryption is a
  migration.
- A **sidecar** (`foo.md` plus `.keys/foo.json`) splits one note into two
  objects that can be moved, copied, restored, or version-rolled apart, and the
  direction that fails is an undecryptable note beside a key nothing points at.
- A **separate encrypted store** is prefix-level tenancy wearing a different
  hat, and non-negotiable 2 refuses it.

**What the file contains.** Plaintext YAML frontmatter marking it encrypted, a
human-readable warning, and one fenced block holding the envelope:

````markdown
---
context_encryption: v1
context_encryption_key: ws:k1
---

> [!NOTE] This note is encrypted.
> Its content is stored as ciphertext and cannot be read here. Open it in
> Context, or decrypt it yourself with the spec in
> docs/decisions/encryption.md.

```context-encrypted
{"v":1,"alg":"A256GCM","iv":"...","ct":"...","recipients":[...]}
```
````

Five things about that shape are load-bearing:

- **It is valid Markdown and valid YAML.** Obsidian renders it as a note with a
  callout and a code block. It does not corrupt, it does not fail to open, it
  does not lose the file. A person looking at their own vault sees a locked note
  and is told, in the file itself, what it is and how to open it — which is what
  "plain files stay canonical" has to mean when the plain file is ciphertext.
- **The frontmatter is a marker, not the envelope.** `context_encryption` is
  what a human, an Obsidian plugin, or a `grep` reads. The parser reads the
  fenced block. Duplicating envelope fields into YAML would create two copies
  of one truth that can disagree.
- **The whole note is the plaintext, frontmatter included.** The wrapper's
  frontmatter is *new*; the note's own `updated`, `tags`, `owner` and body are
  all inside the ciphertext. The alternative — encrypt the body, leave the
  original frontmatter in the clear — requires a rule about which YAML keys are
  content, and `tags:` is content: the search indexer reads it, so leaving it
  out would publish the note's subject matter into the index the feature exists
  to keep it out of. One rule, no list to get wrong.
- **What stays visible is disclosed, not accidental**, and it is exactly what
  the product note already accepted: the path (and therefore the filename and
  folder, which is usually the title), the size, the timestamps, the visibility
  tier, and the existence of the note. Encrypting the filename would mean
  namespacing keys, which non-negotiable 2 forbids outright.
- **The fence language is `context-encrypted`**, which no Markdown renderer
  highlights and no tool executes.

**The envelope.** One JSON object, versioned, language-neutral, self-describing
— the product note's requirement, and the spec a third party implements:

| Field | Meaning |
| --- | --- |
| `v` | Envelope version. `1`. A version this build does not know is a refusal, never a guess. |
| `alg` | Content AEAD. `A256GCM` in v1. |
| `iv` | Base64url, 12 bytes, fresh per encryption. |
| `ct` | Base64url ciphertext with the GCM tag appended, as Web Crypto produces it. |
| `aad` | The associated data, as a literal string, so a decryptor never has to reconstruct it. `context-note-v1:<workspaceId>`. |
| `recipients[]` | `{kind, id, alg, iv, wrapped}`. `kind` is `workspace` or (Phase 2) `passphrase`; `id` names the key that wraps — `k1` for a WDK generation. `wrapped` is the AES-GCM-wrapped note key, AAD `context-note-key-v1:<workspaceId>`. |

**The AAD binds the workspace and deliberately not the path.** Binding the path
would make a move a re-encrypt — a full body rewrite per note inside a bulk
operation that `storage-and-credentials.md` has already measured as too
expensive ("a bulk move still copies every byte through the Worker"), and one
that leaves undecryptable notes behind if it stops halfway. What binding the
path would buy is protection against an attacker who can **write** the
customer's bucket relocating a ciphertext to a path where a different reader can
see it — an attacker who, holding bucket write, can simply overwrite or delete
the note instead. The workspace binding is what carries the weight: it is the
second, independent reason a workspace's key cannot open another workspace's
note, after the fact that the keys differ.

**What a simplification would cost.** A bare base64 body with no JSON header is
smaller and is unversioned, unattributed and un-rotatable: nothing in the file
says which key wrapped it, so the first key rotation is a re-encrypt of every
note, and the first format change is a break with no migration path.

**The tests that fail if this is reversed.** Round-trip vectors, pinned as
fixtures in the repository so that a future decryptor can be checked against
the same bytes ("Preserve old decryptors and test vectors so exports remain
usable without Context.LC"); a v2 envelope is refused rather than
best-guessed; a tampered `ct`, a tampered `aad` and a swapped recipient each
fail authentication rather than returning anything.

---

### What search does

Two indexes, two arguments, one default.

**The D1 projection never receives an encrypted note. At all.** Not its
plaintext, not its ciphertext, not a `notes` row recording that it exists. The
plaintext is obvious — a database Supa Media owns holding the readable text of
a note whose whole point is that a third party cannot read it defeats the
feature entirely. The ciphertext is less obvious and is refused for two
reasons: it is useless (FTS5 cannot rank base64, and BM25 over it would poison
the corpus statistics that `search.md` splits tables to protect), and it is
still a copy of the customer's bytes in a database they "cannot see, revoke, or
delete" ([search](./search.md), "A database we own holds a copy of somebody's
notes only where they asked"). The `notes` row goes too, because a row carrying
a path and a timestamp is an existence claim held somewhere the customer cannot
reach.

**The R2 shard index gets the same default, and the reason is sharper.** That
index lives *inside the customer's own bucket*, so plaintext in it is not a copy
we hold — `search/CONTRACT.md` already says that is acceptable where it lives.
But it lives **under the same credential as the note**. Index the plaintext of
an encrypted note into the shard and a leaked bucket key reads the content
straight out of the index, which is the precise attack this feature exists to
stop. So: off by default, and the honest consequence is stated rather than
discovered — **search does not find encrypted notes.**

**The opt-in has a shape, and it is graded.** The setting is owner-only, per
context, stored in the control plane beside the fast-search opt-in and never in
`privacy.md`, following "The switch lives in a context's settings, and the
server owns who may throw it" exactly:

- `off` — the default, and the only value Phase 1 implements. Encrypted notes
  are not indexed anywhere.
- `bucket` — index the plaintext of encrypted notes into the R2 shard index,
  inside the customer's own bucket. Their storage, their credential, their
  delete. The card says what it hands to whom: *"a leaked bucket key would read
  these notes out of the index."*
- `projection` — **deliberately not built.** It would put the plaintext of an
  encrypted note into a database we own, and the two consents are not the same
  consent. If it is ever built it is a second, separate press with its own copy,
  never a widening of `bucket`.

**What a simplification would cost.** One boolean covering both indexes lets a
customer who wanted a faster search inside their own bucket hand us the
plaintext of the notes they encrypted specifically so that we would not have it.

**The tests that fail if this is reversed.** A projection run over a context
containing an encrypted note writes no `notes` row and no `*_fts` row for it,
and a search by a team-tier caller returns nothing that names it — sabotage-
tested by removing the filter and confirming both fail. A team-tier caller's
result set is byte-identical whether an encrypted private note exists or not.

---

### Round-tripping without damaging ciphertext

Four paths already rewrite note text, and every one of them is a way to destroy
a note that nothing can then recover.

**A move never touches the body.** Because the AAD does not bind the path, the
bytes at the destination are the bytes from the source. `toolMoveNote`,
`toolMoveNotes` and `toolMoveFolder` copy and delete as they already do.
*Test: byte-for-byte equality of the stored object across a move, and across a
folder move that also rewrites `privacy.md`.*

**A link rewrite skips an encrypted note's stored text, and that has a cost we
state.** `rewriteReferences` scans note bodies for wikilinks and Markdown links
and rewrites them when a target moves. An encrypted note's stored body contains
no links — they are inside the ciphertext — so there is nothing there to
rewrite, and running a regex over base64 that happens to contain `[[` is a way
to corrupt a note irreversibly. The scanner therefore recognises the envelope
and skips the note.

The honest consequence: **links written inside an encrypted note are not
rewritten when their target moves, and they go stale.** The alternative is to
decrypt, rewrite and re-encrypt inside a bulk move, which turns a 500-note
folder move into 500 extra decrypt/encrypt cycles inside one Worker invocation
against a 50-subrequest budget — a trade
[storage-and-credentials](./storage-and-credentials.md) has already made in the
other direction. A future single-note move may reasonably do the decrypt-rewrite
for the moved note alone; a bulk one may not.
*Test: an encrypted note's stored bytes are unchanged by a rewrite pass that
changes its neighbours, and the pass still reports honestly.*

**The console editor round-trips plaintext, and a round trip may never be a
downgrade.** The editor reads plaintext and writes plaintext; it never sees the
envelope. The rule that keeps that safe is one line and it is the most
important line in the write path:

> **Whether a write is encrypted is decided by the stored object at that path,
> never by the submitted content.**

If the note at `1-projects/foo.md` is encrypted, a write to it is encrypted —
whatever the client sent, whatever frontmatter it invented, whether or not it
knows the feature exists. A client that fetched plaintext and echoed it back
must not be able to silently store it in the clear, and a client that fetched an
envelope it could not read must not be able to store *that* as the note's new
plaintext. Turning encryption off is a separate, owner-only, explicit call.

This is the same discipline `write_note` already applies to visibility —
"frontmatter is not access control" — applied to the second thing frontmatter
must not be allowed to decide.
*Test: writing plaintext to an encrypted note re-encrypts it; writing an
envelope-shaped body to an encrypted note stores it as plaintext content of a
re-encrypted note rather than as a raw envelope; neither call can clear the
flag.*

**Wikilink completion offers encrypted notes by name and never by content.** A
completion source that read bodies would have to decrypt every candidate on
every keystroke. Paths are already public within the visibility tier, so
completing on them discloses nothing new.

---

### Sharing: an unlisted link over an encrypted note is refused

The brief asks for a decision, and it is **refuse**, in both directions:
minting a link over an encrypted note is refused, and a live link stops
resolving the moment the note is encrypted.

An unlisted share is deliberately the one audience with no name and no session,
and its own decision states the cost it accepts: revocation "stops *future*
reads and cannot retrieve a copy already taken". Both features are defensible.
Their composition is not — it would make the single path in this product with
no identified reader also the path that opens the note the owner was told is
stored unreadable. The owner's model of "encrypted" and their model of "anyone
with this link" cannot both be true of one note, and the product does not get to
pick which one they meant.

The refusal reuses shapes that already exist rather than inventing any:

- Minting is refused at creation, in `createLinkShare`, beside the existing
  courtesy check that already refuses a link over a note the team cannot read —
  and for the same reason that check exists: a link that silently resolves to
  "not available" is indistinguishable, from the owner's side, from having
  published something.
- A note encrypted *after* a link was minted is refused at read, because the
  read path re-derives from the live bucket every time, exactly as it already
  re-derives visibility from live `privacy.md`. Nothing is stored on the share
  row, so nothing on the row can disagree.
- The refusal is the same `NOT_AUTHENTICATED` as every other, so a link holder
  cannot learn whether the note was encrypted, revoked, or never there.

**What a simplification would cost.** "Decrypt it like any other read" is one
line and it publishes the plaintext of an encrypted note to an anonymous URL
that survives every forward.

**The tests that fail if this is reversed.** Minting over an encrypted note is
refused; reading through a link minted before encryption is refused; and the
refusal is byte-identical to the one an invented token gets.

---

### Rotation: three different things, and they must not be confused

1. **The control plane's envelope key** (`STORAGE_SECRET_ENCRYPTION_KEY`). Already
   solved and not re-solved: `requireKeyset` reads current and previous,
   envelopes carry a key id, and the re-encrypt pass moves rows forward. The
   WDK envelope is another row of that shape and rides the same pass. **No note
   is touched, and no bucket is written.**
2. **The workspace data key.** A new WDK is generated and every encrypted note's
   `workspace` recipient is re-wrapped. **The body is not re-encrypted** — only
   the recipient's `wrapped` field changes, which is a small write per note, and
   the pass is resumable because each note's frontmatter names the generation
   (`context_encryption_key: ws:k1`) so what is left to do is a `list` away. Not
   built in Phase 1; what *is* built is the id that makes it possible without a
   format change, and a decrypt path that accepts a generation it did not write
   with.
3. **A passphrase** (Phase 2). Re-wraps that one recipient and nothing else.
   This is precisely what the product note bought when it decided to "wrap the
   data key so a password change does not require re-encrypting note content
   and attachments", and it is why the recipient list is the format.

**What a simplification would cost.** Leaving the generation id out of the
envelope makes the first WDK rotation a re-encrypt of every encrypted note in a
customer's bucket, with no way to tell which ones are already done.

---

### Revocation and export: the customer keeps a usable context, or this feature breaks the first non-negotiable

Non-negotiable 1 says a customer can revoke our credential and keep a complete,
usable context. With encryption that sentence is only true if they can also get
the key — otherwise this feature quietly converts "your notes, in your bucket"
into "your notes, in your bucket, hostage to our database".

So the export is part of the feature and not a follow-up.

**`export_encryption_keys`** — owner-only, available in the console and over
MCP, returns for the acting workspace:

- the workspace data key **in the clear**, base64, to the owner who
  authenticated, over TLS, in a response that is never logged and never written
  to the bucket;
- the envelope version and algorithm identifiers it opens;
- a pointer to this spec.

**In the clear, and not "wrapped so they can unwrap it later"**, because the
customer has nothing to unwrap it with: a wrapped key handed to somebody who
does not hold the wrapping key is a rock. The entire purpose of the export is
that afterwards, the customer's bucket plus one string is a complete context,
with or without us. That is the promise, so the artifact has to be able to keep
it.

Five consequences, each a decision:

- **Exporting widens the blast radius, one way, and the console says so at the
  moment of the press.** After the export the key is wherever the owner put it.
  There is no un-export.
- **Owner-only**, on the explicit role — write access to every note in a context
  is not the authority to decide where the key that opens them lives. Same
  reasoning as the search opt-in being owner-only.
- **Audited**, as a row in `.audit/` in the customer's own bucket, naming the
  acting identity, because "audit records the acting identity, not just the
  scope".
- **There is no import.** No endpoint accepts a key from a caller, ever. One
  would be a decryption oracle: hand the gateway a key and a ciphertext and ask
  whether they match.
- **It is offered when encryption is first turned on, not only at the exit.**
  A customer who revokes our credential having never exported has ciphertext
  they cannot open. The same reasoning puts the bucket-versioning advice in the
  setup guide rather than in the delete dialog.

**And the decryptor is a file, not a promise.** The envelope module in
`apps/mcp/src` is dependency-free Web Crypto in an MIT-licensed public
repository, and the table above is a complete spec. "You can still read your
notes" is something somebody can run.

**What a simplification would cost.** Skipping the export ships a feature that
breaks the first non-negotiable — the one thing this file is not allowed to do.

**The tests that fail if this is reversed.** An exported key decrypts a note
taken straight out of the bucket, through the pure module, with no gateway and
no control plane in the path; a non-owner is refused; and `structure.test.ts`
counts the export as an enumerated barrier rather than letting a public function
quietly reach a key.

---

### What Phase 1 builds, and what it does not

**Builds:** the envelope format and a pure encrypt/decrypt module in the
gateway; the workspace data key in the control plane behind the existing
credential-reachability guard; the gateway read/write path
encrypting and decrypting at request time; an owner-only tool to turn
encryption on and off for one note; the search exclusion; the move and
link-rewrite safety; the key export; and a locked state in the console.

**Does not build, deliberately:** the passphrase recipient and everything it
implies (client-side Argon2id, an unlock session, idle auto-lock, a change-
password flow); WDK rotation (only the id that makes it possible); encrypted
attachments and images; encrypted note *titles* or paths, which non-negotiable 2
forecloses anyway; the `bucket` and `projection` search opt-ins; and any claim
that we cannot read these notes.

**The one question only the owner can answer** is the first of the product
note's own open decisions, restated with what has since been learned: **is a
note allowed to drop its `workspace` recipient — genuinely unreadable by
Supa Media, and therefore invisible to every AI client the customer has
connected?** That is the difference between "encrypted at rest" and what the
product note asked for, it is the whole of Phase 2's scope, and it is a product
call about which failure mode the customer prefers, not an engineering one.
