/**
 * Credential encryption.
 *
 * These run against the real Web Crypto in the edge runtime, so what is proven
 * here is what ships.
 */

import { describe, expect, test } from "vitest";
import {
  CredentialCryptoError,
  ENCRYPTION_KEY_ENV_VAR,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  hashToken,
  maskAccessKeyId,
  requireEncryptionKey,
} from "../functions/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OTHER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
const SECRET = "example-secret-access-key-not-real-000000";

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a secret", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    expect(await decryptSecret(envelope, KEY)).toBe(SECRET);
  });

  test("the envelope never contains the plaintext", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    expect(envelope).not.toContain(SECRET);
    expect(envelope).not.toContain("example-secret");
  });

  test("is versioned so the algorithm can be rotated later", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    expect(envelope.startsWith("v1:")).toBe(true);
    expect(envelope.split(":")).toHaveLength(3);
  });

  test("round-trips non-ASCII secrets byte-for-byte", async () => {
    const unicode = "ключ-🔐-secret";
    expect(await decryptSecret(await encryptSecret(unicode, KEY), KEY)).toBe(
      unicode,
    );
  });

  /**
   * The IV property. GCM loses confidentiality catastrophically on nonce reuse
   * under one key, so "same plaintext, same key, different ciphertext" is not
   * a nicety — it is the thing standing between us and a broken cipher.
   */
  test("the same plaintext encrypts differently every time", async () => {
    const envelopes = await Promise.all(
      Array.from({ length: 8 }, () => encryptSecret(SECRET, KEY)),
    );
    const ivs = envelopes.map((e) => e.split(":")[1]);
    const ciphertexts = envelopes.map((e) => e.split(":")[2]);

    expect(new Set(ivs).size).toBe(envelopes.length);
    expect(new Set(ciphertexts).size).toBe(envelopes.length);

    // ...and every one of them still decrypts to the same secret.
    for (const envelope of envelopes) {
      expect(await decryptSecret(envelope, KEY)).toBe(SECRET);
    }
  });

  test("a tampered ciphertext fails to decrypt rather than yielding garbage", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    const [version, iv, ciphertext] = envelope.split(":");

    // Flip one base64 character in the ciphertext.
    const flipped = ciphertext.startsWith("A")
      ? `B${ciphertext.slice(1)}`
      : `A${ciphertext.slice(1)}`;

    await expect(
      decryptSecret([version, iv, flipped].join(":"), KEY),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("a tampered IV fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    const [version, iv, ciphertext] = envelope.split(":");
    const flipped = iv.startsWith("A") ? `B${iv.slice(1)}` : `A${iv.slice(1)}`;

    await expect(
      decryptSecret([version, flipped, ciphertext].join(":"), KEY),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("a truncated ciphertext fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    const [version, iv, ciphertext] = envelope.split(":");
    await expect(
      decryptSecret([version, iv, ciphertext.slice(0, -8)].join(":"), KEY),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("the wrong key fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    await expect(decryptSecret(envelope, OTHER_KEY)).rejects.toThrow(
      CredentialCryptoError,
    );
  });

  test("an unknown envelope version is refused rather than guessed at", async () => {
    const envelope = await encryptSecret(SECRET, KEY);
    const [, iv, ciphertext] = envelope.split(":");
    await expect(
      decryptSecret(["v2", iv, ciphertext].join(":"), KEY),
    ).rejects.toThrow(/envelope version/);
  });

  test("a malformed envelope is refused", async () => {
    await expect(decryptSecret("not-an-envelope", KEY)).rejects.toThrow(
      /Malformed credential envelope/,
    );
  });

  test("a key of the wrong length is refused, not silently padded", async () => {
    await expect(encryptSecret(SECRET, "c2hvcnQ=")).rejects.toThrow(
      /must be 32 bytes/,
    );
  });

  test("refuses to encrypt an empty secret", async () => {
    await expect(encryptSecret("", KEY)).rejects.toThrow(/empty secret/);
  });

  test("generated keys are usable and distinct", async () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(a).not.toBe(b);
    expect(await decryptSecret(await encryptSecret(SECRET, a), a)).toBe(SECRET);
  });
});

describe("requireEncryptionKey", () => {
  test("throws rather than falling back to a default", () => {
    expect(() => requireEncryptionKey({})).toThrow(CredentialCryptoError);
    expect(() => requireEncryptionKey({})).toThrow(ENCRYPTION_KEY_ENV_VAR);
  });

  test("returns the configured key", () => {
    expect(requireEncryptionKey({ [ENCRYPTION_KEY_ENV_VAR]: KEY })).toBe(KEY);
  });
});

describe("hashToken", () => {
  test("is stable and 64 hex characters", async () => {
    const hash = await hashToken("refresh-token-example");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken("refresh-token-example")).toBe(hash);
  });

  test("different tokens hash differently", async () => {
    expect(await hashToken("token-a")).not.toBe(await hashToken("token-b"));
  });
});

describe("maskAccessKeyId", () => {
  test("keeps only the last four characters", () => {
    const masked = maskAccessKeyId("EXAMPLEACCESSKEYID00");
    expect(masked.endsWith("ID00")).toBe(true);
    expect(masked).not.toContain("EXAMPLEACCESS");
  });

  test("does not leak short ids either", () => {
    expect(maskAccessKeyId("abcd")).toBe("••••");
  });
});
