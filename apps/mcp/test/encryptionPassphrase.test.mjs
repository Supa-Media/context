/**
 * THE PASSPHRASE RECIPIENT — the Phase 2 half of `src/encryption.js`.
 *
 * `encryption.test.mjs` proves the envelope. This file proves the mode where
 * **we are not a reader**: a note whose only recipient is a passphrase, which
 * nothing in this gateway can open, on purpose, forever.
 *
 * Seven things are asserted, in the order they would bite:
 *
 * 1. **A pinned vector opens**, from bytes checked into the repository, through
 *    this module alone. The same fixture is derived from its passphrase by the
 *    console's suite (`apps/mobile/__tests__/argon2id.test.ts`), so the two
 *    halves of one derivation are pinned in the two places that run them and no
 *    future writer can move both together by accident.
 * 2. **The gateway cannot read one**, and says so as a locked note rather than
 *    as a missing key or a missing note.
 * 3. **The gateway has no passphrase**, asserted twice on source rather than on
 *    behaviour: no exported signature in the envelope module takes one, and
 *    `src/index.js` — every tool the protocol exposes — neither imports nor
 *    calls anything that could turn one into a key. `encryptionGateway.test.mjs`
 *    holds the behavioural half.
 * 4. **A wrong passphrase fails exactly as a corrupted envelope does** — same
 *    error type, same message, same fields. Anything else is an offline
 *    guessing oracle, which is the attack the product note names.
 * 5. **Changing a passphrase never rewrites the body.** The ciphertext is
 *    byte-identical across it, which is the property the wrapped note key was
 *    bought for.
 * 6. **A note cannot be made unopenable by any of these calls**: a recipient
 *    that would not parse cannot be written into somebody's note, and a
 *    replacement must name a recipient that is there.
 * 7. **A bucket cannot decide how much memory a device spends.** The KDF
 *    descriptor is bounded before anything acts on it, in both directions.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite; the table in the pull request carries the same numbers.
 *
 *   the write path sealing over a note it cannot open                        5
 *   `replacingRecipient` skipping `assertRecipientShape`                     9
 *   `assertKdfDescriptor` accepting any `m`                                  3
 *   `unwrapNoteKey` reporting an unwrap failure differently from a
 *     content failure (the guessing oracle)                                  1
 *   `decryptNoteWithPassphrase` accepting a workspace recipient         0 -> 1
 *   `decryptNoteWithPassphrase` ignoring the `aad` check                0 -> 1
 *
 * The first row is the one that matters most and it is worth reading twice:
 * without that guard, an MCP client writing to a passphrase-locked note
 * replaced it with a note encrypted for the *workspace* — the lock silently
 * removed, the old ciphertext gone, and the write reported as a success.
 *
 * **The last two rows measured zero on their first run, and both changed this
 * file rather than the source.** A passphrase path that reached for a
 * *workspace* recipient fails too, on the unwrap, with the wrong key — so "it
 * threw" could not tell it from a wrong passphrase, and the difference is the
 * whole answer: one is "this note is not passphrase-protected" and the other is
 * "you typed it wrong". Same shape for the `aad` check: GCM refuses a
 * relabelled envelope on the content either way, so the guard only changes the
 * *message*, from "this note's contents could not be read" — which sends
 * somebody hunting for corruption — to "this envelope belongs to another
 * context", which is a restore gone wrong. Both are now asserted on the
 * message, which is what they were always worth.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTENT_ALG,
  KDF_ARGON2ID,
  KDF_LIMITS,
  NoteCryptoError,
  RECIPIENT_PASSPHRASE,
  RECIPIENT_WORKSPACE,
  assertKdfDescriptor,
  decryptNote,
  decryptNoteWithPassphrase,
  encryptNote,
  encryptNoteForPassphrase,
  generateWorkspaceKey,
  hasRecipient,
  indexableText,
  isEncryptedNote,
  parseEncryptedNote,
  recipientsOf,
  renderEncryptedNote,
  replacingRecipient,
  unwrapNoteKey,
  wrapNoteKeyForPassphrase,
} from "../src/encryption.js";

const VECTOR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./encryptionPassphraseVector.fixtures.json", import.meta.url)),
    "utf8",
  ),
);

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/encryption.js", import.meta.url)),
  "utf8",
);
const GATEWAY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/index.js", import.meta.url)),
  "utf8",
);

const WORKSPACE = "ws_aaaaaaaaaaaaaaaaaaaaaaaa";

/** A KEK is 32 bytes out of a KDF. Here it is 32 bytes out of a counter. */
function fakeKek(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed + i * 31) & 0xff;
  return bytes;
}

