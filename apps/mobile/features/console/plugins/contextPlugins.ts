/**
 * The Context plugins panel, as data.
 *
 * Every sentence this panel prints and every decision it makes about what to
 * show lives here rather than in the component, for the reason
 * `plugins/plugins.ts` gives beside it: the wording of a switch that changes
 * what a whole context can do should be reviewable and testable without
 * mounting anything.
 *
 * ## What this half is, next to the other one
 *
 * `plugins.ts` describes plugins read out of a bucket: bundles, verdicts,
 * evidence, a scan that has to be asked for. This describes plugins that ship
 * with the product: no bundle, no verdict, nothing to check — just a name, what
 * it does, and whether its owner has it on.
 *
 * They are drawn as one list with one search box because they answer one
 * question. They are kept as two modules because they are two different kinds
 * of fact, and a single "plugin" type that had to carry both would be mostly
 * `null` for whichever half you were holding.
 */

/** One built-in, as the control plane reports it. */
export interface ContextPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  enabled: boolean;
  defaultEnabled: boolean;
  tools: string[];
  surfaces: string[];
  offMeans: string;
}

export type ContextPluginsView =
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | {
      state: "ready";
      plugins: ContextPlugin[];
      /** Set when the settings file could not be read, so every row is a default. */
      settingsError: string | null;
      canManage: boolean;
      /** Absent while a change is in flight, so nothing can be pressed twice. */
      actions?: { setEnabled: (id: string, enabled: boolean) => void };
      /** The row currently being written, if any. */
      pending?: string;
    };

/* -------------------------------------------------------------------------- */
/*                             one box, two lists                             */
/* -------------------------------------------------------------------------- */

/**
 * Which halves of the panel a filter shows.
 *
 * Three chips rather than two panels, because "do I have a forms thing" and "do
 * I have Templater" are the same question asked of one screen. The filter
 * exists for the other case — somebody who came here for one of the two and
 * does not want to scroll past the other.
 */
export type PluginFilter = "all" | "context" | "obsidian";

export const PLUGIN_FILTERS: readonly { value: PluginFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "context", label: "Context" },
  { value: "obsidian", label: "Obsidian" },
];

export function showsContext(filter: PluginFilter): boolean {
  return filter !== "obsidian";
}

export function showsObsidian(filter: PluginFilter): boolean {
  return filter !== "context";
}

/**
 * Does this built-in match what somebody typed?
 *
 * The tool names are in the haystack deliberately. A person who read
 * `submit_form` in an agent's output and wants to know where it came from types
 * that, not "Markdown forms" — the same reason `SETTINGS_SECTIONS` carries a
 * `keywords` string that is not the words on the row.
 */
export function matchesContextQuery(plugin: ContextPlugin, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [plugin.name, plugin.id, plugin.description, ...plugin.tools, ...plugin.surfaces]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export function filterContextPlugins(plugins: ContextPlugin[], query: string): ContextPlugin[] {
  return plugins.filter((plugin) => matchesContextQuery(plugin, query));
}

/** The same filter over the vault's plugins, so one box drives both lists. */
export function matchesVaultQuery(
  plugin: { id: string; name: string; author?: string | null },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [plugin.name, plugin.id, plugin.author ?? ""].join(" ").toLowerCase().includes(needle);
}

/* -------------------------------------------------------------------------- */
/*                                  the copy                                  */
/* -------------------------------------------------------------------------- */

export const CONTEXT_LEAD =
  "Built into Context, on unless you turn one off. Turning one off removes what it does — " +
  "never a rule about who can see your notes, and never a file.";

/** "4 on · 1 off", or just the count when nothing has been turned off. */
export function contextCountLabel(plugins: ContextPlugin[]): string {
  const on = plugins.filter((plugin) => plugin.enabled).length;
  const off = plugins.length - on;
  return off === 0 ? `${on} on` : `${on} on · ${off} off`;
}

/**
 * The sentence under a row, which is the same fact worded for the state it is in.
 *
 * It is always printed, for both states, and that is the decision worth
 * defending: a switch whose consequence only appears after it has been pressed
 * is a switch somebody presses to find out. The text itself comes from the
 * gateway's catalogue and travels on the row, so the promise on screen and the
 * behaviour of the tool gate cannot drift apart.
 */
export function switchConsequence(plugin: ContextPlugin): string {
  return plugin.enabled ? `If you turn this off: ${plugin.offMeans}` : `Off. ${plugin.offMeans}`;
}

export function switchLabel(plugin: ContextPlugin): string {
  return plugin.enabled ? "Turn off" : "Turn on";
}

/**
 * Why a reader cannot work the switches, or `null` when they can.
 *
 * A member sees the list — a member who cannot is a member who files "the form
 * isn't there" as a bug — and is told plainly why the controls are absent
 * rather than being shown buttons that only ever refuse.
 */
export function manageBlocker(canManage: boolean): string | null {
  return canManage
    ? null
    : "Only an owner of this context can turn these on or off. What you see here is what is on.";
}

/**
 * What to say when the settings file could not be read.
 *
 * Named rather than swallowed, because every row is then showing a default and
 * not necessarily what somebody set. The reason is the parser's own words.
 */
export function settingsErrorNote(error: string | null): string | null {
  return error === null
    ? null
    : `The plugin settings in this bucket could not be read (${error}), so every plugin below is ` +
        "showing its default. Nothing was changed, and fixing or deleting " +
        ".context/plugins/enabled.json restores your choices.";
}

/** The meta line: what it is called, its version, and where it shows up. */
export function contextMetaLine(plugin: ContextPlugin): string {
  return [plugin.id, `v${plugin.version}`, plugin.surfaces.join(", ")].filter(Boolean).join(" · ");
}

/**
 * The tools a plugin is the reason for, or `null` for one that adds no tool.
 *
 * Drawings is the `null` case and is why this returns one rather than printing
 * an empty label: it changes how a file is *read*, and a row claiming "tools:"
 * with nothing after it would be the panel telling a small lie about it.
 */
export function contextToolLine(plugin: ContextPlugin): string | null {
  return plugin.tools.length === 0 ? null : `Tools: ${plugin.tools.join(", ")}`;
}

/** Nothing matched the box — said differently depending on why. */
export function contextEmptyNote(query: string): string {
  return query.trim() === ""
    ? "This build ships no Context plugins."
    : `No Context plugin matches "${query.trim()}".`;
}
