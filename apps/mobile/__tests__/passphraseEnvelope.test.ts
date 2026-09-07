/**
 * ONE FORMAT, TWO RUNTIMES, ONE CORPUS.
 *
 * `apps/mcp/src/encryption.js` is the normative envelope and the decryptor a
 * customer runs without us. `features/console/encryption/envelope.ts` is the
 * copy the console runs, because a passphrase note is encrypted and decrypted
 * on the device and the device is running this bundle. Two implementations of
 * one format is the shape `privacyEngine.test.ts` polices for `canSee` and
 * `noteEncryptionParity.test.ts` polices for the marker, and this file polices
 * it the same way: run both over one corpus and assert identical bytes.
 *
 * A disagreement here is not a wrong label. It is somebody's note opening in
 * one place and not the other, with no way to tell which one is right.
 *
 * What is asserted, in the order it would bite:
 *
 * 1. **The same envelope renders to the same bytes** in both, including the
 *    frontmatter and the callout, because those bytes are the on-bucket format.
 * 2. **Each opens what the other wrote**, both directions, at the real
 *    parameters through the pinned fixture and at cheap ones through fresh keys.
 * 3. **They refuse the same things**: a version from the future, a tampered
 *    ciphertext, a tampered wrap, a KDF descriptor a bucket could use to make a
 *    device allocate two gigabytes.
 * 4. **A wrong passphrase is indistinguishable from a corrupted envelope** in
 *    the console too — the console is where somebody actually types one, so a
 *    guessing oracle here is the one that would be used.
 * 5. **The plaintext of a locked note reaches nothing but the caller.** Not the
 *    error messages, not the rendered document, not anything a log would take.
 */

import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as gateway from "../../mcp/src/encryption.js";
import {
  NoteCryptoError,
  decryptWithPassphrase,
  encryptForPassphrase,
  isEncryptedNote,
  isPassphraseNote,
  parseEncryptedNote,
  passphraseKdfOf,
  renderEncryptedNote,
  replacingRecipient,
  unwrapNoteKey,
  wrapNoteKey,
} from "../features/console/encryption/envelope";
import type { KdfDescriptor } from "../features/console/encryption/kdf";

const VECTOR = JSON.parse(
  readFileSync(join(__dirname, "../../mcp/test/encryptionPassphraseVector.fixtures.json"), "utf8"),
) as {
  workspaceId: string;
  passphrase: string;
  kdf: KdfDescriptor;
  kek: string;
  plaintext: string;
  document: string;
};

const WORKSPACE = "ws_parity_0000000000000000";

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function kek(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = (seed + i * 31) & 0xff;
  return out;
}

/** A descriptor with a real salt and parameters no test has to wait for. */
const CHEAP_KDF: KdfDescriptor = { id: "argon2id", v: 0x13, m: 64, t: 1, p: 1, salt: "AAAAAAAAAAA" };

const PLAINTEXT = "---\ntags: [parity]\n---\n\nA note two implementations must agree about.\n";

describe("the envelope, in both runtimes", () => {
  it("renders the same bytes from the same envelope", () => {
    const envelope = parseEncryptedNote(VECTOR.document)!;
    expect(renderEncryptedNote(envelope)).toBe(gateway.renderEncryptedNote(envelope));
    expect(renderEncryptedNote(envelope)).toBe(VECTOR.document);
  });

  it("agrees on what is an encrypted note, marker for marker", () => {
    const corpus = [
      VECTOR.document,
      // A byte-order mark in front of the frontmatter: what a Windows editor
      // leaves behind, and what both copies have to parse through.
      `\u{FEFF}${VECTOR.document}`,
      PLAINTEXT,
      "",
      "---\ncontext_encryption: 1\n---\n\nno fence\n",
      "---\ntitle: a note about context_encryption: v1\n---\n\nbody\n",
      "\n---\ncontext_encryption: v1\n---\n",
      "---\ncontext_encryption_key: ws:k1\n---\n\nmarker on the wrong key\n",
    ];
    for (const text of corpus) {
      expect(isEncryptedNote(text)).toBe(gateway.isEncryptedNote(text));
    }
  });

  it("opens the pinned fixture in the console with the key the console derives", async () => {
    const opened = await decryptWithPassphrase(VECTOR.document, {
      workspaceId: VECTOR.workspaceId,
      kek: bytesOf(VECTOR.kek),
    });
    expect(opened).toBe(VECTOR.plaintext);
  });

  it("opens in the gateway module what the console wrote", async () => {
    const document = await encryptForPassphrase(PLAINTEXT, {
      workspaceId: WORKSPACE,
      kek: kek(5),
      kdf: CHEAP_KDF,
    });
    await expect(
      gateway.decryptNoteWithPassphrase(document, { workspaceId: WORKSPACE, kek: kek(5), id: "p1" }),
    ).resolves.toBe(PLAINTEXT);
  });

  it("opens in the console what the gateway module wrote", async () => {
    const document = await gateway.encryptNoteForPassphrase(PLAINTEXT, {
      workspaceId: WORKSPACE,
      kek: kek(6),
      kdf: CHEAP_KDF,
    });
    await expect(
      decryptWithPassphrase(document, { workspaceId: WORKSPACE, kek: kek(6) }),
    ).resolves.toBe(PLAINTEXT);
  });

  it("changes a passphrase in one and reads it in the other, without touching the body", async () => {
    const document = await encryptForPassphrase(PLAINTEXT, {
      workspaceId: WORKSPACE,
      kek: kek(7),
      kdf: CHEAP_KDF,
    });
    const recipient = parseEncryptedNote(document)!.recipients[0];
    const noteKey = await unwrapNoteKey(recipient, kek(7), WORKSPACE);
    const rewrapped = await wrapNoteKey(noteKey, {
      workspaceId: WORKSPACE,
      kek: kek(8),
      kdf: { ...CHEAP_KDF, salt: "BBBBBBBBBBB" },
    });
    const changed = replacingRecipient(document, rewrapped);

    expect(parseEncryptedNote(changed)!.ct).toBe(parseEncryptedNote(document)!.ct);
    await expect(
      gateway.decryptNoteWithPassphrase(changed, { workspaceId: WORKSPACE, kek: kek(8), id: "p1" }),
    ).resolves.toBe(PLAINTEXT);
    await expect(
      decryptWithPassphrase(changed, { workspaceId: WORKSPACE, kek: kek(7) }),
    ).rejects.toBeInstanceOf(NoteCryptoError);
  });
});

