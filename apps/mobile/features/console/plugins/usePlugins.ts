import type { PluginsView } from "./plugins";

/**
 * This context's plugin inventory, for the console.
 *
 * It has one honest answer today: `unavailable`. The gateway can already read
 * `.obsidian/plugins/` and return a full inventory — `apps/mcp/src/plugins/`,
 * reached through the `list_plugins` MCP tool — but the console has no
 * owner-only read of its own yet. Codex is building one
 * (`@supa/1-projects/context-lc-native-plugins/coordination.md` carries the
 * agreed shape and the field-by-field reasoning).
 *
 * ## Why this file exists at all, saying one word
 *
 * Two alternatives were available and both are worse.
 *
 * **Render fixture rows in the live console** until the action lands. That is
 * inventing plugin facts about somebody's vault, and it is the one thing the
 * frontend brief rules out flatly. A person reading "Dataview — won't run
 * here" has no way to tell that sentence came from a placeholder, and the cost
 * of being wrong is that they go and change their setup.
 *
 * **Hide the section** until there is data. That trades an inaccuracy for an
 * absence, which is better, but it also hides the thing the person came to
 * find out: Context has already read their plugins, and they can see the
 * report from any connected AI client today. The unavailable state says that,
 * and points at the route that works.
 *
 * So the section ships, the panel is real, and this is the single wiring point.
 * When the action is on `main` this becomes a `useQueries` subscription like
 * `useAdvanced`, mapping the four states of that subscription onto the four
 * members of `PluginsView`, and nothing else in the console changes.
 */
export function usePlugins(): PluginsView {
  return { state: "unavailable" };
}
