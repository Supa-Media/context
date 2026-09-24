/**
 * Attachment filename sanitisation.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import { singleLine } from "./headers";

/**
 * An attachment filename is attacker-chosen and is about to become part of an
 * object key in someone's bucket. Reduce it to a leaf name made of characters
 * that cannot mean anything to a path resolver.
 *
 * Returns `""` when nothing usable survives; callers name the object by its
 * content hash in that case rather than inventing a name.
 */
export function safeFilename(value: string, maxLength = 80): string {
  const leaf = singleLine(value).split(/[\\/]/).pop() || "";
  const cleaned = leaf
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // Collapse runs of dots. Nothing here can traverse a path — the leaf has no
    // separator left — but a name still *containing* ".." invites a reader
    // (human or code) to conclude that traversal is possible, and a name is not
    // worth that argument.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "")
    .slice(0, maxLength);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "" : cleaned;
}
