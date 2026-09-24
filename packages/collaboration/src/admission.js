/** Which paths and texts collaboration may touch at all. */

import { eligible } from "./eligibility.js";
import { fail } from "./storage.js";

export function assertEligible(path, text) {
  if (!eligible(trashOriginalPath(path) ?? path, text)) throw fail("INELIGIBLE_DOCUMENT", "document is not eligible for collaboration");
}

/** The encrypted Markdown wrapper is opaque to collaboration forever. */
export function isEncryptedEnvelope(text) {
  if (typeof text !== "string") return false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!frontmatter || !/^\s*context_encryption\s*:\s*v\d+\s*$/m.test(frontmatter[1])) return false;
  return /```context-encrypted\s*\r?\n[\s\S]*\r?\n```(?:\r?\n|$)/.test(body);
}

// Only lifecycle operations admit the existing private trash layout. Public
// read/write entry points still refuse every plumbing path.
function trashOriginalPath(path) {
  return typeof path === "string"
    ? /^\.context\/trash\/[A-Za-z0-9][A-Za-z0-9._-]*\/(.+)$/.exec(path)?.[1] ?? null
    : null;
}

export function lifecyclePath(path, internalTrash) {
  return eligible(path, "") || (internalTrash === true && eligible(trashOriginalPath(path), ""));
}
