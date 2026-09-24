# Encryption — format and search

### The on-bucket format: an encrypted note is still a file at its path

Non-negotiable 3, and the constraint that shapes everything visible.

**The path does not change.** `1-projects/foo.md` stays `1-projects/foo.md`. No
`.enc` suffix, no `.encrypted/` folder, no sidecar object. Each of those was
considered and each breaks something the product promises:

- A **suffix** changes the key, which breaks every wikilink pointing at the
  note, every exact-note override in `privacy.md`, every link somebody has in a
  message, and the Obsidian vault the customer syncs. Non-negotiable 2 says a
  workspace connects and works unchanged; renaming a file on encryption is a
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

When a path is recreated after a logical deletion, storage may append one
reserved final line after the closing fence:
`<!-- context-generation:v1:<32 lowercase hexadecimal characters> -->`.
This is storage-generation metadata, not encrypted content. Standalone
decryptors must parse the fenced JSON block and ignore this exact trailing
comment; the logical storage view removes it before ordinary note and
re-encryption code sees the document. No other trailing content is accepted
as generation metadata.

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
they "cannot see, revoke, or delete" ([search](../search.md), "A database we own
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

**And "both index paths call it" has to be checked rather than stated, because
for a while it was false.** The R2 half of that sentence pointed at
`maintain.js`'s `syncIndex`, which nothing has called since the sharded index
replaced it; the pass every search and every scheduled sweep actually runs —
`syncShardedIndex` in `apps/mcp/src/search/shards.js` — read note bodies raw, so
an envelope's own terms were tokenised into a shard object sitting in the
customer's bucket beside the note. No plaintext ever reached it, because the
gateway had none to give: the leak was the ciphertext's own terms plus the
callout's words. It was found by asking the built index rather than the helper,
and the check that now owns it (`encryptionGateway.test.mjs`, "...and not one
term of an encrypted note's envelope") reads the shard objects the pass wrote —
a unit assertion about `indexableText` passes just as happily for a caller that
never calls it.

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
encrypted note and its own text for every other; the shard objects a real
indexing pass wrote carry the plaintext notes' terms and not one term of an
encrypted note's envelope; the literal scan does not match
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
[storage-and-credentials](../storage-and-credentials.md) has already made in the
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
