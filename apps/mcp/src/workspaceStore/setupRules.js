/**
 * Tex's setup read, answered by the pinned workspace's own object (decided 2026-11-04, Dev: "can we do setup
 * without convex?"; `docs/decisions/texting-assistant/setup-read.md`).
 *
 * The same narrowing the control plane makes for it (`apps/convex/functions/lib/texSetupRead.ts` `setupRules`), over
 * the member rules the object keeps: each setup folder keeps the visibility a member reads it at, written out so a
 * dropped parent cannot change it, with every rule and note exception beneath it, and nothing else. A path outside
 * them matches no rule and is `private`, which a read at `team` never sees.
 * `apps/convex/__tests__/texSetupReadParity.test.ts` holds the two to the same answers.
 */

import { visibilityOf } from "../privacy/engine.js";

/** The only folders the setup read opens, with no trailing slash (the control plane's `SETUP_FOLDERS`). */
export const SETUP_FOLDERS = Object.freeze(["ai/production", "ai/agents"]);

const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/**
 * A member's held rules (`{folders, notes, accessVersion, etag?}`, as the object keeps them) narrowed to the setup
 * folders, in the same shape; null when there are none to narrow.
 */
export function setupHeldRules(member) {
  if (!member || typeof member !== "object" || !Array.isArray(member.folders) || !Array.isArray(member.notes)) return null;
  const folders = [];
  for (const folder of SETUP_FOLDERS) {
    folders.push({ prefix: folder, visibility: visibilityOf(folder, member.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility }))) });
    for (const rule of member.folders) if (rule.prefix !== folder && under(rule.prefix, folder)) folders.push({ prefix: rule.prefix, visibility: rule.visibility });
  }
  const notes = [];
  const seen = new Set();
  for (const note of member.notes) {
    if (!SETUP_FOLDERS.some((folder) => under(note.path, folder))) continue;
    // A map in the control plane: the last exception for a path wins, at the place its first one stood.
    if (seen.has(note.path)) {
      notes[notes.findIndex((held) => held.path === note.path)] = { path: note.path, visibility: note.visibility };
      continue;
    }
    seen.add(note.path);
    notes.push({ path: note.path, visibility: note.visibility });
  }
  return { ...(typeof member.etag === "string" ? { etag: member.etag } : {}), folders, notes, accessVersion: member.accessVersion };
}
