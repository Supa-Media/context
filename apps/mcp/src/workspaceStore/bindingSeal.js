/**
 * The seal on a workspace's storage binding while it is kept in the workspace's object (decided by the owner,
 * 2026-11-02; `docs/decisions/storage-and-credentials/credential-basics.md`, "A binding kept in its workspace's
 * object is sealed to it").
 *
 * The control plane opens the binding (the bucket credential and the index tokens beside it), seals it here, and
 * pushes only the sealed text into the object (`apps/convex/functions/workspaceObjectBinding.ts`). The gateway
 * opens it at request time (`store/objectBinding.js`). The object holds text it cannot read.
 *
 * - **Key:** HKDF-SHA-256's expand step over the gateway secret (one HMAC block, written out by hand as
 *   `agent/warmCopy.js` does, since the gateway calls no `deriveKey`), which only the gateway and the control plane hold.
 *   Rotating that secret makes every sealed binding unreadable, and every read then falls back to the control plane
 *   until the next push (a minute) seals them again under the new one.
 * - **Bound to one workspace:** AES-GCM with `workspace:<workspaceId>` as additional data, so a sealed binding
 *   copied into another workspace's object fails to open rather than opening another tenant's bucket.
 * - **Versioned:** `v1.<iv>.<ciphertext>`, base64url. Anything else is refused.
 */

const VERSION = "v1";
const INFO = new TextEncoder().encode("context workspace binding seal v1");

function b64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) throw new BindingSealRefused("not a sealed binding");
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(plain, (char) => char.charCodeAt(0));
}

export class BindingSealRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "BindingSealRefused";
  }
}

async function sealKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) throw new BindingSealRefused("no gateway secret to seal with");
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const block = new Uint8Array(INFO.length + 1);
  block.set(INFO);
  block[INFO.length] = 1;
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, block));
  return await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function boundTo(workspaceId) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new BindingSealRefused("a sealed binding belongs to one workspace");
  return new TextEncoder().encode(`workspace:${workspaceId}`);
}

/** `value` (any JSON) sealed for `workspaceId`'s object. */
export async function sealBinding(value, { secret, workspaceId }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: boundTo(workspaceId) }, await sealKey(secret), plain);
  return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/** The value sealed for `workspaceId`; throws `BindingSealRefused` for anything sealed otherwise or not at all. */
export async function openBinding(sealed, { secret, workspaceId }) {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 3 || parts[0] !== VERSION) throw new BindingSealRefused("not a sealed binding");
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parts[1]), additionalData: boundTo(workspaceId) }, await sealKey(secret), fromB64url(parts[2]));
  } catch (error) {
    if (error instanceof BindingSealRefused) throw error;
    throw new BindingSealRefused("sealed for another workspace or another key");
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
