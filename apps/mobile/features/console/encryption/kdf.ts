/**
 * Turning a passphrase into a key, and refusing to pretend where it cannot.
 *
 * The whole of `docs/decisions/encryption.md`, "The KDF, per client", is what
 * this file implements. Three sentences of it are load-bearing:
 *
 *  - **Argon2id, at OWASP's floor parameters** — 19 MiB, two passes, one lane —
 *    computed in plain JavaScript on computers and by the pinned reference C
 *    implementation in an iOS binary that contains the native module.
 *  - **On a runtime that cannot do it, unlocking is refused by name.** Never a
 *    weaker KDF chosen quietly on the person's behalf: a passphrase note that
 *    silently became a PBKDF2 note on a phone would be weaker than the note the
 *    person was shown, and they would have no way to find out.
 *  - **The parameters are written into the note**, so raising them later opens
 *    every old note exactly as it opens the new ones, and switching to a faster
 *    implementation of the same KDF is not a format change.
 *
 * ## What "cannot do it" means, concretely
 *
 * Two capabilities. A browser provides both through JavaScript and Web Crypto;
 * a new iOS binary provides both through the optional native module. Android
 * and old iOS binaries still lack them and fail closed:
 *
 *  - `crypto.subtle` — AES-GCM, to unwrap the note key and open the body.
 *    Hermes has no Web Crypto at all; `expo-crypto` offers digests and random
 *    bytes and no cipher.
 *  - Enough speed to run a memory-hard KDF. Measured, in
 *    `apps/mobile/scripts/bench-argon2id.ts`: about 1.1 s with a JIT and about
 *    12.7 s without one, for the parameters below, on a desktop-class machine.
 *    A phone is slower than the second number, not the first.
 *
 * So `kdfSupport()` answers one of three things and the console renders each
 * differently. It is a function rather than a constant because the same bundle
 * runs in a browser, in the desktop shell and on a phone, and the answer is
 * different in each.
 */

import { argon2id } from "./argon2id.ts";
import { hasNativeNoteCrypto, nativeArgon2id, nativeRandomBytes } from "./nativeCrypto";

/** What a v1 passphrase recipient names as its KDF. */
export const KDF_ARGON2ID = "argon2id";

/** Argon2's own version byte. A different one is a different KDF. */
export const ARGON2_VERSION = 0x13;

/**
 * What this console writes into a new passphrase recipient.
 *
 * OWASP's minimum for Argon2id (19 MiB, t=2, p=1). Not RFC 9106's 64 MiB /
 * t=3 option, and the reason is measured rather than assumed: in plain
 * JavaScript that costs about six seconds per unlock, and an unlock somebody
 * waits six seconds for is an unlock they turn off. The cost of the smaller
 * parameters is stated in the decision file — an attacker's work per guess is
 * lower by the same factor — and the answer to it is passphrase length, which
 * the acknowledgement screen asks for.
 *
 * `p: 1` because this implementation is single-threaded: lanes it cannot run in
 * parallel buy nothing and cost the same.
 */
export const DEFAULT_KDF_PARAMS = Object.freeze({
  id: KDF_ARGON2ID,
  v: ARGON2_VERSION,
  /** KiB. */
  m: 19456,
  t: 2,
  p: 1,
});

/** Bytes of salt in a recipient this console writes. 128 bits. */
export const SALT_BYTES = 16;

/** Bytes of key it derives. AES-256. */
export const KEY_BYTES = 32;

export type KdfSupport =
  /** Everything is here: a passphrase note can be created, opened and changed. */
  | { supported: true }
  /**
   * Not here, and the reason is one somebody can act on — open it on a computer.
   * `reason` is copy, not a code: it is shown, and it is the only thing standing
   * between an honest refusal and a person concluding their note is lost.
   */
  | { supported: false; reason: string };

/**
 * Can this runtime open a passphrase note?
 *
 * @param runtime injected for tests — the real answer comes from the globals.
 */
export function kdfSupport(
  runtime: { subtle?: unknown; hermes?: boolean; nativeCrypto?: boolean } = {
    subtle: (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle,
    // Hermes announces itself. A runtime that both has Web Crypto and is Hermes
    // does not exist today; if one ever does, the capability wins and this is
    // just a slow path.
    hermes: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== "undefined",
    nativeCrypto: hasNativeNoteCrypto(),
  },
): KdfSupport {
  if (runtime.nativeCrypto) return { supported: true };
  if (!runtime.subtle) {
    return {
      supported: false,
      reason:
        "This app build can't open locked notes. Update Context or open the note in the " +
        "browser or desktop app.",
    };
  }
  if (runtime.hermes) {
    return {
      supported: false,
      reason:
        "Unlocking a note on a phone would take minutes here, so it is not offered rather " +
        "than offered with a weaker password lock you were not told about. Open it in the " +
        "browser or the desktop app.",
    };
  }
  return { supported: true };
}

/** The KDF descriptor a decryptor needs, as it is stored in the recipient. */
export interface KdfDescriptor {
  id: string;
  v: number;
  m: number;
  t: number;
  p: number;
  /** base64url. */
  salt: string;
}

/** A fresh descriptor at this build's parameters, with a random salt. */
export function newKdfDescriptor(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): KdfDescriptor {
  return { ...DEFAULT_KDF_PARAMS, salt: toBase64Url(randomBytes(SALT_BYTES)) };
}

/**
 * The key-encryption key a passphrase derives, under one descriptor.
 *
 * Async because the iOS implementation crosses a native bridge. The computer
 * fallback remains the same byte-compatible, dependency-free JavaScript KDF.
 *
 * **The passphrase is not retained here and is not returned in anything.** What
 * comes back is 32 bytes that the caller holds in memory for as long as the
 * session is unlocked and drops when it locks.
 */
export async function derivePassphraseKey(passphrase: string, kdf: KdfDescriptor): Promise<Uint8Array> {
  if (kdf.id !== KDF_ARGON2ID) {
    // Never guessed at, never substituted. A note naming a KDF this build does
    // not implement is a note this build cannot open, and saying so is the only
    // honest answer — the alternative is deriving the wrong key and reporting a
    // wrong passphrase.
    throw new Error(`this note names a key derivation this app does not implement: ${kdf.id}`);
  }
  if (kdf.v !== ARGON2_VERSION) {
    throw new Error("this note names an argon2 version this app does not implement");
  }
  const support = kdfSupport();
  if (!support.supported) throw new Error(support.reason);
  if (hasNativeNoteCrypto()) {
    return await nativeArgon2id({
      passphrase: passphrase.normalize("NFC"),
      salt: fromBase64Url(kdf.salt),
      memory: kdf.m,
      iterations: kdf.t,
      parallelism: kdf.p,
      version: kdf.v,
    });
  }
  return argon2id({
    password: new TextEncoder().encode(passphrase.normalize("NFC")),
    salt: fromBase64Url(kdf.salt),
    memory: kdf.m,
    iterations: kdf.t,
    parallelism: kdf.p,
    tagLength: KEY_BYTES,
  });
}

/*
 * NFC, and why a normalisation form is a compatibility decision rather than a
 * detail: a passphrase typed with an accent can arrive as one code point or as
 * two, depending on the keyboard and the platform, and the two are different
 * bytes and therefore different keys. Somebody would set a passphrase on a Mac
 * and be told it was wrong on Windows. Every implementation of this format has
 * to agree, so it is written down here and in the decision file, and the
 * offline decryptor's spec says NFC too.
 */

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) {
    const native = nativeRandomBytes(length);
    if (native !== null) return native;
    throw new Error("this runtime has no cryptographic random source");
  }
  source.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
