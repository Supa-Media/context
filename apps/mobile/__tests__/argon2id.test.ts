/**
 * THE KDF — `features/console/encryption/argon2id.ts` and the BLAKE2b under it.
 *
 * A key derivation function that is "probably right" is a key derivation
 * function that silently produces the wrong key for somebody's notes, once,
 * years later, on a platform nobody tested. So this file is vectors first:
 *
 *  - **BLAKE2b** against RFC 7693's own test vector.
 *  - **Argon2id** against RFC 9106's own test vector — including its `secret`
 *    and `associatedData` inputs, which this product never uses. A KDF that
 *    agrees with the reference on four inputs and not on six has a bug in one
 *    of the six, and only the vector can tell you which.
 *  - **The shipped parameters**, against the pinned envelope in
 *    `apps/mcp/test/encryptionPassphraseVector.fixtures.json`: the passphrase
 *    in that fixture derives the key in that fixture, which opens the note in
 *    that fixture. The gateway's suite pins the second half of that sentence;
 *    this file pins the first. Neither can be moved without the other failing.
 *
 * ## What it does not assert
 *
 * A time. `bench-argon2id.ts` measures, `docs/decisions/encryption.md` records
 * the numbers, and no assertion in this suite depends on how fast shared CI
 * hardware happens to be that morning.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failing tests in this
 * file plus `passphraseEnvelope.test.ts`.
 *
 *   the `fma` doubling dropped (`2*x*y` becoming `x*y`)                      2
 *   the column pass of the compression permuting rows twice instead          2
 *   `hashPrime` keeping 64 bytes per chain step rather than 32               2
 *   Argon2id's data-independent first half made data-dependent               2
 *   a KDF this build does not implement substituted rather than refused      1
 *   the passphrase normalised to NFD instead of NFC                     0 -> 1
 *
 * The first four are the reason a vector is not optional: every one of them
 * produces a perfectly plausible 32 bytes, on every input, forever, and none
 * of them is visible to anything but a vector. Two each rather than more,
 * because two vectors is exactly what owns them — the RFC's and the pinned
 * fixture's.
 *
 * **The normalisation row measured zero on its first run and changed this
 * file.** Asserting that the composed and decomposed forms derive the same key
 * proves only that *some* normalisation happens: both agree under NFD as
 * happily as under NFC. The form itself is what a second implementation has to
 * reproduce, so it is now pinned against bytes normalised explicitly.
 */

import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blake2b } from "../features/console/encryption/blake2b";
import { argon2id } from "../features/console/encryption/argon2id";
import {
  derivePassphraseKey,
  fromBase64Url,
  kdfSupport,
} from "../features/console/encryption/kdf";

const VECTOR = JSON.parse(
  readFileSync(
    join(__dirname, "../../mcp/test/encryptionPassphraseVector.fixtures.json"),
    "utf8",
  ),
) as {
  passphrase: string;
  kdf: { id: string; v: number; m: number; t: number; p: number; salt: string };
  kek: string;
};

const hex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const filled = (length: number, value: number) => new Uint8Array(length).fill(value);

