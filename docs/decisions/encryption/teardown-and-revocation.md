# Encryption — teardown and revocation

### What a teardown deletes, and what it keeps — OPEN

`deleteWorkspaceCascade` in `apps/convex/functions/account.ts` is the largest
destructive operation this product has, and its own header states the promise
it keeps: "the customer's bucket is never touched: what is deleted here is our
metadata about it, **credential included**". Two encryption tables part company
there, and only one of them parts company on purpose:

- **`workspaceKeyRotations` is swept.** It is a workspace id, two generation
  labels and two timestamps — a fact about a workspace that is ceasing to
  exist, with no key material in it. Added to the cascade in adversarial
  review, because a new table nobody swept is how the next teardown census
  goes stale.
- **`workspaceDataKeys` is not**, and that is the open question. Every
  generation survives the deletion of the workspace it belongs to.

Both readings are defensible and neither has been decided:

*Keep it* is what the grace period above says everywhere else. The customer's
encrypted notes are still in the customer's own bucket — the cascade
deliberately does not touch a byte of them — and a sweep here would make every
one of them permanently unopenable, silently, for anybody who deleted their
account without exporting first. That is the same "a purge looks exactly like
a fix" argument that keeps a retired generation forever.

*Delete it* is what the cascade's own sentence promises. A workspace data key
is a credential by every definition this repository uses (`schema.ts` calls the
material radioactive; `structure.test.ts` guards it as one), and after a
teardown there is no longer any *product* path to it — no binding, no
workspace, no gateway route — so keeping the row buys the former customer
nothing while leaving Supa Media holding the one key that turns their bucket
back into plaintext. "We deleted your account" and "we kept the key to your
notes" are hard to say in the same paragraph.

**What decides it is a console flow, not a line in a sweep.** The two readings
converge the moment deletion makes an owner export first: export, confirm,
then delete both the workspace and its generations. Until that flow exists,
this codebase keeps the rows, and
`apps/convex/__tests__/account.test.ts` asserts *both* halves — the rotation
rows gone, the two generations still there — so whichever way this is settled,
it is settled by somebody changing a test that says why.

---

### Revocation and export: the customer keeps a usable context, or this feature breaks the first non-negotiable

Non-negotiable 1 says a customer can revoke our credential and keep a complete,
usable context. With encryption that sentence is only true if they can also get
the key — otherwise this feature quietly converts "your notes, in your bucket"
into "your notes, in your bucket, hostage to our database".

So the export is part of the feature and not a follow-up.

**`export_encryption_keys`** — owner-only, available in the console and over
MCP, returns for the acting workspace every *live* key generation, in the
clear, in one versioned document:

```json
{
  "v": 1,
  "workspace_id": "kg2c...",
  "exported_at": "2026-09-07T20:00:00.000Z",
  "current": "k2",
  "keys": [
    { "generation": "k1", "alg": "A256GCM", "key": "<base64 AES-256>" },
    { "generation": "k2", "alg": "A256GCM", "key": "<base64 AES-256>" }
  ],
  "envelope": { "version": 1, "alg": "A256GCM", "spec": "docs/decisions/encryption.md" }
}
```

Five fields, and each is load-bearing rather than convenient:

