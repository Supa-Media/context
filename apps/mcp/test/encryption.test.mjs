/**
 * THE ENVELOPE — `src/encryption.js`.
 *
 * The pure half of per-note encryption, tested with no store, no session and no
 * control plane, because that is exactly the claim the format makes: a customer
 * who exported their workspace key can read their notes with this module and a
 * Web Crypto implementation and nothing else. A suite that needed a worker
 * standing up to prove that would be proving something weaker.
 *
 * Four things are asserted, in the order they would bite:
 *
 * 1. **A round trip is a round trip**, and the same plaintext encrypts to
 *    different bytes every time.
 * 2. **A workspace's key never opens another workspace's note** — twice over,
 *    once because the keys differ and once because the AAD does. Both halves
 *    are tested separately, because a single test that swaps both proves only
 *    that *something* stopped it.
 * 3. **Tampering fails closed**, in every field an attacker with bucket write
 *    can reach: the ciphertext, the AAD label, the wrap, the version.
 * 4. **A note that claims to be encrypted and is not readable as one throws**,
 *    where an ordinary note returns `null`. That asymmetry is the only thing
 *    standing between a malformed envelope and a caller serving it as plaintext
 *    or overwriting it as though it were one.
 *
 * ## The pinned vector
 *
 * `encryptionVector.fixtures.json` holds one envelope, its key, and the
 * plaintext it opens to. It is checked in so that a future change to the format
 * cannot pass by changing the writer and the reader together — the product note
 * asks for exactly this ("Preserve old decryptors and test vectors so exports
 * remain usable without Context.LC"). **The key in it is a fixture**: generated
 * for this repository, bound to a workspace id that does not exist, and it opens
 * nothing but the string beside it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `isEncryptedNote` returning `false` unconditionally                       5
 *   `contentAad` dropping the workspace id                                    3
 *   `wrapAad` returning `contentAad`'s literal                                2
 *   `parseEncryptedNote` returning `null` instead of throwing on a bad
 *     envelope                                                                2
 *   `decryptNote` skipping the `envelope.aad !== expected` check              1
 *   `assertEnvelopeShape` accepting any `v`                                   1
 *
 * Two of those rows are findings about *this file* rather than about the
 * source, and both changed it.
 *
 * **The marker sabotage measured zero on its first run, by crashing.** With
 * `isEncryptedNote` answering `false`, `decryptNote` refuses its own output —
 * and it refuses it with a `NoteCryptoError`, which every "is refused" check
 * here would have accepted. What actually happened was worse than a false pass:
 * the unguarded round-trip call threw, node exited, and the whole gateway suite
 * reported zero PASS and zero FAIL. That is the failure `test.mjs`'s own header
 * warns about. Every call into the module now goes through `value()`, so a
 * throw is a FAIL on the check that owns it, and `isEncryptedNote` is asserted
 * directly rather than only through `parseEncryptedNote`.
 *
 * **Dropping the workspace id from the content AAD does not, on its own, let
 * one workspace open another's note** — the wrap AAD and the key both still
 * refuse. That is exactly why the isolation checks below are written as two
 * independent assertions instead of one swap of both.
 *
 * The last two rows are one FAIL each and that is the honest number: one
 * invariant, one check that owns it. A wider blast radius there would mean
 * something else was depending on the version gate, which is not a property
 * worth manufacturing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTENT_ALG,
  ENVELOPE_VERSION,
  NoteCryptoError,
  contentAad,
  decryptNote,
  encryptNote,
  encryptedNoteKeyId,
  generateWorkspaceKey,
  generatedNoteBytes,
  isEncryptedNote,
  parseEncryptedNote,
  renderEncryptedNote,
  wrapAad,
} from "../src/encryption.js";

const VECTOR = JSON.parse(
  readFileSync(fileURLToPath(new URL("./encryptionVector.fixtures.json", import.meta.url)), "utf8"),
);

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbb";

const PLAINTEXT = [
  "---",
  "updated: 2026-09-07",
  "tags: [private, finance]",
  "---",
  "",
  "# A note somebody encrypted",
  "",
  "It links to [[1-projects/other]] and it should not be readable in the bucket.",
  "",
].join("\n");

async function threw(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Every call into the module goes through here.
 *
 * A check that throws kills the process and takes the rest of the gateway suite
 * with it — zero PASS, zero FAIL, exit 1 — which `test.mjs` calls out as a
 * worse signal than a failure, and which is exactly what the first version of
 * this file did under one of the sabotages below. A throw must be a FAIL on the
 * check that owns it.
 */
