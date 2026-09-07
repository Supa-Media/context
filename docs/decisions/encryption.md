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

**For a note locked with a passphrase, three rows move.** Supa Media joins the
first table rather than the second; "a named grantee's AI client" joins it too,
which is the cost the owner accepted; and "the gateway" joins it, in the
strongest sense available — there is no code path from a gateway request to that
note's plaintext, and the suite asserts it on the source rather than on
behaviour. The only reader is somebody who knows the passphrase, in the console.

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

**That has now happened, for one of the two modes.** A note locked with a
passphrase carries no workspace recipient, so for *that note* every sentence in
the second list is true and may be said. Nothing about the at-rest mode changed,
and no surface may blur them: see "Encrypted notes are for humans; no AI client
reads one" for the two-column table that keeps them apart.

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

**Both of those were answered by the owner, and Phase 2 shipped the first
one**: a note may drop its workspace recipient, and in fact a passphrase note
never has one. The reasoning above is left standing rather than rewritten,
because it is why the format made that answer a one-line change instead of a
migration. The answer itself, and what it costs, is "Encrypted notes are for
humans; no AI client reads one".

**Two open questions belonged to the owner and are not answered here**, because
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
| `recipients[]` | `{kind, id, alg, iv, wrapped}`. `kind` is `workspace` or `passphrase`; `id` names the key that wraps — `k1` for a WDK generation, `p1` for the first passphrase. `wrapped` is the AES-GCM-wrapped note key, AAD `context-note-key-v1:<workspaceId>`. |
| `recipients[].kdf` | **`passphrase` only.** `{id, v, m, t, p, salt}` — the KDF and every parameter needed to reproduce the key, so a decryptor never guesses. `id` is `argon2id`, `v` is `0x13`, `m` is KiB, `salt` is base64url. The passphrase is NFC-normalised before encoding. See "The KDF, per client". |

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

**The D1 projection never receives an encrypted note's content. At all.** Not
its plaintext and not its ciphertext. The plaintext is obvious — a database
Supa Media owns holding the readable text of a note whose whole point is that a
third party cannot read it defeats the feature entirely. The ciphertext is less
obvious and is refused for two reasons: it is useless (FTS5 cannot rank base64,
and BM25 over it would poison the corpus statistics that `search.md` splits
tables to protect), and it is still a copy of the customer's bytes in a database
they "cannot see, revoke, or delete" ([search](./search.md), "A database we own
holds a copy of somebody's notes only where they asked").

**The row itself stays, empty, and that is a correction to this file made while
implementing it.** The first draft said the `notes` row went too, on the ground
that a path and a timestamp are an existence claim held somewhere the customer
cannot reach. That is true, and it is outweighed by arithmetic nobody would sign
off on once they had seen it: `notesPending` is the census total minus what
`countProjected` finds, so a note the projection never writes a row for is a
note that is pending forever, so the control plane never marks the index
`ready` — **one encrypted note would silently turn fast search off for that
whole context, permanently.** An empty row keeps the diff converging and the
census honest while carrying nothing of the note but its path, which every other
row in the same projection already carries and which `list_notes` hands the same
caller anyway. `indexableText` in `apps/mcp/src/encryption.js` is the one
function both index paths call, so this is a single rule rather than two checks
that can drift.

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

**The tests that fail if this is reversed.** `indexableText` answers `""` for an
encrypted note and its own text for every other; the literal scan does not match
an encrypted note's own envelope (asked with `A256GCM` — a string in every
envelope and in nobody's note — on the first search in a fresh context, so that
it falls to the scan rather than to an index); and the ChatGPT `fetch` dialect
refuses a note it cannot open rather than answering with its ciphertext. A
team-tier caller's result set is unchanged by whether an encrypted private note
exists.

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

**What shipped, and the one edge it does not cover.** `createLinkShare` refuses
with its own code, `PATH_ENCRYPTED` — deliberately not `PATH_NOT_TEAM_VISIBLE`,
because the two send an owner to different places: one says "publish the note
first", the other says "this note is deliberately unreadable, and the audience
with no name is the one that cannot have it". `readThroughShare` refuses again
on every read, from the live object, narrowed to `openToAnyone` — so a note
encrypted *after* a link was pasted stops resolving, and the refusal is the
ordinary anonymous one rather than a new answer a holder could learn from.