describe("blake2b", () => {
  it("reproduces RFC 7693's vector for the empty input", () => {
    expect(hex(blake2b(64, new Uint8Array(0)))).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419" +
        "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
  });

  it("reproduces RFC 7693's vector for \"abc\"", () => {
    expect(hex(blake2b(64, new TextEncoder().encode("abc")))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("hashes an input longer than one block", () => {
    // 256 bytes crosses the 128-byte block boundary twice, which is where an
    // off-by-one in the counter or the buffer would show up and nowhere else.
    expect(hex(blake2b(32, filled(256, 0xab)))).toHaveLength(64);
    expect(hex(blake2b(32, filled(256, 0xab)))).not.toBe(hex(blake2b(32, filled(256, 0xac))));
  });
});

describe("argon2id", () => {
  it("reproduces RFC 9106's own test vector, secret and associated data included", () => {
    const tag = argon2id({
      password: filled(32, 1),
      salt: filled(16, 2),
      secret: filled(8, 3),
      associatedData: filled(12, 4),
      memory: 32,
      iterations: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(hex(tag)).toBe("0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  });

  it("depends on every parameter it is given", () => {
    const base = {
      password: new TextEncoder().encode("a passphrase"),
      salt: filled(16, 9),
      memory: 64,
      iterations: 2,
      parallelism: 1,
      tagLength: 32,
    };
    const of = (over: Partial<typeof base>) => hex(argon2id({ ...base, ...over }));
    const reference = of({});
    expect(of({ salt: filled(16, 10) })).not.toBe(reference);
    expect(of({ iterations: 3 })).not.toBe(reference);
    expect(of({ memory: 128 })).not.toBe(reference);
    expect(of({ parallelism: 2 })).not.toBe(reference);
    expect(of({ password: new TextEncoder().encode("a passphrase ") })).not.toBe(reference);
    // The same inputs twice are the same bytes twice, or nothing round-trips.
    expect(of({})).toBe(reference);
  });

  it("refuses parameters argon2 itself refuses", () => {
    const base = { password: filled(8, 1), salt: filled(16, 2), tagLength: 32 };
    expect(() => argon2id({ ...base, memory: 4, iterations: 1, parallelism: 1 })).toThrow();
    expect(() => argon2id({ ...base, memory: 64, iterations: 0, parallelism: 1 })).toThrow();
    expect(() =>
      argon2id({ ...base, salt: filled(4, 2), memory: 64, iterations: 1, parallelism: 1 }),
    ).toThrow();
  });
});

describe("the shipped derivation", () => {
  it("derives the pinned fixture's key from the pinned fixture's passphrase", async () => {
    // The other half of this sentence is asserted in the gateway's suite: that
    // key opens that note. Together they pin a passphrase to a plaintext
    // through bytes checked into the repository, in the two runtimes that have
    // to agree about them.
    const key = await derivePassphraseKey(VECTOR.passphrase, VECTOR.kdf);
    let binary = "";
    for (const byte of key) binary += String.fromCharCode(byte);
    expect(btoa(binary)).toBe(VECTOR.kek);
  });

  it("refuses a KDF it does not implement rather than substituting one", async () => {
    await expect(derivePassphraseKey("a passphrase", { ...VECTOR.kdf, id: "pbkdf2" })).rejects.toThrow(/does not implement/);
    await expect(derivePassphraseKey("a passphrase", { ...VECTOR.kdf, v: 0x10 })).rejects.toThrow(/argon2 version/);
  });

  it("normalises the passphrase, so one typed on two keyboards is one key", async () => {
    // "\u00e9" as one code point and as "e" plus a combining accent are different
    // bytes and would otherwise be different keys \u2014 somebody setting a
    // passphrase on one platform and being told it is wrong on another. Cheap
    // parameters on purpose: normalisation is a property of the input, and
    // paying two real derivations to assert it would add sixteen seconds to
    // this suite for nothing.
    const composed: string = "caf\u00e9 passphrase";
    const decomposed: string = "cafe\u0301 passphrase";
    // The two literals really are different bytes; a reader who assumed a typo
    // would otherwise be reading a test that asserts nothing.
    expect(composed.length).not.toBe(decomposed.length);
    const cheap = { ...VECTOR.kdf, m: 64, t: 1 };
    expect(hex(await derivePassphraseKey(composed, cheap))).toBe(
      hex(await derivePassphraseKey(decomposed, cheap)),
    );

    // And it is NFC specifically, not merely "some normalisation". Both forms
    // agree under either rule, so agreement alone cannot pin the one a second
    // implementation has to reproduce — and picking the other one silently
    // changes the key for every passphrase with an accent in it.
    const composedBytes = argon2id({
      password: new TextEncoder().encode(composed.normalize("NFC")),
      salt: fromBase64Url(cheap.salt),
      memory: cheap.m,
      iterations: cheap.t,
      parallelism: cheap.p,
      tagLength: 32,
    });
    expect(hex(await derivePassphraseKey(decomposed, cheap))).toBe(hex(composedBytes));
  });
});

describe("what this runtime can do", () => {
  it("says yes where there is Web Crypto", () => {
    expect(kdfSupport({ subtle: {}, hermes: false })).toEqual({ supported: true });
  });

  it("says yes on Hermes only when the native binary carries the complete crypto module", () => {
    expect(kdfSupport({ subtle: undefined, hermes: true, nativeCrypto: true })).toEqual({
      supported: true,
    });
  });

  it("refuses by name where there is no Web Crypto, rather than substituting a weaker lock", () => {
    const answer = kdfSupport({ subtle: undefined, hermes: true });
    expect(answer.supported).toBe(false);
    expect(answer.supported === false && answer.reason).toMatch(/Update Context|desktop app/);
  });

  it("refuses on Hermes even if a cipher appears, because the derivation would take minutes", () => {
    const answer = kdfSupport({ subtle: {}, hermes: true });
    expect(answer.supported).toBe(false);
    expect(answer.supported === false && answer.reason).toMatch(/minutes/);
  });
});
