/**
 * SHA-256 of a picture's bytes — web and desktop, where Web Crypto is there.
 * The phone's half is `pictureHash.native.ts`: Hermes has no Web Crypto.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return hex(digest);
}

export function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
