/**
 * Credential encryption.
 *
 * These run against the real Web Crypto in the edge runtime, so what is proven
 * here is what ships.
 */

import { describe, expect, test } from "vitest";
import {
  CredentialCryptoError,
  DEFAULT_KEY_ID,
  ENCRYPTION_KEY_ENV_VAR,
  ENCRYPTION_KEY_ID_ENV_VAR,
  PREVIOUS_ENCRYPTION_KEY_ENV_VAR,
  PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR,
  decryptSecret,
  encryptSecret,
  envelopeKeyId,
  generateEncryptionKey,
  hashToken,
  maskAccessKeyId,
  requireEncryptionKey,
  requireKeyset,
  type Keyset,
} from "../functions/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OTHER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
const SECRET = "example-secret-access-key-not-real-000000";

/**
 * The single-key keyset a deployment that has never rotated has.
 *
 * Every call now takes a keyset and a context, because an envelope that is not
 * bound to a workspace is the cross-tenant bug this module exists to prevent —
 * there is deliberately no signature that lets a caller forget the binding.
 */
const KEYSET: Keyset = { current: { id: DEFAULT_KEY_ID, material: KEY } };
const OTHER_KEYSET: Keyset = { current: { id: DEFAULT_KEY_ID, material: OTHER_KEY } };