describe("what the console refuses", () => {
  it("fails identically on a wrong passphrase and on a corrupted wrap", async () => {
    const document = await encryptForPassphrase(PLAINTEXT, {
      workspaceId: WORKSPACE,
      kek: kek(1),
      kdf: CHEAP_KDF,
    });
    const corrupted = renderEncryptedNote({
      ...parseEncryptedNote(document)!,
      recipients: [
        {
          ...parseEncryptedNote(document)!.recipients[0],
          wrapped: `${parseEncryptedNote(document)!.recipients[0].wrapped.slice(0, -4)}AAAA`,
        },
      ],
    });
    const wrong = await decryptWithPassphrase(document, {
      workspaceId: WORKSPACE,
      kek: kek(2),
    }).catch((error) => error);
    const broken = await decryptWithPassphrase(corrupted, {
      workspaceId: WORKSPACE,
      kek: kek(1),
    }).catch((error) => error);
    expect(wrong).toBeInstanceOf(NoteCryptoError);
    expect(broken).toBeInstanceOf(NoteCryptoError);
    expect(wrong.message).toBe(broken.message);
    // And neither says anything about the note it failed on.
    expect(`${wrong.message}${broken.message}`).not.toContain("parity");
  });

  it("refuses a KDF descriptor a bucket could use to exhaust the device", () => {
    const of = (kdf: Partial<KdfDescriptor>) =>
      renderEncryptedNote({
        ...parseEncryptedNote(VECTOR.document)!,
        recipients: [
          { ...parseEncryptedNote(VECTOR.document)!.recipients[0], kdf: { ...VECTOR.kdf, ...kdf } },
        ],
      });
    for (const bad of [{ m: 4194304 }, { m: 1 }, { t: 100000 }, { v: 0x10 }, { salt: "AA" }]) {
      expect(() => parseEncryptedNote(of(bad))).toThrow(NoteCryptoError);
      // ...and the gateway agrees, which is what stops one of them storing what
      // the other cannot read.
      expect(() => gateway.parseEncryptedNote(of(bad))).toThrow();
    }
  });

  it("refuses an envelope version it does not know rather than guessing", () => {
    const future = renderEncryptedNote({ ...parseEncryptedNote(VECTOR.document)!, v: 2 });
    expect(() => parseEncryptedNote(future)).toThrow(NoteCryptoError);
    expect(() => gateway.parseEncryptedNote(future)).toThrow();
  });

  it("knows a passphrase note from an ordinary one and from a broken one", () => {
    expect(isPassphraseNote(VECTOR.document)).toBe(true);
    expect(isPassphraseNote(PLAINTEXT)).toBe(false);
    // Marked, unparseable: not a passphrase note, so the console shows it as
    // locked and refuses to overwrite it rather than offering to unlock it.
    expect(isPassphraseNote("---\ncontext_encryption: v1\n---\n\nnot an envelope\n")).toBe(false);
    expect(passphraseKdfOf(PLAINTEXT)).toBeNull();
    expect(passphraseKdfOf(VECTOR.document)).toEqual(VECTOR.kdf);
  });

  it("never puts the plaintext into the document it produces", async () => {
    const document = await encryptForPassphrase(
      "a sentence nobody else may read: the number is forty-two",
      { workspaceId: WORKSPACE, kek: kek(3), kdf: CHEAP_KDF },
    );
    expect(document).not.toContain("forty-two");
    expect(document).not.toContain("nobody else may read");
    // Nor the key that opened it, in either alphabet.
    let binary = "";
    for (const byte of kek(3)) binary += String.fromCharCode(byte);
    expect(document).not.toContain(btoa(binary));
  });
});
