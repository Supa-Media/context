# Encryption — clients and the KDF

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

**The console's own door is the narrowest form of that rule a keyless runtime
can state, and what it cannot check is a boundary rather than a gap.** The
console holds the passphrase and the control plane does not, so `writeFile`
admits a write to a locked note only when the submission is *itself* a
well-formed envelope naming exactly the recipients already stored **and
byte-identical to the stored note everywhere outside the JSON blob**
(`canReplaceEncryptedNote`). Three checks, and the third — the skeleton — is
the one that stops a caller who holds editor access and no passphrase wrapping
a valid envelope around plaintext smuggled before the frontmatter's close,
between it and the fence, or after the fence's own close. What no check here can
reach is the ciphertext: this runtime cannot tell one locked note's blob from
another's, so an editor **can** put another locked note's envelope, or an older
envelope of this same note, at this path. That is destruction and never
disclosure — it reveals nothing, it downgrades nothing, and it is bounded by the
write authority that caller already has over every byte at that path, which is
this file's own opening line about confidentiality not being deletion protection
or availability, applied where it costs something. Both are asserted in
`apps/convex/__tests__/fileOps.test.ts` rather than merely argued here, so that
a future change which makes them refusals has to come and say so.

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
  iOS builds made after this decision include a small local Expo module:
  CryptoKit supplies AES-256-GCM and secure random bytes, while the pinned
  Argon2 reference C implementation supplies Argon2id. The capability cannot
  arrive in an over-the-air update, so the JavaScript uses an optional native
  lookup and old binaries continue to refuse honestly rather than crash or
  silently choose different cryptography.
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
2. **iOS: the same protocol through native primitives; Android and old iOS
   binaries: refused by name, with somewhere to go.** The iOS module vendors
   `P-H-C/phc-winner-argon2` release `20190702` (commit
   `62358ba2123abd17fccf2a108a301d4b52c01a7c`, CC0/Apache-2.0) and uses Apple
   CryptoKit for AES-256-GCM. It consumes the recipient's existing KDF
   descriptor (`v`, `m`, `t`, `p`, `salt`), NFC-normalises the passphrase, and
   returns the same 32 bytes as the browser and standalone decryptor. It
   changes no envelope byte and requests no permission. Mutable native and
   JavaScript byte buffers are cleared on both
   success and failure paths once ownership ends, but that is lifetime hygiene,
   not a zeroization guarantee: JavaScript and Swift strings are immutable,
   bridge serialization creates copies the app cannot erase, and CryptoKit may
   keep internal copies for an operation. The implementation does not
   intentionally persist or log those values. Never a quieter, weaker KDF:
   where the module is absent, the UI says this build
   cannot open the note and points to an update or a computer.
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
the vendored iOS C source independently deriving that same pinned key; a Swift
executable calling the exact CryptoKit/Argon2 core behind the Expo bridge and
pinning NFC normalization, fixed AES key/nonce/AAD/plaintext bytes,
`ciphertext || tag`, decryption, tamper rejection and wrong-key rejection; a
SHA-256 manifest covering every vendored source file; `kdfSupport` accepting
Hermes only when the optional module is present; and an old binary refusing
rather than answering with a weaker lock.

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

The iOS bridge applies a second, device-local ceiling of **64 MiB** before the
native call, and the Swift core repeats it defensively. This is not an envelope
format limit: a larger valid descriptor remains openable by desktop and the
standalone decryptor. It is an honest mobile resource refusal that prevents an
untrusted bucket object from asking iOS to reserve anything near the format's
2 GiB interoperability ceiling.

**A note whose envelope fails these bounds stays an encrypted note.** It is
refused at parse, it is still recognised by the marker, nothing indexes it, and
nothing overwrites it — the failure direction that keeps a broken envelope from
becoming a destroyed one.

*The test: every out-of-range descriptor is refused by `assertKdfDescriptor`,
cannot be written into a note by any recipient-editing call, and is refused at
parse when it arrives from the bucket — in both implementations, over one
corpus.*

---
