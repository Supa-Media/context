/** Browser/test implementation; fail closed when secure randomness is absent. */
export function newActivityControlToken(): string {
  const bytes = new Uint8Array(32);
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new Error("no cryptographic random source for activity control");
  }
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
