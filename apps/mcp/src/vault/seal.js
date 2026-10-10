/**
 * THE VAULT'S SEAL: how one login is kept in a person's own bucket.
 *
 * Decided by the owner, 2026-10-06 and 2026-10-10
 * (`docs/decisions/texting-assistant/vault.md`). An entry lives at
 * `.context/vault/<id>.json` in the workspace's bucket, in two sealed parts:
 *
 * - `meta`: the name, the sites it fills on, and who may use it. Opened to
 *   list entries and to check a fill.
 * - `secret`: the username and password. Opened only by `openForFill`, and by
 *   nothing that answers a model.
 *
 * The key is the workspace data key (`workspaceDataKeys`, held sealed by the
 * control plane, never in the bucket), expanded with its own label, so the
 * bucket alone never yields a login. Each part's associated data binds the
 * workspace, the entry id, the part and the generation: a secret part copied
 * onto another entry, or a meta part copied into a secret's place, does not
 * open.
 *
 * Shared with the control plane, which seals on the signed-in save and share
 * pages (`apps/convex/functions/vault.ts`); the gateway only opens.
 */

import { decodeBase64, encodeBase64 } from "../crypto/bytes.js";

const LABEL = "context-vault-v1";
const PREFIX = "cv1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class VaultSealError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultSealError";
  }
}

/** HKDF-Expand for one block, spelled with HMAC as `managedEncryption.js` does. */
async function vaultKey(material, usage) {
  let root;
  try {
    root = decodeBase64(material);
  } catch {
    throw new VaultSealError("unusable key");
  }
  if (root.length !== 32) throw new VaultSealError("unusable key");
  const hmac = await crypto.subtle.importKey("raw", root, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const info = encoder.encode(LABEL);
  const block = new Uint8Array(info.length + 1);
  block.set(info);
  block[info.length] = 1;
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, block));
  return crypto.subtle.importKey("raw", derived, "AES-GCM", false, [usage]);
}

function aad(workspaceId, entryId, part, generation) {
  return encoder.encode(`${LABEL}:${workspaceId}:${entryId}:${part}:${generation}`);
}

const GENERATION = /^[a-z0-9]{1,16}$/;

/**
 * Seal one part. `keys` is the data key as the control plane opens it:
 * `{ current, keys: { [generation]: base64 } }`.
 */
export async function sealPart(keys, { workspaceId, entryId, part }, value) {
  const generation = keys?.current;
  const material = typeof generation === "string" ? keys.keys?.[generation] : undefined;
  if (typeof material !== "string" || !GENERATION.test(generation)) throw new VaultSealError("no key");
  const key = await vaultKey(material, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(workspaceId, entryId, part, generation) },
      key,
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return `${PREFIX}.${generation}.${encodeBase64(iv)}.${encodeBase64(sealed)}`;
}

/** Open one part, or throw `VaultSealError`. Never returns a partial value. */
export async function openPart(keys, { workspaceId, entryId, part }, envelope) {
  if (typeof envelope !== "string") throw new VaultSealError("not sealed");
  const [prefix, generation, iv, body, extra] = envelope.split(".");
  if (prefix !== PREFIX || extra !== undefined || !GENERATION.test(generation ?? "")) {
    throw new VaultSealError("not sealed");
  }
  const material = keys?.keys?.[generation];
  if (typeof material !== "string") throw new VaultSealError("no key");
  const key = await vaultKey(material, "decrypt");
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(iv), additionalData: aad(workspaceId, entryId, part, generation) },
      key,
      decodeBase64(body),
    );
  } catch {
    throw new VaultSealError("does not open");
  }
  try {
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new VaultSealError("does not open");
  }
}
