import { eligible } from "@context/collaboration";
import { isEncryptedNote, parseEncryptedNote } from "../encryption.js";

/**
 * A generation footer is physical storage metadata for a recreated Markdown
 * path. It is deliberately an HTML comment so a person reading the bucket
 * still sees ordinary Markdown, while the random value makes identical
 * logical text acquire a different provider ETag on every write.
 */
const FOOTER_RE = /\n<!-- context-generation:v1:([0-9a-f]{32}) -->$/;
const TRASH_PATH_RE = /^\.context\/trash\/[A-Za-z0-9][A-Za-z0-9._-]*\/(.+)$/;

function randomNonce() {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is required for Markdown generation stamps");
  }
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Return the user-note path represented by a lifecycle trash key, if any. */
export function normalizedMarkdownPath(path) {
  if (typeof path !== "string") return null;
  return TRASH_PATH_RE.exec(path)?.[1] ?? path;
}

/** Internal metadata keeps its existing CAS semantics; trash is user data. */
export function isInternalMetadataPath(path) {
  return typeof path === "string" && path.startsWith(".context/") && !TRASH_PATH_RE.test(path);
}

/** Eligible plaintext or validated encrypted Markdown may carry a stamp. */
export function isStampEligible(path, text) {
  if (typeof text !== "string" || !eligible(normalizedMarkdownPath(path), "")) return false;
  if (isEncryptedNote(text)) {
    try {
      parseEncryptedNote(text);
      return true;
    } catch {
      return false;
    }
  }
  return eligible(normalizedMarkdownPath(path), text);
}

/**
 * Parse exactly one final footer. The returned logical text preserves every
 * character before the footer, including whether it ended in a newline.
 */
export function stripGenerationStamp(text) {
  if (typeof text !== "string") return null;
  const match = FOOTER_RE.exec(text);
  if (!match) return null;
  return { text: text.slice(0, match.index), nonce: match[1] };
}

/** Append a fresh cryptographically random footer to eligible Markdown text. */
export function stampGeneration(text) {
  if (typeof text !== "string") throw new Error("Markdown generation stamps require text");
  return `${text}\n<!-- context-generation:v1:${randomNonce()} -->`;
}
