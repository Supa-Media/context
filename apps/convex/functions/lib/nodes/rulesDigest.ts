/**
 * What a workspace's privacy rules say, as one value: a SHA-256 of their folders and notes in order (order
 * matters, the first rule for a prefix stands). Two writes of the same rules have different versions (`etag`)
 * and the same digest, so the staff check of rows against rules (`lib/privacyRows/checks.ts`) can tell a
 * rewrite that changed nothing from a change. `null` for a workspace with no rules.
 */

import type { Doc } from "../../../_generated/dataModel";

export async function rulesDigest(row: Pick<Doc<"nodePrivacy">, "folders" | "notes"> | null): Promise<string | null> {
  if (row === null) return null;
  const said = JSON.stringify({
    folders: row.folders.map((rule) => [rule.prefix, rule.visibility]),
    notes: row.notes.map((rule) => [rule.path, rule.visibility]),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(said));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
