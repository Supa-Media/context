/**
 * The optional iOS bridge for locked-note cryptography.
 *
 * This module is present in every OTA bundle, but `ContextNativeCrypto` is null
 * in binaries built before the native code shipped.  That distinction is the
 * compatibility gate: an old binary keeps showing the honest desktop-only
 * refusal instead of crashing while loading an update compiled against a new
 * native capability.
 *
 * The bridge necessarily serializes secrets as immutable JavaScript and Swift
 * base64 strings. Neither runtime lets this code erase those copies; native
 * and JavaScript implementations clear mutable byte buffers in `finally`/
 * `defer`, but this is best-effort lifetime reduction, not guaranteed
 * zeroization of every runtime copy.
 */
import ContextNativeCrypto from "../../../modules/context-native-crypto";

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export function hasNativeNoteCrypto(): boolean {
  return ContextNativeCrypto !== null;
}

export function nativeRandomBytes(length: number): Uint8Array | null {
  if (ContextNativeCrypto === null) return null;
  return decodeBase64(ContextNativeCrypto.randomBytes(length));
}

export async function nativeArgon2id(input: {
  passphrase: string;
  salt: Uint8Array;
  memory: number;
  iterations: number;
  parallelism: number;
  version: number;
}): Promise<Uint8Array> {
  if (ContextNativeCrypto === null) throw new Error("native note cryptography is unavailable");
  return decodeBase64(await ContextNativeCrypto.deriveArgon2id(
    input.passphrase,
    encodeBase64(input.salt),
    input.memory,
    input.iterations,
    input.parallelism,
    input.version,
  ));
}

export async function nativeAesGcmEncrypt(input: {
  key: Uint8Array;
  iv: Uint8Array;
  plaintext: Uint8Array;
  aad: Uint8Array;
}): Promise<Uint8Array> {
  if (ContextNativeCrypto === null) throw new Error("native note cryptography is unavailable");
  return decodeBase64(await ContextNativeCrypto.aesGcmEncrypt(
    encodeBase64(input.key),
    encodeBase64(input.iv),
    encodeBase64(input.plaintext),
    encodeBase64(input.aad),
  ));
}

export async function nativeAesGcmDecrypt(input: {
  key: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  aad: Uint8Array;
}): Promise<Uint8Array> {
  if (ContextNativeCrypto === null) throw new Error("native note cryptography is unavailable");
  return decodeBase64(await ContextNativeCrypto.aesGcmDecrypt(
    encodeBase64(input.key),
    encodeBase64(input.iv),
    encodeBase64(input.ciphertext),
    encodeBase64(input.aad),
  ));
}