/** An obviously fake workspace id. Any stable string works as AAD. */
const WORKSPACE = { workspaceId: "workspace_alice_0000" };
const OTHER_WORKSPACE = { workspaceId: "workspace_bob_0000" };

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a secret", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    expect(await decryptSecret(envelope, KEYSET, WORKSPACE)).toBe(SECRET);
  });

  test("the envelope never contains the plaintext", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    expect(envelope).not.toContain(SECRET);
    expect(envelope).not.toContain("example-secret");
  });

  test("is versioned and carries its key id, so both can be rotated", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    expect(envelope.startsWith(`v2:${DEFAULT_KEY_ID}:`)).toBe(true);
    expect(envelope.split(":")).toHaveLength(4);
    expect(envelopeKeyId(envelope)).toBe(DEFAULT_KEY_ID);
  });

  test("round-trips non-ASCII secrets byte-for-byte", async () => {
    const unicode = "ключ-🔐-secret";
    expect(
      await decryptSecret(
        await encryptSecret(unicode, KEYSET, WORKSPACE),
        KEYSET,
        WORKSPACE,
      ),
    ).toBe(unicode);
  });

  /**
   * The IV property. GCM loses confidentiality catastrophically on nonce reuse
   * under one key, so "same plaintext, same key, different ciphertext" is not
   * a nicety — it is the thing standing between us and a broken cipher.
   */
  test("the same plaintext encrypts differently every time", async () => {
    const envelopes = await Promise.all(
      Array.from({ length: 8 }, () => encryptSecret(SECRET, KEYSET, WORKSPACE)),
    );
    const ivs = envelopes.map((e) => e.split(":")[2]);
    const ciphertexts = envelopes.map((e) => e.split(":")[3]);

    expect(new Set(ivs).size).toBe(envelopes.length);
    expect(new Set(ciphertexts).size).toBe(envelopes.length);

    // ...and every one of them still decrypts to the same secret.
    for (const envelope of envelopes) {
      expect(await decryptSecret(envelope, KEYSET, WORKSPACE)).toBe(SECRET);
    }
  });

  test("a tampered ciphertext fails to decrypt rather than yielding garbage", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    const [version, keyId, iv, ciphertext] = envelope.split(":");

    // Flip one base64 character in the ciphertext.
    const flipped = ciphertext.startsWith("A")
      ? `B${ciphertext.slice(1)}`
      : `A${ciphertext.slice(1)}`;

    await expect(
      decryptSecret([version, keyId, iv, flipped].join(":"), KEYSET, WORKSPACE),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("a tampered IV fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    const [version, keyId, iv, ciphertext] = envelope.split(":");
    const flipped = iv.startsWith("A") ? `B${iv.slice(1)}` : `A${iv.slice(1)}`;

    await expect(
      decryptSecret(
        [version, keyId, flipped, ciphertext].join(":"),
        KEYSET,
        WORKSPACE,
      ),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("a truncated ciphertext fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    const [version, keyId, iv, ciphertext] = envelope.split(":");
    await expect(
      decryptSecret(
        [version, keyId, iv, ciphertext.slice(0, -8)].join(":"),
        KEYSET,
        WORKSPACE,
      ),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("the wrong key fails to decrypt", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    await expect(
      decryptSecret(envelope, OTHER_KEYSET, WORKSPACE),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("an unknown envelope version is refused rather than guessed at", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    const [, keyId, iv, ciphertext] = envelope.split(":");
    await expect(
      decryptSecret(["v3", keyId, iv, ciphertext].join(":"), KEYSET, WORKSPACE),
    ).rejects.toThrow(/envelope version/);
  });

  test("a malformed envelope is refused", async () => {
    await expect(
      decryptSecret("not-an-envelope", KEYSET, WORKSPACE),
    ).rejects.toThrow(/Malformed credential envelope/);
  });

  test("a key of the wrong length is refused, not silently padded", async () => {
    await expect(
      encryptSecret(
        SECRET,
        { current: { id: DEFAULT_KEY_ID, material: "c2hvcnQ=" } },
        WORKSPACE,
      ),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  test("refuses to encrypt an empty secret", async () => {
    await expect(encryptSecret("", KEYSET, WORKSPACE)).rejects.toThrow(
      /empty secret/,
    );
  });

  test("generated keys are usable and distinct", async () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(a).not.toBe(b);
    const keyset: Keyset = { current: { id: DEFAULT_KEY_ID, material: a } };
    expect(
      await decryptSecret(
        await encryptSecret(SECRET, keyset, WORKSPACE),
        keyset,
        WORKSPACE,
      ),
    ).toBe(SECRET);
  });
});

/**
 * The envelope is bound to a workspace.
 *
 * Before this, an envelope was portable: lifting the `encryptedSecretAccessKey`
 * string out of one workspace's binding row and into another's made
 * `getBindingForGateway` hand the second workspace the first one's plaintext
 * credential. No client path writes that field today, which is the only reason
 * it was not exploitable — the credential boundary rested entirely on every
 * future caller passing the right id, and the caller that matters (the
 * gateway) is not written yet.
 */
describe("an envelope is bound to one workspace", () => {
  test("the same envelope refuses to open under a different workspace id", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);

    // Alice's envelope, presented as Bob's.
    await expect(
      decryptSecret(envelope, KEYSET, OTHER_WORKSPACE),
    ).rejects.toThrow(CredentialCryptoError);

    // ...and it still opens for its own workspace, so this is a binding and
    // not simply a broken envelope.
    expect(await decryptSecret(envelope, KEYSET, WORKSPACE)).toBe(SECRET);
  });

  test("the failure is the same opaque one as a tampered ciphertext", async () => {
    const envelope = await encryptSecret(SECRET, KEYSET, WORKSPACE);
    const wrongWorkspace = await decryptSecret(
      envelope,
      KEYSET,
      OTHER_WORKSPACE,
    ).catch((error: Error) => error.message);
    const wrongKey = await decryptSecret(envelope, OTHER_KEYSET, WORKSPACE).catch(
      (error: Error) => error.message,
    );
    // Distinguishing "right key, wrong workspace" from "wrong key" would tell
    // an attacker which half of their guess was correct.
    expect(wrongWorkspace).toBe(wrongKey);
  });

  test("relabelling an envelope's key id does not make it authenticate", async () => {
    const rotated: Keyset = {
      current: { id: "k2", material: OTHER_KEY },
      previous: { id: DEFAULT_KEY_ID, material: KEY },
    };
    const envelope = await encryptSecret(SECRET, rotated, WORKSPACE);
    const [version, , iv, ciphertext] = envelope.split(":");

    // Claim it was written under the previous key. The key id is part of the
    // authenticated data, so the claim itself breaks authentication.
    await expect(
      decryptSecret(
        [version, DEFAULT_KEY_ID, iv, ciphertext].join(":"),
        rotated,
        WORKSPACE,
      ),
    ).rejects.toThrow(CredentialCryptoError);
  });

  test("refuses to bind an envelope to an empty workspace id", async () => {
    await expect(
      encryptSecret(SECRET, KEYSET, { workspaceId: "" }),
    ).rejects.toThrow(/bound to a workspace/);
  });
});

/**
 * Key rotation.
 *
 * `v1` recorded an *algorithm* version and no key id, so `decryptSecret` had
 * exactly one key to try: rotating `STORAGE_SECRET_ENCRYPTION_KEY` made every
 * stored binding permanently undecryptable, and the answer to "the key leaked"
 * was "every customer re-pastes their secret".
 */
describe("reading with a previous key while writing with the current one", () => {
  const OLD: Keyset = { current: { id: "k1", material: KEY } };
  const ROTATED: Keyset = {
    current: { id: "k2", material: OTHER_KEY },
    previous: { id: "k1", material: KEY },
  };

  test("an envelope written before a rotation still opens after it", async () => {
    const before = await encryptSecret(SECRET, OLD, WORKSPACE);
    expect(await decryptSecret(before, ROTATED, WORKSPACE)).toBe(SECRET);
  });

  test("writes go to the current key, so the old one can eventually be retired", async () => {
    const after = await encryptSecret(SECRET, ROTATED, WORKSPACE);
    expect(envelopeKeyId(after)).toBe("k2");

    // A deployment that has finished the rotation and dropped the old key can
    // still read everything it wrote.
    const currentOnly: Keyset = { current: ROTATED.current };
    expect(await decryptSecret(after, currentOnly, WORKSPACE)).toBe(SECRET);
  });

  test("an envelope under a key that is no longer configured is named, not guessed at", async () => {
    const before = await encryptSecret(SECRET, OLD, WORKSPACE);
    const currentOnly: Keyset = { current: ROTATED.current };
    await expect(decryptSecret(before, currentOnly, WORKSPACE)).rejects.toThrow(
      /No configured encryption key with id "k1"/,
    );
  });

  /**
   * v1 envelopes are rejected, not read. Supporting them would mean keeping a
   * decrypt path with no workspace binding, and an attacker who could write
   * the row could downgrade to it.
   */
  test("a v1 envelope is refused with an actionable message rather than opened", async () => {
    await expect(
      decryptSecret("v1:aXZpdml2aXZpdml2aQ==:Y2lwaGVy", KEYSET, WORKSPACE),
    ).rejects.toThrow(/rebind storage/i);
  });
});

describe("requireKeyset", () => {
  test("defaults the key id when a deployment has never rotated", () => {
    const keyset = requireKeyset({ [ENCRYPTION_KEY_ENV_VAR]: KEY });
    expect(keyset.current).toEqual({ id: DEFAULT_KEY_ID, material: KEY });
    expect(keyset.previous).toBeUndefined();
  });

  test("reads both keys mid-rotation", () => {
    const keyset = requireKeyset({
      [ENCRYPTION_KEY_ENV_VAR]: OTHER_KEY,
      [ENCRYPTION_KEY_ID_ENV_VAR]: "k2",
      [PREVIOUS_ENCRYPTION_KEY_ENV_VAR]: KEY,
      [PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR]: "k1",
    });
    expect(keyset.current.id).toBe("k2");
    expect(keyset.previous).toEqual({ id: "k1", material: KEY });
  });

  test("refuses a half-configured rotation rather than guessing", () => {
    // A previous key with no id cannot be matched to any envelope.
    expect(() =>
      requireKeyset({
        [ENCRYPTION_KEY_ENV_VAR]: OTHER_KEY,
        [PREVIOUS_ENCRYPTION_KEY_ENV_VAR]: KEY,
      }),
    ).toThrow(CredentialCryptoError);

    // Two different keys sharing one id would silently make old rows
    // unreadable the moment the current key changed.
    expect(() =>
      requireKeyset({
        [ENCRYPTION_KEY_ENV_VAR]: OTHER_KEY,
        [ENCRYPTION_KEY_ID_ENV_VAR]: "k1",
        [PREVIOUS_ENCRYPTION_KEY_ENV_VAR]: KEY,
        [PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR]: "k1",
      }),
    ).toThrow(/must differ/);
  });

  test("refuses a key id that would corrupt the envelope's own delimiter", () => {
    expect(() =>
      requireKeyset({
        [ENCRYPTION_KEY_ENV_VAR]: KEY,
        [ENCRYPTION_KEY_ID_ENV_VAR]: "k:2",
      }),
    ).toThrow(CredentialCryptoError);
  });

  test("throws rather than falling back when no key is configured at all", () => {
    expect(() => requireKeyset({})).toThrow(ENCRYPTION_KEY_ENV_VAR);
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
