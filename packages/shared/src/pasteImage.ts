/**
 * The name a pasted picture is stored under, from its content hash and type.
 *
 * One rule in two places that have to agree. The control plane names the
 * object when it stores a paste (`pasteImageLeaf` in `fileOps/images.ts`),
 * and a phone that is offline names it first, so the note can embed the
 * picture now and the upload later lands under the same name (owner,
 * 2026-11-09: "every action works offline", pictures included). Two copies of
 * the type list would be a picture embedded under one name and stored under
 * another.
 */
export const PASTE_IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

/** How many hex characters of SHA-256 name the object. */
export const PASTE_IMAGE_HASH_LENGTH = 16;

/**
 * `paste-<hash>.<ext>`, or `null` for a type the store does not take or a hash
 * too short to name anything. The hash is the hex of SHA-256 over the bytes
 * exactly as stored.
 */
export function pasteImageLeafOf(hash: string, contentType: string): string | null {
  const extension = PASTE_IMAGE_EXTENSIONS.get(contentType);
  if (extension === undefined) return null;
  const hex = hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, PASTE_IMAGE_HASH_LENGTH);
  if (hex.length < 8) return null;
  return `paste-${hex}.${extension}`;
}
