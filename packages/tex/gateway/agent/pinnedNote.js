/**
 * Tex's reads of a note in the pinned workspace (`@context-lc`: its setups, their modules, the job setups), and of
 * the access rules the store it is handed judges by.
 *
 * The same reads Context's orient makes for its global note (`apps/mcp/src/orient/globalNote.js` `readPinnedNote`,
 * `privacy/state.js` `loadPrivacyState`), over the store and the door Context hands Tex for a turn, so Tex reaches
 * neither gateway module. They stay reads of the handed store rather than `read_note` calls on purpose: an MCP read
 * is metered as the person's tool use (`mcp/usage.js`), and a setup is read on every turn by Tex, not by them.
 * The permission check is the privacy engine's own `canSee`, at the reader's clearance in that workspace, so Tex
 * never reads a word there that `read_note` would refuse the same reader.
 */

import { canSee, PRE_PARSED_RULES, PRIVACY_KEY } from "../../../../apps/mcp/src/privacy/engine.js";
import { getWithLegacyFallback } from "../../../shared/src/storageLayout.cjs";
import { PINNED_CONTEXT_NAME } from "../../../shared/src/texContract/pinnedContext.cjs";

/**
 * The rules the store judges by (`{ rules, overrides }`), which it carries rendered from the workspace's rows, or
 * `{ error }` when it carries none: then nothing is readable (fail closed), as `loadPrivacyState` answers.
 */
export async function storeRules(store) {
  const object = await store.get(PRIVACY_KEY);
  const preParsed = object?.[PRE_PARSED_RULES];
  if (preParsed === undefined) return { error: "no_rules" };
  return { rules: preParsed.rules, overrides: preParsed.overrides };
}

async function readFrom(path, shape, store, scope, rules, overrides) {
  if (!canSee(path, scope, rules, overrides)) return null;
  const object = await getWithLegacyFallback(store, path);
  if (!object) return null;
  return shape(await object.text());
}

/**
 * One note from the pinned workspace, shaped by `shape`, or `null` for every way it can be missing (absent, held
 * back, unreachable, no pinned workspace). Never throws. `here` is the reach when the turn runs inside the pinned
 * workspace; otherwise `openPinned()` opens it (`{ store, session }`) and its own rules judge at that session's scope.
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
    const privacy = await storeRules(opened.store);
    if (privacy.error) return null;
    return await readFrom(path, shape, opened.store, opened.session.scope, privacy.rules, privacy.overrides);
  } catch {
    return null;
  }
}