async function value(fn) {
  try {
    return await fn();
  } catch (error) {
    return { threw: error };
  }
}

/** Replace one field inside the envelope block without touching anything else. */
function editEnvelope(document, mutate) {
  const envelope = parseEncryptedNote(document);
  mutate(envelope);
  return renderEncryptedNote(envelope);
}

export async function runEncryptionChecks(check) {
  const keyA = generateWorkspaceKey();
  const keyB = generateWorkspaceKey();

  // -- 1. a round trip is a round trip ------------------------------------

  const stored = await encryptNote(PLAINTEXT, {
    workspaceId: WORKSPACE_A,
    workspaceKey: keyA,
    keyId: "k1",
  });

  check(
    "an encrypted note round-trips to exactly its plaintext",
    (await value(() => decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }))) ===
      PLAINTEXT,
  );

  // Asked directly, and not only through `parseEncryptedNote`. A predicate that
  // answers `false` for every note makes `decryptNote` refuse its own output
  // with a `NoteCryptoError` — which every "is refused" check below would
  // happily accept, so without this line the whole marker could be broken and
  // most of this file would still pass.
  check("an encrypted note answers the marker predicate", isEncryptedNote(stored) === true);

  // The whole note is the plaintext — frontmatter, tags and links included.
  // A format that left the original frontmatter in the clear would leak `tags:`
  // into everything that reads a note without decrypting it.
  check(
    "no fragment of the plaintext survives into the stored bytes",
    !stored.includes("finance") &&
      !stored.includes("2026-09-07") &&
      !stored.includes("1-projects/other") &&
      !stored.includes("somebody encrypted"),
  );

  const storedAgain = await encryptNote(PLAINTEXT, {
    workspaceId: WORKSPACE_A,
    workspaceKey: keyA,
    keyId: "k1",
  });
  check(
    "the same plaintext encrypts to different bytes every time",
    storedAgain !== stored &&
      (await value(() =>
        decryptNote(storedAgain, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
      )) === PLAINTEXT,
  );

  // -- the file is still a file, and Obsidian can open it ------------------

  check("an encrypted note is still valid frontmatter", stored.startsWith("---\n"));
  check(
    "...marked in the frontmatter, where a human or a grep can see it",
    /^context_encryption: v1$/m.test(stored),
  );
  check(
    "...naming the key generation, so a re-wrap pass can find what is left",
    /^context_encryption_key: ws:k1$/m.test(stored) && encryptedNoteKeyId(stored) === "k1",
  );
  check(
    "...and saying, in the file itself, what it is and how to open it",
    stored.includes("This note is encrypted.") &&
      stored.includes("docs/decisions/encryption.md"),
  );
  check(
    "the envelope sits in an inert fenced block",
    stored.includes("```context-encrypted\n") && stored.trimEnd().endsWith("```"),
  );

  const envelope = await value(() => parseEncryptedNote(stored));
  check("...which parses back out of the stored note", envelope !== null && !envelope.threw);
  check(
    "the envelope is self-describing: version, algorithm, literal AAD, recipients",
    envelope.v === ENVELOPE_VERSION &&
      envelope.alg === CONTENT_ALG &&
      envelope.aad === contentAad(WORKSPACE_A) &&
      Array.isArray(envelope.recipients) &&
      envelope.recipients.length === 1 &&
      envelope.recipients[0].kind === "workspace" &&
      envelope.recipients[0].id === "k1",
  );
  check(
    "the recipient's wrapped key is not the note key in the clear",
    typeof envelope.recipients[0].wrapped === "string" &&
      envelope.recipients[0].wrapped.length > 0 &&
      envelope.recipients[0].wrapped !== envelope.recipients[0].iv,
  );
  check(
    "the content AAD and the wrap AAD are different literals",
    contentAad(WORKSPACE_A) !== wrapAad(WORKSPACE_A) &&
      contentAad(WORKSPACE_A).includes(WORKSPACE_A) &&
      wrapAad(WORKSPACE_A).includes(WORKSPACE_A),
  );

  // -- 2. tenant isolation, twice over ------------------------------------

  const storedB = await encryptNote(PLAINTEXT, {
    workspaceId: WORKSPACE_B,
    workspaceKey: keyB,
    keyId: "k1",
  });

  // Half one: B's key against A's note, asked *as* workspace A — so the AAD is
  // right and only the key is wrong.
  check(
    "a workspace's key does not open another workspace's note",
    (await threw(() => decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k1: keyB } })))
      instanceof NoteCryptoError,
  );

  // Half two: A's own key against B's note. The AAD refuses before the key is
  // even reached, which is the half that survives a key-management mistake.
  const crossContext = await threw(() =>
    decryptNote(storedB, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
  );
  check(
    "...and an envelope carried into another context is refused on its binding",
    crossContext instanceof NoteCryptoError && /different context/.test(crossContext.message),
  );

  // And the belt-and-braces case: both wrong at once, which must also fail —
  // stated separately so that a future change cannot leave only this one green.
  check(
    "...and asking as the other workspace with the other key fails too",
    (await threw(() => decryptNote(stored, { workspaceId: WORKSPACE_B, keys: { k1: keyB } })))
      instanceof NoteCryptoError,
  );

  check(
    "a deployment with no key for the named generation refuses rather than guessing",
    (await threw(() => decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k9: keyA } })))
      instanceof NoteCryptoError,
  );

  // Rotation's shape: a keyset holding both generations opens a note written
  // under either. This is what makes a re-wrap pass resumable rather than a
  // flag day.
  const olderGeneration = await encryptNote(PLAINTEXT, {
    workspaceId: WORKSPACE_A,
    workspaceKey: keyB,
    keyId: "k0",
  });
  check(
    "a keyset spanning two generations opens notes written under either",
    (await value(() =>
      decryptNote(olderGeneration, { workspaceId: WORKSPACE_A, keys: { k0: keyB, k1: keyA } }),
    )) === PLAINTEXT &&
      (await value(() =>
        decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k0: keyB, k1: keyA } }),
      )) === PLAINTEXT,
  );
  check(
    "...and the generation each names is readable without opening it",
    encryptedNoteKeyId(olderGeneration) === "k0" && encryptedNoteKeyId(stored) === "k1",
  );

  // -- 3. tampering fails closed ------------------------------------------

  const flippedCiphertext = editEnvelope(stored, (e) => {
    e.ct = e.ct.slice(0, -4) + (e.ct.endsWith("AAAA") ? "BBBB" : "AAAA");
  });
  check(
    "a tampered ciphertext fails authentication rather than yielding anything",
    (await threw(() =>
      decryptNote(flippedCiphertext, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
    )) instanceof NoteCryptoError,
  );

  const relabelled = editEnvelope(stored, (e) => {
    e.aad = contentAad(WORKSPACE_B);
  });
  check(
    "an envelope relabelled for another context is refused",
    (await threw(() => decryptNote(relabelled, { workspaceId: WORKSPACE_B, keys: { k1: keyA } })))
      instanceof NoteCryptoError,
  );

  const swappedWrap = editEnvelope(stored, (e) => {
    e.recipients[0].wrapped = parseEncryptedNote(storedB).recipients[0].wrapped;
    e.recipients[0].iv = parseEncryptedNote(storedB).recipients[0].iv;
  });
  check(
    "a recipient's wrapped key taken from another note is refused",
    (await threw(() => decryptNote(swappedWrap, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })))
      instanceof NoteCryptoError,
  );

  const futureVersion = stored.replace('"v":1', '"v":2');
  check(
    "an envelope version this build does not know is refused, never best-guessed",
    (await threw(() => decryptNote(futureVersion, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })))
      instanceof NoteCryptoError,
  );

  const shortIv = editEnvelope(stored, (e) => {
    e.iv = e.iv.slice(0, 4);
  });
  check(
    "a malformed IV is refused before Web Crypto is asked",
    (await threw(() => decryptNote(shortIv, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })))
      instanceof NoteCryptoError,
  );

  check(
    "a key that is not 32 bytes is refused rather than stretched or truncated",
    (await threw(() =>
      encryptNote("x", { workspaceId: WORKSPACE_A, workspaceKey: "c2hvcnQ=", keyId: "k1" }),
    )) instanceof NoteCryptoError,
  );

  check(
    "a note cannot be encrypted without a workspace to bind it to",
    (await threw(() => encryptNote("x", { workspaceId: "", workspaceKey: keyA, keyId: "k1" })))
      instanceof NoteCryptoError,
  );

  check(
    "a key generation id outside the allowed charset is refused",
    (await threw(() =>
      encryptNote("x", { workspaceId: WORKSPACE_A, workspaceKey: keyA, keyId: "k:1" }),
    )) instanceof NoteCryptoError,
  );

  // -- 4. the two failure directions --------------------------------------

  const ordinary = "---\nupdated: 2026-09-07\n---\n\n# An ordinary note\n";
  check("an ordinary note is not encrypted", !isEncryptedNote(ordinary));
  check("...and parsing it costs no throw, it answers null", parseEncryptedNote(ordinary) === null);
  check("a note with no frontmatter at all is not encrypted", !isEncryptedNote("# Hello\n"));
  check("...and neither is an empty one", !isEncryptedNote("") && !isEncryptedNote(undefined));

  // A note that merely *mentions* the marker in its body is an ordinary note.
  // The marker is a frontmatter key, and reading it out of the body would let
  // anybody make one of their own notes unreadable by writing about this
  // feature in it.
  check(
    "a note that mentions the marker in its body is still an ordinary note",
    !isEncryptedNote("---\nupdated: 2026-09-07\n---\n\ncontext_encryption: v1 is a frontmatter key.\n"),
  );

  const markerNoBlock = "---\ncontext_encryption: v1\n---\n\nnothing here\n";
  check("a note claiming encryption with no envelope block throws", isEncryptedNote(markerNoBlock));
  check(
    "...rather than answering null, which a caller would serve as plaintext",
    (await threw(async () => parseEncryptedNote(markerNoBlock))) instanceof NoteCryptoError,
  );

  const badJson = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{not json\n```\n";
  check(
    "a malformed envelope throws too",
    (await threw(async () => parseEncryptedNote(badJson))) instanceof NoteCryptoError,
  );

  const noRecipients = editEnvelope(stored, (e) => {
    e.recipients = [];
  });
  check(
    "an envelope with no recipients is malformed, not merely unopenable",
    (await threw(async () => parseEncryptedNote(noRecipients))) instanceof NoteCryptoError,
  );

  check(
    "decrypting a note that is not encrypted is a refusal, not a pass-through",
    (await threw(() => decryptNote(ordinary, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })))
      instanceof NoteCryptoError,
  );

  // -- the pinned vector ---------------------------------------------------

  check(
    "the pinned vector still opens with the pinned key",
    (await value(() =>
      decryptNote(VECTOR.document, {
        workspaceId: VECTOR.workspaceId,
        keys: { [VECTOR.keyId]: VECTOR.workspaceKey },
      }),
    )) === VECTOR.plaintext,
  );
  check(
    "...and the pinned document is byte-for-byte what this build still writes",
    VECTOR.document === renderEncryptedNote(parseEncryptedNote(VECTOR.document)) &&
      isEncryptedNote(VECTOR.document) &&
      encryptedNoteKeyId(VECTOR.document) === VECTOR.keyId,
  );
  check(
    "...and the pinned vector's key opens nothing else",
    (await threw(() =>
      decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k1: VECTOR.workspaceKey } }),
    )) instanceof NoteCryptoError,
  );

  // -- the nonce, and the fact that nobody derives it ---------------------
  //
  // AES-GCM's one catastrophic misuse is a repeated (key, IV) pair, and the two
  // ways to arrive at one are deriving the IV from something stable and reusing
  // a key across encryptions. Neither is asserted by a round trip, and both are
  // silent: the ciphertext still decrypts. So they are asserted directly, over
  // enough encryptions that a derived nonce cannot hide.

  const nonces = new Set();
  const wrapNonces = new Set();
  const wraps = new Set();
  let ivLengthsRight = true;
  for (let i = 0; i < 24; i += 1) {
    const each = await value(async () =>
      parseEncryptedNote(
        await encryptNote(PLAINTEXT, {
          workspaceId: WORKSPACE_A,
          workspaceKey: keyA,
          keyId: "k1",
        }),
      ),
    );
    nonces.add(each.iv);
    wrapNonces.add(each.recipients[0].iv);
    wraps.add(each.recipients[0].wrapped);
    // 12 bytes is 16 unpadded base64url characters.
    ivLengthsRight &&= each.iv.length === 16 && each.recipients[0].iv.length === 16;
  }
  check(
    "every encryption draws a fresh content nonce, never one derived from the note",
    nonces.size === 24,
  );
  check("...and a fresh wrap nonce with it", wrapNonces.size === 24);
  check("...both of them 96 bits, as GCM asks", ivLengthsRight);
  // The wrapped bytes differ on the wrap nonce alone, so this is honestly a
  // check that the wrap is randomised rather than proof that the note key was.
  // A reused note key under a fresh nonce is not observable from the envelope at
  // all, which is why `encryptNote` draws it itself and takes no parameter a
  // caller could pin it with.
  check("...and a wrap that is never the same twice", wraps.size === 24);

  // -- an error is not a place to put key material ------------------------
  //
  // Every refusal in this module is reachable by a client past `canSee`, and it
  // is logged. A message naming the key that failed, the bytes that failed to
  // authenticate, or the plaintext beside them turns a refusal into the leak
  // this feature exists to prevent.

  const failures = [
    await threw(() => decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k1: keyB } })),
    await threw(() => decryptNote(storedB, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })),
    await threw(() =>
      decryptNote(flippedCiphertext, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
    ),
    await threw(() => decryptNote(shortIv, { workspaceId: WORKSPACE_A, keys: { k1: keyA } })),
    await threw(() => decryptNote(stored, { workspaceId: WORKSPACE_A, keys: { k9: keyA } })),
    await threw(() =>
      encryptNote("x", { workspaceId: WORKSPACE_A, workspaceKey: `${keyA}AA`, keyId: "k1" }),
    ),
    await threw(async () => parseEncryptedNote(badJson)),
  ];
  const messages = failures.map((error) => `${error?.name}: ${error?.message}`).join("\n");
  check(
    "no refusal names a key, a ciphertext or a plaintext",
    failures.every((error) => error instanceof NoteCryptoError) &&
      !messages.includes(keyA.slice(0, 12)) &&
      !messages.includes(keyB.slice(0, 12)) &&
      !messages.includes(envelope.ct.slice(0, 24)) &&
      !messages.includes(envelope.recipients[0].wrapped.slice(0, 16)) &&
      !messages.includes("finance") &&
      !messages.includes("1-projects/other"),
  );

  // A file in a bucket may not decide how long a log line is. `v` and `alg` are
  // the two fields whose *value* reaches a message, so both are bounded.
  const shoutingVersion = editEnvelope(stored, (e) => {
    e.v = "9".repeat(4096);
  });
  const shoutingAlg = editEnvelope(stored, (e) => {
    e.alg = "A".repeat(4096);
  });
  const shouts = [
    await threw(async () => parseEncryptedNote(shoutingVersion)),
    await threw(async () => parseEncryptedNote(shoutingAlg)),
  ];
  check(
    "a bucket-controlled field cannot decide the size of the error that names it",
    shouts.every((error) => error instanceof NoteCryptoError && error.message.length < 120),
  );

  // -- the pinned vector, tampered ----------------------------------------

  const flippedVector = VECTOR.document.replace(
    /"ct":"(.)/,
    (_, first) => `"ct":"${first === "A" ? "B" : "A"}`,
  );
  check(
    "a single flipped character in the pinned vector no longer opens it",
    flippedVector !== VECTOR.document &&
      (await threw(() =>
        decryptNote(flippedVector, {
          workspaceId: VECTOR.workspaceId,
          keys: { [VECTOR.keyId]: VECTOR.workspaceKey },
        }),
      )) instanceof NoteCryptoError,
  );

  const tamperedRecipientIv = editEnvelope(stored, (e) => {
    e.recipients[0].iv = e.recipients[0].iv.startsWith("A")
      ? `B${e.recipients[0].iv.slice(1)}`
      : `A${e.recipients[0].iv.slice(1)}`;
  });
  check(
    "a tampered wrap nonce fails to unwrap rather than yielding a key",
    (await threw(() =>
      decryptNote(tamperedRecipientIv, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
    )) instanceof NoteCryptoError,
  );

  // -- a generator does not get to change a note's form -------------------
  //
  // "Whether a write is encrypted is decided by the stored object at that path"
  // is a rule about every writer, and the ones a person never drives are the
  // ones it is easiest to forget: an inbox capture replayed under the same
  // external id, a meeting note, a calendar refresh. Each replaces a note's
  // *content* by design, and none of them is a reason to replace its *form*.

  const generated = "---\nupdated: 2026-09-08\n---\n\n# regenerated\n";
  const seal = (plaintext) =>
    encryptNote(plaintext, { workspaceId: WORKSPACE_A, workspaceKey: keyA, keyId: "k1" });
  const refuse = async () => null;

  check(
    "a generated note at an empty path is stored as it was generated",
    (await value(() => generatedNoteBytes(generated, null, seal))) === generated,
  );
  check(
    "...and so is one over an ordinary note",
    (await value(() => generatedNoteBytes(generated, ordinary, seal))) === generated,
  );

  const regenerated = await value(() => generatedNoteBytes(generated, stored, seal));
  check(
    "a generated note over an ENCRYPTED one is encrypted, not written in the clear",
    typeof regenerated === "string" &&
      isEncryptedNote(regenerated) &&
      !regenerated.includes("regenerated"),
  );
  check(
    "...and it is the new content, so the update was not silently dropped either",
    (await value(() =>
      decryptNote(regenerated, { workspaceId: WORKSPACE_A, keys: { k1: keyA } }),
    )) === generated,
  );
  check(
    "a broken envelope is protected exactly as hard as a good one",
    isEncryptedNote(markerNoBlock) &&
      (await value(() => generatedNoteBytes(generated, markerNoBlock, seal))) !== generated,
  );
  check(
    "and with no key, the answer is 'leave the note alone' rather than plaintext",
    (await value(() => generatedNoteBytes(generated, stored, refuse))) === null,
  );

  // -- keys are keys -------------------------------------------------------

  check(
    "a generated workspace key is 32 bytes of base64",
    /^[A-Za-z0-9+/]{43}=$/.test(generateWorkspaceKey()) &&
      generateWorkspaceKey() !== generateWorkspaceKey(),
  );
}
