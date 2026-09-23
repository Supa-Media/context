/**
 * Path and Markdown-shape eligibility without the collaboration engine.
 *
 * This module intentionally has no Yjs (or other package) dependency. Storage
 * adapters use it while building Workers that do not need CRDT support, such
 * as the email worker. Keep the public `eligible` export in index.js backed by
 * this same predicate so the storage seam and engine cannot drift. Storage
 * generation stamps use the narrowly wider `eligibleForStorageStamp` variant
 * for the protected privacy manifest; the CRDT-facing `eligible` export keeps
 * privacy.md excluded.
 */
function eligibleImpl(path, text, allowPrivacyManifest) {
  if (
    typeof path !== "string" ||
    typeof text !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    !path.endsWith(".md")
  ) return false;
  const parts = path.split("/");
  const basename = parts.at(-1) || "";
  if (parts.some((part) => part === "" || part.startsWith("."))) return false;
  if (basename === "privacy.md" && !allowPrivacyManifest) return false;
  if (/\.(?:excalidraw(?:\.md)?|excalidraw\.json)$/i.test(basename)) return false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const frontmatterEnd = body.startsWith("---") ? body.indexOf("\n---", 3) : -1;
  if (
    frontmatterEnd >= 0 &&
    /^\s*context_encryption\s*:\s*v?\d+\s*$/m.test(body.slice(3, frontmatterEnd))
  ) return false;
  return true;
}

export function eligible(path, text = "") {
  return eligibleImpl(path, text, false);
}

/** Markdown storage metadata may stamp the protected privacy manifest. */
export function eligibleForStorageStamp(path, text = "") {
  return eligibleImpl(path, text, true);
}
