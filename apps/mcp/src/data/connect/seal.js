/**
 * The seal on a connected app's read-only key while the workspace's sync object keeps it
 * (`docs/decisions/data-and-metrics.md`, "Apps connect with read-only keys").
 *
 * The owner pastes the key once, in the app. The gateway hands it to the workspace's sync object, which checks it
 * with the app, seals it here and keeps only the sealed text. Only the sync object opens it, at run time, to read
 * that app's data. No note, no bucket, no vault entry, no AI client and no `send api` call ever holds or reaches it.
 *
 * - **Key:** HKDF-SHA-256's expand step over the gateway secret, under a label of its own, so it is never the key
 *   that seals a workspace's storage binding (`workspaceStore/bindingSeal.js`). Rotating the gateway secret makes
 *   every kept key unreadable: each source then stops and asks an owner to connect again.
 * - **Bound to one workspace and one app:** AES-GCM with `data:<workspaceId>:<app>` as additional data, so a
 *   key sealed for one app and copied under another, or into another workspace's object, fails to open.
 * - **Versioned:** `v1.<iv>.<ciphertext>`, base64url. Anything else is refused.
 */

const VERSION = "v1";
const INFO = new TextEncoder().encode("context data connection seal v1");
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP = /^[a-z]{1,20}$/;

export class ConnectionSealRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectionSealRefused";
  }
}

function b64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) throw new ConnectionSealRefused("not a sealed key");
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(plain, (char) => char.charCodeAt(0));
}

async function sealKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) throw new ConnectionSealRefused("no gateway secret to seal with");
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const block = new Uint8Array(INFO.length + 1);
  block.set(INFO);
  block[INFO.length] = 1;
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, block));
  return crypto.subtle.importKey("raw", signed, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function boundTo(workspaceId, app) {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) throw new ConnectionSealRefused("a kept key belongs to one workspace");
  if (typeof app !== "string" || !APP.test(app)) throw new ConnectionSealRefused("a kept key belongs to one app");
  return new TextEncoder().encode(`data:${workspaceId}:${app}`);
}

/** `value` (any JSON) sealed for `workspaceId`'s `app`. */
export async function sealConnection(value, { secret, workspaceId, app }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: boundTo(workspaceId, app) }, await sealKey(secret), plain);
  return `${VERSION}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/** The value sealed for `workspaceId`'s `app`; throws `ConnectionSealRefused` for anything sealed otherwise. */
export async function openConnection(sealed, { secret, workspaceId, app }) {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 3 || parts[0] !== VERSION) throw new ConnectionSealRefused("not a sealed key");
  const bound = boundTo(workspaceId, app);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parts[1]), additionalData: bound }, await sealKey(secret), fromB64url(parts[2]));
  } catch (error) {
    if (error instanceof ConnectionSealRefused) throw error;
    throw new ConnectionSealRefused("sealed for another workspace, app or key");
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