A share addressed to a **named person or to a context's members** is not
refused, and today it renders the envelope rather than the note: the control
plane holds no note key and never decrypts, so it has nothing else to show.
That is a broken page and not a disclosure — an envelope is ciphertext — and it
is left rather than fixed here because the fix is a product decision about what
a named reader should see, not an engineering one. What is not left open is the
composition this section is about: the reader with no name gets nothing.

**The tests that fail if this is reversed.** Minting over an encrypted note is
refused; reading through a link minted before encryption is refused, including
for a note the entry note links to; and the refusal is byte-identical — on the
whole error payload, not on its code — to the one an invented token gets.

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

### Encrypted notes are for humans; no AI client reads one

**The decision, in the owner's words: an open-source algorithm plus a password
the person alone knows jumbles the note; anyone with access sees the
ciphertext; a client can read the note only if it has the password. And no
client gets the password.**

That settles the question the section above left open, and it settles it in the
direction that costs the most and means the most. **A passphrase note carries a
`passphrase` recipient and no `workspace` recipient at all.** Not as a flag, not
as an advanced mode: it is what "password-protect this note" does. The sentences
"only you can read this", "we cannot read this", "end-to-end" become true for
that note, because there is no key anywhere in this system that opens it.

What it costs, stated first rather than last, because a person about to press
the button is owed it and the acknowledgement screen says all of it:

- **No assistant reads it.** Not Claude, not ChatGPT, not the console's own
  helpers, not a future agent. A locked note is not in a client's context; it is
  a locked object at a path with a callout saying so.
- **Search does not find it**, which `indexableText` already guaranteed, now
  permanently rather than by an opt-in that could later widen.
- **Nothing we run can repair it.** A corrupted envelope, a lost passphrase, a
  half-finished sync — all of them end at "the note is gone", because the ways
  we could otherwise help all begin with being able to read it.
- **We cannot help somebody who forgets.** There is no reset, no recovery code,
  no escrow. Any of those would be a second key, and a second key is the thing
  this mode exists not to have.

So there are now **two encrypted modes and they are different products**, and
the vocabulary has to keep them apart everywhere:

| | at rest (Phase 1) | locked (Phase 2) |
| --- | --- | --- |
| recipient | `workspace` | `passphrase` |
| who can read it | the gateway, so every client the customer connected | whoever knows the passphrase, in the console |
| protects against | the storage provider, a stolen bucket key | all of that, plus us |
| a lost key means | nothing; we hold it | the note is gone |
| turned on by | `set_encryption`, from any private-scope client | the console, behind an acknowledgement |

**The gateway is not a reader of the second one, and that is enforced rather
than intended.** No tool takes a passphrase, a password or a key; the envelope
module never derives a key and imports nothing that could; and `index.js` neither
imports nor calls any of the passphrase functions. A client that guesses at the
interface and sends `passphrase:` alongside a write gets the identical refusal
it gets without one, and the note is byte-for-byte unchanged.

**The write path is where this could have gone catastrophically wrong**, and it
did, silently, in the first draft. "Whether a write is encrypted is decided by
the stored object" was written for one recipient kind: it re-sealed the
submitted content with the workspace key. Applied to a locked note that is a
valid encrypted note at the path, readable by every connected client, with the
owner's lock gone and the ciphertext that was under it destroyed — reported as a
successful write. The rule is now one step stronger, and the stronger form is
the one to keep: **a note this request cannot open is a note this request cannot
write.**

**Other humans, and the sentence that must go with it.** A locked note may be
`team`-visible, and then the people it is shared with see a locked object in the
console and open it if — and only if — the owner gave them the passphrase some
other way. There are no per-person recipient keys and no passphrase-sharing
feature, deliberately: both would be a key-distribution system, which is a
larger product with its own failure modes. The copy therefore says, in the
acknowledgement and beside the visibility control, that **sharing a note does
not share its passphrase.**

**What a simplification would cost.** Keeping the `workspace` recipient
alongside the passphrase — "so clients can still read it" — is one array element
and it deletes the feature: the note would be readable by us, by a subpoena, and
by every connected client, and the passphrase would be a second lock on a door
that is already open. The recipient array still supports both, and one note
carrying both is a coherent thing the format can express; nothing in the product
offers it, because a person who asked for a password would not have asked for a
note we can read.

