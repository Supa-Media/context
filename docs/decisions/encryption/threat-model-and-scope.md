# Encryption — threat model and scope

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
  ([privacy-and-sharing](../privacy-and-sharing.md), "An unlisted share is the
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
- The console shows a rough offline crack-time estimate beside the passphrase
  field, using an explicit Argon2id guess-rate assumption, and warns that
  common or patterned phrases may be much faster. It is an order-of-magnitude
  guide, not a promise.

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
([storage-and-credentials](../storage-and-credentials.md), "Platform credentials
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
