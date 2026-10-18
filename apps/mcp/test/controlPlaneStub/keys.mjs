/**
 * Key material for the stub's encryption rotations (`/gateway/binding`).
 * Real, valid AES-256 base64 is minted for a new generation, never a
 * placeholder, because it feeds the gateway's actual AES-GCM calls.
 */

/** A fresh, real AES-256 key, base64. */
export function mintKeyMaterial() {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `k1` -> `k2`, `k9` -> `k10` — the same scheme the real control plane uses. */
export function nextGeneration(current) {
  const match = /^([A-Za-z_-]*?)(\d+)$/.exec(current);
  if (match === null) return `${current}-2`;
  return `${match[1]}${Number(match[2]) + 1}`;
}
