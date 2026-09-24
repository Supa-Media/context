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

Moved to [Encryption is confidentiality, and it is not access control](./encryption/threat-model-and-scope.md#encryption-is-confidentiality-and-it-is-not-access-control).

### The threat model, written as a list of names

Moved to [The threat model, written as a list of names](./encryption/threat-model-and-scope.md#the-threat-model-written-as-a-list-of-names).

### What we can still read, and saying so

Moved to [What we can still read, and saying so](./encryption/threat-model-and-scope.md#what-we-can-still-read-and-saying-so).

### The key model: three layers, because two cannot do the job

Moved to [The key model: three layers, because two cannot do the job](./encryption/threat-model-and-scope.md#the-key-model-three-layers-because-two-cannot-do-the-job).

### A customer-held key is in scope as a design and out of scope as a shipped mode

Moved to [A customer-held key is in scope as a design and out of scope as a shipped mode](./encryption/threat-model-and-scope.md#a-customer-held-key-is-in-scope-as-a-design-and-out-of-scope-as-a-shipped-mode).

### The on-bucket format: an encrypted note is still a file at its path

Moved to [The on-bucket format: an encrypted note is still a file at its path](./encryption/format-and-search.md#the-on-bucket-format-an-encrypted-note-is-still-a-file-at-its-path).

### What search does

Moved to [What search does](./encryption/format-and-search.md#what-search-does).

### Round-tripping without damaging ciphertext

Moved to [Round-tripping without damaging ciphertext](./encryption/format-and-search.md#round-tripping-without-damaging-ciphertext).

### Sharing: an unlisted link over an encrypted note is refused

Moved to [Sharing: an unlisted link over an encrypted note is refused](./encryption/sharing-and-rotation.md#sharing-an-unlisted-link-over-an-encrypted-note-is-refused).

### Rotation: three different things, and they must not be confused

Moved to [Rotation: three different things, and they must not be confused](./encryption/sharing-and-rotation.md#rotation-three-different-things-and-they-must-not-be-confused).

### What a teardown deletes, and what it keeps — OPEN

Moved to [What a teardown deletes, and what it keeps — OPEN](./encryption/teardown-and-revocation.md#what-a-teardown-deletes-and-what-it-keeps-open).

### Revocation and export: the customer keeps a usable context, or this feature breaks the first non-negotiable

Moved to [Revocation and export: the customer keeps a usable context, or this feature breaks the first non-negotiable](./encryption/teardown-and-revocation.md#revocation-and-export-the-customer-keeps-a-usable-context-or-this-feature-breaks-the-first-non-negotiable).

### Encrypted notes are for humans; no AI client reads one

Moved to [Encrypted notes are for humans; no AI client reads one](./encryption/clients-and-kdf.md#encrypted-notes-are-for-humans-no-ai-client-reads-one).

### The KDF, per client

Moved to [The KDF, per client](./encryption/clients-and-kdf.md#the-kdf-per-client).

### Bounds on a KDF descriptor, because a bucket is not a trusted input

Moved to [Bounds on a KDF descriptor, because a bucket is not a trusted input](./encryption/clients-and-kdf.md#bounds-on-a-kdf-descriptor-because-a-bucket-is-not-a-trusted-input).

### What Phase 1 builds, and what it does not

Moved to [What Phase 1 builds, and what it does not](./encryption/phases-and-owner-decisions.md#what-phase-1-builds-and-what-it-does-not).

### What Phase 2a adds

Moved to [What Phase 2a adds](./encryption/phases-and-owner-decisions.md#what-phase-2a-adds).

### Additional owner decisions (2026-09-08)

Moved to [Additional owner decisions (2026-09-08)](./encryption/phases-and-owner-decisions.md#additional-owner-decisions-2026-09-08).
