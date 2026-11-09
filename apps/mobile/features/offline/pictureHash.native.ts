import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { hex } from "./pictureHash";

/**
 * SHA-256 of a picture's bytes, on a phone. Hermes has no Web Crypto, and
 * `expo-crypto` (in `native-deps.json` `core`) digests bytes natively.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return hex(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes)));
}