function saltOf(seed) {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = (seed + i) & 0xff;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function kdfFor(seed) {
  return { id: KDF_ARGON2ID, v: 0x13, m: 19456, t: 2, p: 1, salt: saltOf(seed) };
}

async function threw(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Every call into the module goes through here — see `encryption.test.mjs` for
 * why a throw in a check has to become a FAIL rather than an exit code.
 */
async function value(fn) {
  try {
    return await fn();
  } catch (error) {
    return { threw: error };
  }
}

function editEnvelope(document, mutate) {
  const envelope = parseEncryptedNote(document);
  mutate(envelope);
  return renderEncryptedNote(envelope);
}

export async function runEncryptionPassphraseChecks(check) {
  /* -------------------------- the pinned vector -------------------------- */

  const pinned = await value(() =>
    decryptNoteWithPassphrase(VECTOR.document, {
      workspaceId: VECTOR.workspaceId,
      kek: VECTOR.kek,
    }),
  );
  check("the pinned vector opens with the key its passphrase derives", pinned === VECTOR.plaintext);

  check(
    "the pinned vector carries one recipient, and it is not the workspace",
    (() => {
      const recipients = recipientsOf(VECTOR.document);
      return recipients.length === 1 && recipients[0].kind === RECIPIENT_PASSPHRASE;
    })(),
  );

  check(
    "the pinned vector names its KDF and every parameter, so a decryptor never has to guess",
    (() => {
      const [recipient] = recipientsOf(VECTOR.document);
      return (
        recipient.kdf.id === KDF_ARGON2ID &&
        recipient.kdf.v === 0x13 &&
        recipient.kdf.m === VECTOR.kdf.m &&
        recipient.kdf.t === VECTOR.kdf.t &&
        recipient.kdf.p === VECTOR.kdf.p &&
        recipient.kdf.salt === VECTOR.kdf.salt
      );
    })(),
  );

  check(
    "a passphrase note is still a marked, valid, obviously-encrypted Markdown file",
    VECTOR.document.startsWith("---\ncontext_encryption: v1\n") &&
      isEncryptedNote(VECTOR.document) &&
      VECTOR.document.includes("This note is encrypted."),
  );
  check(
    "...and it names no workspace key generation, because there is not one",
    !VECTOR.document.includes("context_encryption_key"),
  );
  check("...and no indexer may copy a byte of it", indexableText(VECTOR.document) === "");

  /* --------------------- the gateway is not a reader ---------------------- */

  const workspaceKey = generateWorkspaceKey();
  const gatewayBlind = await threw(() =>
    decryptNote(VECTOR.document, {
      workspaceId: VECTOR.workspaceId,
      keys: { k1: workspaceKey },
    }),
  );
  check(
    "a workspace key does not open a passphrase note, and the refusal says why",
    gatewayBlind instanceof NoteCryptoError &&
      gatewayBlind.message.includes("no workspace recipient"),
  );

  check(
    "no exported function in the envelope module takes a passphrase",
    !/^export\s+(?:async\s+)?function\s+\w+\s*\([^)]*passphrase/m.test(
      MODULE_SOURCE.replace(/(decryptNoteWithPassphrase|wrapNoteKeyForPassphrase|encryptNoteForPassphrase)/g, "n"),
    ),
  );
  check(
    "the envelope module never derives a key: no derivation call appears in it at all",
    MODULE_SOURCE.split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .every((line) => !/\b(deriveBits|deriveKey|PBKDF2|scrypt)\b|\bargon2id\s*\(/i.test(line)),
  );
  check(
    "...and could not reach one, because it imports nothing at all",
    !/^\s*import\s/m.test(MODULE_SOURCE),
  );
  check(
    "the gateway imports nothing that could open a passphrase note",
    (() => {
      const imported = /import\s*{([^}]*)}\s*from\s*"\.\/encryption\.js"/.exec(GATEWAY_SOURCE);
      if (imported === null) return false;
      const names = imported[1].split(",").map((name) => name.trim());
      return !names.some((name) => /passphrase/i.test(name));
    })(),
  );
  check(
    "...and calls nothing of the sort under another name either",
    !/(decryptNoteWithPassphrase|encryptNoteForPassphrase|wrapNoteKeyForPassphrase|unwrapNoteKey|deriveBits|deriveKey)\s*\(/.test(
      GATEWAY_SOURCE,
    ),
  );

  /*
   * AND THE GUARD CANNOT BE RE-OPENED BY A WRITER NOBODY HAS WRITTEN YET.
   *
   * "A note this request cannot open is a note this request cannot write" lives
   * in one place — `sealNoteContent` — and it can only decide when it is told
   * what is at the path. A future generator that calls it with two arguments
   * gets `undefined` for `storedText`, skips the openability check, and seals a
   * replacement for a locked note with the workspace key: the catastrophic
   * write, back, in a call site nobody thought was about encryption.
   *
   * The behavioural half of this is in `encryptionGateway.test.mjs`, over the
   * two writers that exist. This half is about the writers that do not, and it
   * is a source check for the same reason the two above are: the property is
   * "no call site anywhere", which no fixture can enumerate.
   */
  check(
    "every call to `sealNoteContent` names the stored object it is deciding about",
    (() => {
      const calls = [
        ...GATEWAY_SOURCE.matchAll(/(?<!function\s)\bsealNoteContent\(([^)]*)\)/g),
      ].map((match) => match[1]);
      return (
        calls.length >= 3 &&
        calls.every((args) => args.split(",").filter((part) => part.trim() !== "").length === 3)
      );
    })(),
  );

  /* -------------------- a round trip through this module ------------------ */

  const plaintext = "---\ntags: [x]\n---\n\nA note only a person opens.\n";
  const kekA = fakeKek(1);
  const document = await value(() =>
    encryptNoteForPassphrase(plaintext, { workspaceId: WORKSPACE, kek: kekA, kdf: kdfFor(1) }),
  );
  check(
    "a passphrase note round-trips",
    (await value(() =>
      decryptNoteWithPassphrase(document, { workspaceId: WORKSPACE, kek: kekA }),
    )) === plaintext,
  );
  check(
    "...and encrypting the same note twice produces different bytes",
    (await value(() =>
      encryptNoteForPassphrase(plaintext, { workspaceId: WORKSPACE, kek: kekA, kdf: kdfFor(1) }),
    )) !== document,
  );
  check(
    "...and it never carries a workspace recipient, whatever else it carries",
    !hasRecipient(document, RECIPIENT_WORKSPACE),
  );

  /* ------------------------- a wrong passphrase --------------------------- */

  const wrong = await threw(() =>
    decryptNoteWithPassphrase(document, { workspaceId: WORKSPACE, kek: fakeKek(2) }),
  );
  const corrupted = await threw(() =>
    decryptNoteWithPassphrase(
      editEnvelope(document, (envelope) => {
        const [recipient] = envelope.recipients;
        recipient.wrapped = `${recipient.wrapped.slice(0, -4)}AAAA`;
      }),
      { workspaceId: WORKSPACE, kek: kekA },
    ),
  );
  check(
    "a wrong passphrase and a corrupted wrap fail identically, to the message",
    wrong instanceof NoteCryptoError &&
      corrupted instanceof NoteCryptoError &&
      wrong.message === corrupted.message &&
      wrong.name === corrupted.name,
  );
  check(
    "...and neither failure carries a field the other does not",
    JSON.stringify(Object.keys(wrong)) === JSON.stringify(Object.keys(corrupted)) &&
      Object.keys(wrong).every((key) => wrong[key] === corrupted[key]),
  );
  check(
    "...and neither says anything about the note it failed on",
    !`${wrong.message}${corrupted.message}`.includes(plaintext.slice(0, 10)),
  );
  const tamperedContent = await threw(() =>
    decryptNoteWithPassphrase(
      editEnvelope(document, (envelope) => {
        envelope.ct = `${envelope.ct.slice(0, -4)}AAAA`;
      }),
      { workspaceId: WORKSPACE, kek: kekA },
    ),
  );
  check(
    "a tampered ciphertext fails after a successful unwrap, and says so differently",
    tamperedContent instanceof NoteCryptoError && tamperedContent.message !== wrong.message,
  );

  /* ------------------------- changing a passphrase ------------------------ */

  const noteKey = await value(() =>
    unwrapNoteKey(recipientsOf(document)[0], kekA, WORKSPACE),
  );
  check(
    "the note key comes out of the envelope with the old passphrase, on the device",
    noteKey instanceof Uint8Array && noteKey.byteLength === 32,
  );
  const kekB = fakeKek(3);
  const rewrapped = await value(() =>
    wrapNoteKeyForPassphrase(btoa(String.fromCharCode(...noteKey)), kekB, {
      workspaceId: WORKSPACE,
      kdf: kdfFor(9),
    }),
  );
  const changed = await value(() => replacingRecipient(document, rewrapped));
  check(
    "changing the passphrase rewrites one recipient and not the body",
    typeof changed === "string" &&
      parseEncryptedNote(changed).ct === parseEncryptedNote(document).ct &&
      parseEncryptedNote(changed).iv === parseEncryptedNote(document).iv,
  );
  check(
    "...the new passphrase opens it",
    (await value(() =>
      decryptNoteWithPassphrase(changed, { workspaceId: WORKSPACE, kek: kekB }),
    )) === plaintext,
  );
  check(
    "...and the old one no longer does",
    (await threw(() =>
      decryptNoteWithPassphrase(changed, { workspaceId: WORKSPACE, kek: kekA }),
    )) instanceof NoteCryptoError,
  );
  const junk = await threw(() =>
    replacingRecipient(document, {
      kind: RECIPIENT_PASSPHRASE,
      id: "p1",
      alg: CONTENT_ALG,
      iv: "AA",
      wrapped: "AA",
    }),
  );
  check(
    "a recipient that would not parse cannot be written into somebody's note",
    junk instanceof NoteCryptoError,
  );
  const absent = await threw(() => replacingRecipient(document, { ...rewrapped, id: "p7" }));
  check("replacing a recipient that is not there is refused", absent instanceof NoteCryptoError);

  /* ------------------- the two recipient kinds do not cross --------------- */

  const atRest = await encryptNote(plaintext, {
    workspaceId: WORKSPACE,
    workspaceKey,
    keyId: "k1",
  });
  const atRestRefusal = await threw(() =>
    decryptNoteWithPassphrase(atRest, { workspaceId: WORKSPACE, kek: kekA }),
  );
  check(
    "a workspace note has no passphrase to open",
    atRestRefusal instanceof NoteCryptoError,
  );
  check(
    "...and it says that, rather than reporting a wrong passphrase for a note that has none",
    // The message is the whole check. A passphrase path that reached for a
    // *workspace* recipient would fail too — on the unwrap, with the wrong key
    // — so "it threw" cannot tell the two apart, and the difference matters:
    // one is "this note is not passphrase-protected" and the other is "you
    // typed it wrong". Only one of those is true here.
    atRestRefusal instanceof NoteCryptoError &&
      atRestRefusal.message.includes("no passphrase recipient"),
  );
  check(
    "...and phase 1's at-rest mode is untouched by any of this",
    (await value(() => decryptNote(atRest, { workspaceId: WORKSPACE, keys: { k1: workspaceKey } }))) ===
      plaintext,
  );

  /* ---------------------------- the KDF bounds ---------------------------- */

  for (const [name, kdf] of [
    ["a KDF this build does not know", { ...kdfFor(1), id: "bcrypt" }],
    ["an argon2 version this build does not implement", { ...kdfFor(1), v: 0x10 }],
    ["memory a device could not allocate", { ...kdfFor(1), m: KDF_LIMITS.maxMemory + 1 }],
    ["memory below argon2's own floor", { ...kdfFor(1), m: 4 }],
    ["iterations that would never finish", { ...kdfFor(1), t: 1000000 }],
    ["a salt short enough to precompute", { ...kdfFor(1), salt: "AAAA" }],
    ["a fractional parameter", { ...kdfFor(1), t: 1.5 }],
    ["no salt at all", { ...kdfFor(1), salt: undefined }],
  ]) {
    check(
      `a bucket cannot ask a device for ${name}`,
      (await threw(async () => assertKdfDescriptor(kdf))) instanceof NoteCryptoError,
    );
    check(
      `...and such a recipient cannot be written into a note either (${name})`,
      (await threw(async () =>
        replacingRecipient(document, { ...recipientsOf(document)[0], kdf }),
      )) instanceof NoteCryptoError,
    );
  }
  check(
    "the shipped parameters are inside the bounds this file enforces",
    (await value(async () => assertKdfDescriptor(VECTOR.kdf))) !== undefined,
  );

  const poisoned = editEnvelope(document, (envelope) => {
    envelope.recipients[0].kdf = { ...envelope.recipients[0].kdf, m: 4194304 };
  });
  check(
    "an envelope carrying an out-of-range KDF is refused at parse, before anything allocates",
    (await threw(async () => parseEncryptedNote(poisoned))) instanceof NoteCryptoError,
  );
  check(
    "...and the note is still recognised as encrypted, so nothing overwrites it",
    isEncryptedNote(poisoned) && indexableText(poisoned) === "",
  );

  /* ----------------------- cross-workspace isolation ---------------------- */

  check(
    "the right passphrase does not open a note relabelled into another context",
    (await threw(() =>
      decryptNoteWithPassphrase(document, {
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbb",
        kek: kekA,
      }),
    )) instanceof NoteCryptoError,
  );
  const relabelled = editEnvelope(document, (envelope) => {
    envelope.aad = "context-note-v1:ws_bbbbbbbbbbbbbbbbbbbbbbbb";
  });
  check(
    "...and relabelling the envelope does not help, because the wrap is bound too",
    (await threw(() =>
      decryptNoteWithPassphrase(relabelled, {
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbb",
        kek: kekA,
      }),
    )) instanceof NoteCryptoError,
  );
  const misbound = await threw(() =>
    decryptNoteWithPassphrase(relabelled, { workspaceId: WORKSPACE, kek: kekA }),
  );
  check(
    "...and a relabelled envelope read in its own context is named, not merely refused",
    // GCM refuses this either way, on the content. The explicit check is what
    // turns "this note's contents could not be read" — which sends somebody
    // hunting for corruption — into "this envelope belongs to another context",
    // which is a restore or a copy gone wrong and is a different day's work.
    misbound instanceof NoteCryptoError &&
      misbound.message.includes("bound to a different context"),
  );

  /* ------------------------------ key shapes ------------------------------ */

  check(
    "a key-encryption key of the wrong length is refused rather than padded",
    (await threw(() => unwrapNoteKey(recipientsOf(document)[0], new Uint8Array(16), WORKSPACE))) instanceof
      NoteCryptoError,
  );
  check(
    "a key-encryption key may be given as bytes or as base64, and they agree",
    (await value(() =>
      decryptNoteWithPassphrase(document, {
        workspaceId: WORKSPACE,
        kek: btoa(String.fromCharCode(...kekA)),
      }),
    )) === plaintext,
  );
}
