/** Browser/test implementation; a sandbox nonce is a secret, so fail closed. */
export function newSandboxNonce(): string {
  const bytes = new Uint8Array(32);
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new Error("no cryptographic random source for plugin sandbox");
  }
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
