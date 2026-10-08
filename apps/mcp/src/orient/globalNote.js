/**
 * The Context.LC-wide note: one short page every `orient` shows first, for
 * every person and every agent, so a standing rule ("update a task's status
 * as you go") can be changed for everybody in one edit.
 *
 * ## Where it lives, and who may change it
 *
 * `guides/agents.md` in the pinned workspace (`@context-lc`) — an ordinary
 * note in an ordinary bucket, so it keeps every property a note has: history,
 * export, the privacy manifest. There is no new store and no new permission.
 * The control plane already puts the pinned context in every account's
 * covered set at `member` (read-only, team tier; see
 * `apps/convex/functions/lib/pinnedContext.ts`), so the people who can edit
 * this are exactly the people who can write `@context-lc`: staff.
 *
 * ## It is read with the caller's own reach, never a service credential
 *
 * The note is fetched through the same `openContext` hop orient already makes
 * for sibling front pages, and filtered through that context's own
 * `privacy.md` at the caller's clearance there. So orient never shows anybody
 * a word `read_note` would refuse them, a note the manifest holds back from
 * members stays with the people who can see it, and a deployment with no
 * pinned context (every self-hosted one) simply has no section.
 *
 * ## Bounded, because it is prepended to every session
 *
 * Fifty lines, and a character cap behind that for the one enormous line.
 * Past either, it is cut and says where the whole note is — cut, never dropped,
 * the rule the front page follows.
 */

import { canSee } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { loadPrivacyState } from "../privacy/state.js";

/**
 * The pinned workspace, addressed as a tool call would address it. Mirrors
 * `PINNED_CONTEXT_SLUG` in `packages/shared/src/pinnedContext.ts` (the gateway
 * takes no dependency on that package); a test holds the two together.
 */
export const PINNED_CONTEXT_NAME = "@context-lc";
export const GLOBAL_ORIENT_PATH = "guides/agents.md";
export const GLOBAL_ORIENT_LINE_CAP = 50;
export const GLOBAL_ORIENT_CHAR_CAP = 6_000;

export function withoutFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

export function capGlobalNote(raw) {
  const text = withoutFrontmatter(raw).trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let shown = lines.slice(0, GLOBAL_ORIENT_LINE_CAP).join("\n");
  let cut = lines.length > GLOBAL_ORIENT_LINE_CAP;
  if (shown.length > GLOBAL_ORIENT_CHAR_CAP) {
    shown = shown.slice(0, GLOBAL_ORIENT_CHAR_CAP);
    cut = true;
  }
  return cut
    ? `${shown}\n\n[truncated — read the whole thing with read_note("${GLOBAL_ORIENT_PATH}") ` +
        `and context: "${PINNED_CONTEXT_NAME}"]`
    : shown;
}

async function readFrom(path, shape, store, scope, rules, overrides) {
  if (!canSee(path, scope, rules, overrides)) return null;
  const object = await getWithLegacyFallback(store, path);
  if (!object) return null;
  return shape(await object.text());
}

/**
 * The capped note, or `null` — absent, held back, unreachable, or no pinned
 * context. Never throws: a Context.LC-wide note that fails must not cost
 * anybody their own orientation.
 *
 * `here` is the context being oriented. When it *is* the pinned one, its own
 * store and clearance answer; otherwise `openPinned` makes the hop. It is
 * `store.openPinnedContext`, which `route.js` binds to the session store's
 * `openContext` for this one name only — and hands on to an addressed store,
 * so an orient into `@other` still carries the note without that store
 * gaining a general opener.
 */
export async function readGlobalOrientNote({ contexts, openPinned, here }) {
  return readPinnedNote({ contexts, openPinned, here }, GLOBAL_ORIENT_PATH, capGlobalNote);
}

/**
 * Any one note from the pinned workspace, read exactly as the global note is:
 * through the caller's own reach and that context's `privacy.md`, shaped by
 * `shape`, and `null` for every way it can be missing. The assistant's
 * production setups (`agent/production.js`) are read this way too.
 */
export async function readPinnedNote({ contexts, openPinned, here }, path, shape) {
  try {
    const current = (contexts || []).find((entry) => entry.current);
    if (current?.name === PINNED_CONTEXT_NAME && here) {
      return await readFrom(path, shape, here.store, here.scope, here.rules, here.overrides);
    }
    if (!(contexts || []).some((entry) => entry.name === PINNED_CONTEXT_NAME)) return null;
    if (typeof openPinned !== "function") return null;
    const opened = await openPinned();
    const privacy = await loadPrivacyState(opened.store);
    if (privacy.error) return null;
    return await readFrom(path, shape, opened.store, opened.session.scope, privacy.rules, privacy.overrides);
  } catch {
    return null;
  }
}
