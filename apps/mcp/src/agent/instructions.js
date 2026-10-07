/**
 * WHAT THE ASSISTANT IS TOLD, KEPT WHERE STAFF CAN EDIT IT.
 *
 * Decided by the owner, 2026-10-07: the assistant's own instructions live in
 * the pinned `@context-lc` workspace, under `assistant/`, so what it knows
 * about itself and about Context is changed by editing a note rather than by
 * shipping the gateway. Two notes:
 *
 * - `assistant/instructions.md` — who it is, what Context is, how to use it.
 *   Replaces the built-in opening of the system prompt on every agent turn.
 * - `assistant/texting.md` — how a texted answer reads. Replaces the built-in
 *   texting style, on texting turns only.
 *
 * They are read the way `orient`'s global note is (`orient/globalNote.js`):
 * through the caller's own reach into the pinned workspace and its
 * `privacy.md`, so a person's assistant is never told a word that person could
 * not read there, and who may change it is who may write `@context-lc`
 * (staff). Either note missing, held back or unreachable — and every
 * self-hosted deployment, which has no pinned workspace — means the built-in
 * words in `turn.js`, never an error and never no prompt at all.
 *
 * Capped, because it is sent with every turn and a cheap model's attention is
 * the budget. Notes in `assistant/` can point at longer guides; the assistant
 * reads those with `read_note` and `context: "@context-lc"` when it needs them.
 */

import { loadPrivacyState } from "../privacy/state.js";
import { PINNED_CONTEXT_NAME, readPinnedNote, withoutFrontmatter } from "../orient/globalNote.js";

export const ASSISTANT_INSTRUCTIONS_PATH = "assistant/instructions.md";
export const ASSISTANT_TEXTING_PATH = "assistant/texting.md";
export const ASSISTANT_CHAR_CAP = 8_000;

export function capInstructions(raw) {
  const text = withoutFrontmatter(String(raw ?? "")).trim();
  if (!text) return null;
  return text.length > ASSISTANT_CHAR_CAP ? text.slice(0, ASSISTANT_CHAR_CAP) : text;
}

/**
 * `{ instructions, texting }`, each the note's text or `null`. Never throws.
 *
 * @param {object} store the session's store, carrying `contexts` and
 *   `openPinnedContext` as `http/route.js` attaches them
 * @param {object} session the caller's session, for its scope when the turn
 *   runs inside the pinned workspace itself
 * @param {{texting: boolean}} options
 */
export async function readAssistantInstructions(store, session, { texting }) {
  try {
    const current = (store.contexts || []).find((entry) => entry.current);
    let here = null;
    if (current?.name === PINNED_CONTEXT_NAME) {
      const privacy = await loadPrivacyState(store);
      if (!privacy.error) here = { store, scope: session.scope, rules: privacy.rules, overrides: privacy.overrides };
    }
    const reach = { contexts: store.contexts, openPinned: store.openPinnedContext, here };
    const [instructions, textingNote] = await Promise.all([
      readPinnedNote(reach, ASSISTANT_INSTRUCTIONS_PATH, capInstructions),
      texting ? readPinnedNote(reach, ASSISTANT_TEXTING_PATH, capInstructions) : Promise.resolve(null),
    ]);
    return { instructions, texting: textingNote };
  } catch {
    return { instructions: null, texting: null };
  }
}