- **`v`** — the export format's own version, independent of `envelope.version`
  (the note-envelope format's version). An export bundles zero or more
  note-envelope-openers; it is not itself a note envelope, and the two have no
  reason to change together. A future `v2` export is refused rather than
  guessed at, the same discipline `assertEnvelopeShape` already applies to a
  note.
- **`keys` is an array of every live generation, not only `current`.** A
  bucket can hold notes from before the workspace's most recent rotation —
  that is the entire point of a generation surviving retirement rather than
  being deleted — and an export that carried only the current key would be an
  export that cannot open them. `current` is named separately so a decryptor
  (or a human) knows which one a freshly-encrypted note would use; every entry
  is independently sufficient to open the notes wrapped under it.
- **`key` is `alg`-qualified per entry**, not assumed from the top-level
  `envelope.alg`, so a future mixed-algorithm export (a hypothetical A256GCM
  generation beside a hypothetical successor) is representable without a
  format break — mirroring why a note's own recipients each carry their own
  `alg` rather than inheriting the envelope's.
- **`envelope`** is a pointer, not a duplicate of the spec: version, algorithm,
  and where the rest of the contract lives, so a decryptor reading this file
  cold knows what it is looking at before it opens `docs/decisions/encryption.md`.
- **No `iv`, no `ct`, nothing content-shaped.** This document opens notes; it
  does not contain one. The distinction matters because this file is handed to
  operating systems, clipboard managers and password vaults that a note's own
  ciphertext should never reach.
- **And no passphrase recipient, ever.** The format can *describe* one — a
  note's envelope carries the `passphrase` kind and its KDF descriptor, and
  `packages/encryption-decryptor` reads both — but an export carries workspace
  generations and nothing else, because a passphrase is not a thing this
  control plane holds, and a "recovery" field that looked like it might be is
  worse than an absent one. The consequence is stated where it is met rather
  than left to be discovered: the export's own text names it, and the
  decryptor refuses a passphrase-locked note **by name** — "no key export
  opens it, only the passphrase does" — instead of reporting a generation
  missing from the bundle, which would send somebody hunting for a key that
  was never written down.

**In the clear, and not "wrapped so they can unwrap it later"**, because the
customer has nothing to unwrap it with: a wrapped key handed to somebody who
does not hold the wrapping key is a rock. The entire purpose of the export is
that afterwards, the customer's bucket plus one file is a complete context,
with or without us. That is the promise, so the artifact has to be able to keep
it.

**`packages/encryption-decryptor`** is the reference implementation that reads
this document: a zero-npm-dependency Node CLI, `context-decrypt <keys.json>
<note-or-bucket-dir> [output]`, built independently of
`apps/mcp/src/encryption.js` rather than importing it — the whole point of a
written spec is that a third party can implement it without the original
code, and `packages/encryption-decryptor/test/decrypt.test.mjs` proves the
independence is real by encrypting with the gateway's own module and opening
the result with the decryptor's. It decrypts one note or walks a whole
exported bucket, copying everything that is not an encrypted note through
byte-for-byte and leaving a note it cannot open out of the output tree rather
than passing ciphertext through under a plaintext-looking name.

**That rule is the same rule for one note as for a tree**, which it was not at
first: single-file mode fell through to "write back what was read", so
`context-decrypt keys.json note.md out.md` on a corrupted envelope wrote the
envelope to `out.md` and announced it as "copied (already plaintext)", and
`... note.md > note.txt` piped base64 into a file that looks like a recovered
note. The exit code was 2 in both cases and the bytes were still wrong, which
is the failure mode worth naming: the person running this has already revoked
our credential, so a file that looks recovered and is not is a loss they find
out about later. Nothing is written and nothing is printed for a note this key
file does not open — only the reason.

Five consequences, each a decision:

- **Exporting widens the blast radius, one way, and both surfaces say so at the
  moment of the press.** After the export the key is wherever the owner put it.
  There is no un-export.
- **Owner-only, on the explicit role** — write access to every note in a
  context is not the authority to decide where the key that opens them lives.
  Same reasoning as the search opt-in being owner-only. Over MCP a team-tier
  caller does not even learn the tool exists: `export_encryption_keys` is
  refused with the byte-identical `unknown tool: export_encryption_keys` a
  caller gets for a name it invented, the same idiom `canSee` already applies
  to a path ("byte-identical to a path that never existed"), now applied to a
  capability rather than a note.

  **That claim is two halves, and it was one for a while.** The refusal is in
  `callTool`; the listing is in `toolsForSession`, and until
  `PRIVATE_TIER_ONLY_TOOLS` existed the second half was missing — `tools/list`
  handed a team-tier connection the name, the description and the sentence
  "export this context's workspace data key(s) in the clear", and then the
  call said the tool was unknown. A masked refusal about a capability the same
  connection has just been advertised masks nothing, and the mechanism that
  fixes it already existed for `list_plugins`, which is the shape this should
  have been copied from. Both `export_encryption_keys` and
  `rotate_encryption_keys` are now filtered out of the listing for a
  connection that reads at the private tier in no context it covers, and the
  listing half is asserted beside the call half — either alone passes for a
  gateway that gets the other one wrong.
- **Rate limited**, independently on each surface because the two share no
  state to spend a round trip reaching: the console's `authorizeEncryptionExport`
  counts against `apps/convex/functions/lib/rateLimit.ts`'s table, five per
  rolling day; the gateway's tool counts against a small JSON counter at
  `.context/encryption-export-rate.json` in the customer's own bucket, the same
  policy, best-effort under a genuine race — an acceptable gap for a limit
  defending an owner's own repeated access to their own key, where the harm
  being defended against is a compromised session harvesting the key by
  retrying, not a race with itself.
- **Audited on both surfaces, by their own existing audit trail.** The gateway
  tool writes to `.audit/` in the customer's own bucket, naming the acting
  identity and the OAuth client, through the same `recordChange` every other
  audited gateway write uses. The console action writes to the control plane's
  own `auditEvents` table, naming the acting user, through the same
  `recordAudit` `storage.rekeyed` already uses — a different audit trail
  because the two surfaces have different unavoidable state (an OAuth client
  id exists only on the gateway path; a control-plane user session exists only
  on the console path), not two shapes for the same fact. Neither ever
  carries the exported key material.
- **There is no import.** No endpoint accepts a key from a caller, ever. One
  would be a decryption oracle: hand the gateway a key and a ciphertext and ask
  whether they match.
- **It is offered when encryption is first turned on, not only at the exit.**
  A customer who revokes our credential having never exported has ciphertext
  they cannot open. The same reasoning puts the bucket-versioning advice in the
  setup guide rather than in the delete dialog. **Wired into the console's own
  settings screen, in Advanced.** `exportEncryptionKeys` in
  `apps/convex/functions/encryptionKeys.ts` is called from
  `apps/mobile/features/console/advanced/useAdvanced.ts`, which builds the
  versioned document above (`buildKeyExportDocument` in `advanced.ts`, kept in
  lockstep with `renderKeyExport` by the same field names and the same
  `apps/mcp/src/encryption.js` shape) and hands it to
  `settings/panels/AdvancedPanel.tsx`. The console's version of the two-surface
  argument below: owner-only, two presses before anything leaves the screen
  (`useArming`, the same control `Disconnect` uses), and a Copy button rather
  than a file download — React Native has no cross-platform "save a file"
  primitive, and the JSON is short enough that a clipboard round-trip loses
  nothing a download would have kept. `ConsoleData.advanced.keyExport` is the
  whole property, absent — not disabled — for anyone who is not this context's
  owner and in the read-only landing-page demo, the same rule `StorageActions`
  states throughout the console.

**The console's export reaches the same barrier the gateway's does, and
neither is a second cryptosystem.** `exportWorkspaceDataKeys` — a
`CREDENTIAL_BARRIER`, `__tests__/structure.test.ts` — is the one function that
decrypts every generation and hands the plaintext back; the console's public
`exportEncryptionKeys` action calls it only after `authorizeEncryptionExport`
has spent the rate limit and written the audit row in the same transaction,
and the gateway's `export_encryption_keys` tool reaches the same material
because `/gateway/binding` already decrypts every live generation for
ordinary decrypt — export is a formatting step over what that route already
returns, not a new credential path.

**And the decryptor is a file, not a promise.** `packages/encryption-decryptor`
is dependency-free Web Crypto in an MIT-licensed public repository, and the
table above is a complete spec.

**Its suite runs in CI, which it did not at first** — `Test Offline Decryptor`
in `.github/workflows/mcp.yml`, beside `Test Meetings Core`, whose own comment
records the identical failure one package earlier: the reusable pipeline
filters on `apps/mobile`, `apps/convex` and `packages/shared`, and nothing
invoked this package's tests, so its 23 checks were local-only. That matters
more here than for most packages, because this suite is also the only thing
that checks the gateway's envelope *writer* against an independent *reader*.
It encrypts with `apps/mcp/src/encryption.js` and opens the result with its
own parser, so it catches exactly the class of bug a single implementation
cannot: one both halves would have shared. It runs on every pull request,
including one that touches only the gateway's envelope module. "You can still read your notes" is something
somebody can run — `npx @supa-media/context-encryption-decryptor keys.json
./my-bucket ./out`.

**What a simplification would cost.** Skipping the export ships a feature that
breaks the first non-negotiable — the one thing this file is not allowed to do.

**The tests that fail if this is reversed.** An exported key decrypts a note
taken straight out of the bucket, through the pure module, with no gateway and
no control plane in the path; a non-owner is refused — an editor, a `member`,
and a signed-in owner of a *different* context naming this one's id, which is
the only id the console's export lets a caller choose; the rate limit is spent
per context rather than per session, so two owners of one context share one
window and a second client does not get five more; and `structure.test.ts`
counts the export as an enumerated barrier rather than letting a public
function quietly reach a key.

**And the credential-field guard names the field the key actually travels
under.** `PLAINTEXT_CREDENTIAL_FIELDS` listed `datakey`, which was the name on
`/gateway/binding` until rotation made a context's keys a set; the export
returns `material`. Nothing was called `dataKey` any more, so for a while a
public Convex function could have returned a workspace data key and passed the
guard — measured, by adding one: 0 failures. `material` is listed now, with
`DELIBERATE_KEY_DISCLOSURES` enumerating the two functions allowed to declare
it, so a third fails CI loudly. That is the same shape, and the same stated
residual risk, as `CREDENTIAL_BARRIERS`: the enumeration is the mitigation,
because it forces the conversation.

---
