/** One read run over the caller's workspace and every other one the person reaches. */

import { loadPrivacyState } from "../privacy/state.js";
import { searchSettingsOf } from "../search/settings.js";
import { servedListingStore } from "../tree/served.js";

/**
 * `read(store, scope, rules, overrides)` run here and in every other workspace
 * the person can reach, the way `search_notes` everywhere opens them
 * (`tools/search.js`): under the person's role there, its own tree and its
 * own rules. Answers `[{ name, ...result }]`, `name` null for this workspace
 * and `@name` for another.
 *
 * Another workspace is read from its own tree, never its bucket. The
 * dispatcher serves the caller's own store (`tools/dispatch.js`), but a store
 * `openContext` builds is raw, and `tree/served.js` decides privacy "twice,
 * never once less": the control plane's clearance there, then `canSee` over
 * its rules. Wrapped here as orient's cross-workspace survey wraps it
 * (`orient/workspaces.js`); a tree that cannot answer throws
 * `TreeUnavailable`, and that workspace is left out rather than walked.
 */
export async function everyWorkspace(store, scope, rules, overrides, read) {
  const names =
    searchSettingsOf(store).everywhere && typeof store.openContext === "function"
      ? (store.contexts ?? []).filter((entry) => !entry.current && typeof entry.name === "string").map((entry) => entry.name)
      : [];
  const [here, ...elsewhere] = await Promise.all([
    read(store, scope, rules, overrides).then((result) => ({ name: null, ...result })),
    ...names.map(async (name) => {
      try {
        const { session: target, store: targetStore } = await store.openContext(name);
        const privacy = await loadPrivacyState(targetStore);
        if (privacy.error) return null;
        const result = await read(servedListingStore(targetStore), target.scope, privacy.rules, privacy.overrides);
        return { name, ...result };
      } catch {
        return null;
      }
    }),
  ]);
  return [here, ...elsewhere.filter(Boolean)];
}