**The tests that fail if this is reversed.** `set_encryption`-style writes and
`write_note` over a locked note leave the stored bytes byte-identical; a locked
read is the same refusal as a note whose key is merely unavailable, so no
inference channel is added; no advertised tool schema has a passphrase-shaped
argument; the envelope module's own source contains no derivation call and no
import; and a pinned locked note in `apps/mcp/test/` opens with the key its
passphrase derives and with nothing else.

---

### The KDF, per client

The passphrase becomes a key on the device and nowhere else, so the KDF has to
run in whatever the console is running in. Three runtimes, and they are not
equal: the browser, the Electron shell hosting the same web bundle, and Expo on
iOS and Android, which is Hermes.

**What is actually available**, measured rather than assumed:

- **Web Crypto has PBKDF2 and no memory-hard KDF.** `crypto.subtle` in every
  browser and in the Worker offers PBKDF2, SHA-2, AES-GCM and nothing that
  resists a GPU.
- **Hermes has no Web Crypto at all.** Not AES-GCM, not PBKDF2, not
  `getRandomValues` without a polyfill. `expo-crypto` — which this app already
  depends on — provides digests and random bytes, and no cipher and no KDF.
  `react-native-quick-crypto` would provide both and is a **native module**: it
  cannot arrive in an over-the-air update, which is how this app ships, so
  adding it changes the release model rather than a dependency list.
- **WebAssembly is available in the browser and in Electron, and not in
  Hermes.** So a WASM Argon2id is a two-platform answer wearing a three-platform
  coat.

**The measurement.** `apps/mobile/scripts/bench-argon2id.ts` runs the
implementation in this repository, which is dependency-free plain JavaScript.
Two runs on one machine: V8 with its optimising compiler, which is the browser
and the desktop shell; and V8 with `--jitless`, which is the closest a checkout
gets to Hermes without an emulator. Hermes has no JIT either and is expected to
be slower still.

| parameters | with a JIT | interpreted (`--jitless`) |
| --- | --- | --- |
| 8 MiB, t=2 | 0.6 s | 5.9 s |
| **19 MiB, t=2** (OWASP's floor) | **1.1 s** | **12.7 s** |
| 32 MiB, t=2 | 1.9 s | 21.0 s |
| 64 MiB, t=3 (RFC 9106's second option) | 6.1 s | 64.7 s |

**The decision.**

1. **Web and the desktop shell: Argon2id, in plain JavaScript, at 19 MiB, t=2,
   p=1.** OWASP's minimum for Argon2id, about a second per unlock, no new
   dependency anywhere.
2. **iOS and Android: unlocking is refused, by name, with somewhere to go.**
   "Locked notes open on a computer." Never a quieter, weaker KDF: a note that
   silently became a PBKDF2 note on a phone would be weaker than the note the
   person was shown, and they would have no way to find out.
3. **The recipient carries `{id, v, m, t, p, salt}`**, so every one of these
   numbers is a parameter rather than a build constant, and a decryptor five
   years from now derives the same key without knowing what this build's
   defaults were.

**What the alternatives cost, named rather than waved at:**

- **Argon2id via WebAssembly** would run the same KDF perhaps three to four
  times faster, which at equal patience means roughly 64 MiB and t=3 instead of
  19 MiB and t=2 — an attacker's cost per guess about 3.4x higher. That is a
  real loss and it is what the pure-JavaScript choice costs. Against it: a
  dependency in the path of somebody's passphrase, which is the one path where a
  supply-chain compromise is not recoverable; a WASM binary Metro has to bundle;
  and it still does nothing for the phone. The door stays open, and it is a
  parameter change rather than a format change when it opens: the same `id`, new
  `m` and `t`, old notes still opening under the numbers they carry.
- **PBKDF2, via Web Crypto, everywhere.** Native in every browser and in the
  Worker, and it would work on Hermes if Hermes had Web Crypto, which it does
  not — so it does not actually buy the phone either. And it is not memory-hard:
  against the offline guessing this whole design assumes, PBKDF2 at any
  iteration count a person will wait for is worth substantially less per second
  of attacker time than Argon2id at 19 MiB. It is defined in the format as a
  distinct KDF id so that a future recipient could name it, and **nothing writes
  it**: a weaker KDF that could be substituted silently is the failure mode this
  section exists to prevent.
- **64 MiB, t=3, in JavaScript.** Six seconds per unlock. An unlock somebody
  waits six seconds for is an unlock they turn off, and a feature turned off is
  weaker than one at OWASP's floor.

**Passphrase length is what compensates**, so the floor is in the code rather
than in advice: twelve characters minimum, several words recommended, and the
acknowledgement screen asks for a passphrase rather than a password in the words
it uses. At 19 MiB and t=2, a six-word passphrase is out of reach of an offline
attacker; an eight-character one is not, at any parameters this or any other
implementation could choose.

**Two details that are format decisions rather than implementation ones**, both
because a second implementation has to reproduce them exactly or somebody's note
will not open:

- **The passphrase is normalised to NFC** before it is encoded. An accented
  character can arrive as one code point or as two depending on the keyboard,
  and the two are different bytes and therefore different keys — somebody would
  set a passphrase on one platform and be told it was wrong on another.
- **The salt is 16 random bytes per recipient**, and a passphrase change draws a
  new one, so two passphrases on one note are related by nothing but the person
  who chose them.

**What a simplification would cost.** Hard-coding the parameters instead of
writing them into the recipient makes the first parameter change a re-encrypt of
every locked note — which cannot be done, because it needs the passphrase for
every one of them. It would make the numbers above permanent.

**The tests that fail if this is reversed.** RFC 9106's own vector, including
the two inputs this product never uses; RFC 7693's vectors for the BLAKE2b
underneath; a pinned passphrase deriving a pinned key that opens a pinned note,
with the two halves asserted in the two suites that run them; a KDF id or an
argon2 version this build does not implement refused rather than substituted;
and `kdfSupport` refusing on a runtime without Web Crypto rather than answering
with a weaker lock.

---

### Bounds on a KDF descriptor, because a bucket is not a trusted input

A passphrase recipient's parameters are read out of a file in the customer's
bucket, and there is exactly one scenario where they are attacker-controlled —
the scenario this whole feature is about: somebody who can write that bucket.
They cannot forge a wrap without the passphrase. They can write `m: 4194304` and
make every unlock attempt allocate four gigabytes, or `t: 1000000` and hang the
tab.

So the descriptor is bounded before anything acts on it, in both the gateway and
the console, with the same numbers: 8 KiB to 2 GiB of memory, 1 to 16 passes, 1
to 16 lanes, an 8- to 64-byte salt, and Argon2's own floor of 8 KiB per lane.
The ceilings are far above anything shipped so that raising the parameters later
is a parameter change and not a format change.

**A note whose envelope fails these bounds stays an encrypted note.** It is
refused at parse, it is still recognised by the marker, nothing indexes it, and
nothing overwrites it — the failure direction that keeps a broken envelope from
becoming a destroyed one.

*The test: every out-of-range descriptor is refused by `assertKdfDescriptor`,
cannot be written into a note by any recipient-editing call, and is refused at
parse when it arrives from the bucket — in both implementations, over one
corpus.*

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

**Phase 2 builds** the first of those lists and nothing else in it: the
`passphrase` recipient and its KDF descriptor, Argon2id in plain JavaScript on
the client, an in-memory unlock session with a manual lock and an idle
auto-lock, a passphrase change that rewraps one recipient without rewriting the
body, the acknowledgement screen, and the guard that stops the gateway writing
over a note it cannot open. It does **not** build: recipient keys for other
people or any way to share a passphrase; unlocking on a phone; encrypted
attachments; a passphrase on a note that also keeps a workspace recipient; or
any recovery path whatsoever, which is the point rather than an omission.

**The one question only the owner can answer** is the first of the product
note's own open decisions, restated with what has since been learned: **is a
note allowed to drop its `workspace` recipient — genuinely unreadable by
Supa Media, and therefore invisible to every AI client the customer has
connected?** That is the difference between "encrypted at rest" and what the
product note asked for, it is the whole of Phase 2's scope, and it is a product
call about which failure mode the customer prefers, not an engineering one.
