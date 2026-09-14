import type { ConsolePlugin } from "./plugins";

/**
 * Installing, updating and removing the plugins Context manages for itself.
 *
 * Pure and React-free, like `plugins.ts` and `grants.ts` beside it.
 *
 * ## The one thing this file exists to keep straight
 *
 * Two kinds of plugin wear the same name in the same list. A `source:
 * "obsidian"` row is somebody else's software, living in `.obsidian/plugins/`,
 * which Context reads and must never write to. A `source: "context"` row is one
 * Context installed, at a version it pinned, under `.context/plugins/`.
 *
 * Every control below is gated on that distinction, and the gate is in a pure
 * function rather than in a component, because the failure mode is not a
 * rendering bug. An Uninstall drawn on a vault row is an offer to delete a file
 * out of the one directory this whole product promises not to touch — and it
 * would look completely ordinary right up until somebody pressed it.
 *
 * `uninstallCommunityPlugin` refuses it server-side too. That is the point: the
 * UI must not be the only thing standing there, and it must not be the thing
 * that proposes it either.
 */

/** One row of the official community registry, as `searchCommunityPlugins` returns it. */
export interface CommunityPlugin {
  id: string;
  name: string;
  author: string;
  description: string;
  repository: string;
}

export interface BrowseView {
  /** Absent until a search has run — an empty array is "nothing matched". */
  results?: CommunityPlugin[];
  query: string;
  /** The count the current `results` were asked for, so the view can tell a full page from a short one. */
  limit: number;
  searching: boolean;
  /** The server's own sentence when a search or an install was refused. */
  failure: string | null;
  /**
   * The code beside it, so the one refusal that needs a person can be told from
   * the several that do not.
   *
   * `PLUGIN_LIFECYCLE_BUSY` is ordinary and resolves itself; the same code after
   * an operation that never finished needs `recoverPluginLifecycle`. The client
   * cannot tell those apart and must not guess, so it shows both sentences and
   * lets the reader say which they are looking at.
   */
  failureCode?: string;
  /** The plugin the refusal was about, so a recovery control lands on the right row. */
  failedPluginId?: string;
  /** Absent for anyone the server would refuse, and in the demo. */
  actions?: LifecycleActions;
}

export interface LifecycleActions {
  /**
   * `limit` is how many rows to ask for, not how many to add: the endpoint
   * takes a count and returns the head of the matches, so "show more" re-runs
   * the same search with a larger number rather than paging.
   */
  search: (query: string, limit?: number) => Promise<void>;
  /** Installs *or* updates: the endpoint pins whatever the official release is now. */
  install: (pluginId: string) => Promise<void>;
  uninstall: (pluginId: string, bundleFingerprint: string) => Promise<void>;
  /** Owner-only, and only offered after an operation was interrupted. */
  recover: (pluginId: string) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                      what a row may offer, and to whom                     */
/* -------------------------------------------------------------------------- */

export type ManagedControl =
  /** Context put this here and can take it away. */
  | { kind: "managed" }
  /**
   * The customer's own vault copy. Context reads it and offers nothing that
   * writes — not a disabled Uninstall, none at all.
   */
  | { kind: "vault" };

export function managedControl(plugin: Pick<ConsolePlugin, "source">): ManagedControl {
  return plugin.source === "context" ? { kind: "managed" } : { kind: "vault" };
}

/**
 * Whether this row can be uninstalled from Context, and what to say when not.
 *
 * `null` means the control is available. Everything else is a sentence, because
 * the absence of a button is only honest if the reader can tell it apart from a
 * button that has not loaded yet.
 */
export function uninstallBlocker(
  plugin: Pick<ConsolePlugin, "source" | "bundleFingerprint">,
): string | null {
  if (plugin.source !== "context") {
    return "This one lives in your own vault. Context reads it and never writes there — remove it in Obsidian if you want it gone.";
  }
  if (!plugin.bundleFingerprint) {
    return "This install could not be identified, so there is nothing exact to remove. Read your plugins again.";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                   wording                                  */
/* -------------------------------------------------------------------------- */

/**
 * The sentence beside Install, and it is a promise rather than a description.
 *
 * `installCommunityPlugin` writes bytes and moves a pointer. It does not create
 * a grant and does not load anything — approval is a separate, later act by the
 * same person. A button labelled "Install" that also started running third-party
 * code would be the consent screen's whole argument undone by one verb.
 */
export const INSTALL_NOTE =
  "Installing puts the official release in your bucket under .context/plugins/. It does not run it: " +
  "you approve what it may do afterwards, and nothing loads until you have.";

/**
 * What uninstall actually does, said plainly because it is not what the word
 * usually means.
 *
 * The pointer goes; the release bytes stay, because they are what fences a
 * later operation and what a rollback needs. Saying "deleted" would be a
 * promise the storage layer deliberately does not keep.
 */
export const UNINSTALL_NOTE =
  "Removing it takes away the active version, so nothing can load it. The downloaded release stays in your " +
  "bucket so you can go back to it, and your vault is untouched either way.";

/** The registry this searches, named so nobody wonders whose list it is. */
export const REGISTRY_NOTE =
  "Obsidian's own community plugin list. Context installs the release the author published, and reads it " +
  "before it offers to run any of it.";

/**
 * What to say when an operation could not start because another one is running.
 *
 * `PLUGIN_LIFECYCLE_BUSY` is the ordinary case and resolves itself. The other
 * half — an operation that started and never finished — is the one that needs a
 * person, and `recoverPluginLifecycle` is deliberately owner-only and
 * confirmation-gated because it unsticks a half-written install.
 */
export const BUSY_NOTE =
  "Something else is changing this plugin's files right now. Wait for it to finish and try again.";

export const STUCK_NOTE =
  "An earlier install or removal stopped part-way, so this plugin's files are held until somebody says it is safe to carry on. " +
  "Recovering finishes the clean-up; it never deletes a note.";

/**
 * Whether a refusal means "in progress" or "stuck".
 *
 * The two arrive as the same error code and want opposite responses — wait, or
 * intervene — so the client cannot tell them apart on its own and must not
 * guess. It offers recovery only where the caller has established the operation
 * is stuck rather than running, which today means the reader saying so.
 */
export function isLifecycleBusy(code: string | undefined): boolean {
  return code === "PLUGIN_LIFECYCLE_BUSY" || code === "PLUGIN_LIFECYCLE_CHANGED";
}

/** The literal the backend demands, so the confirmation is not retyped by hand anywhere. */
export const RECOVER_CONFIRMATION = "RECOVER_PLUGIN" as const;

/* -------------------------------------------------------------------------- */
/*                                   search                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which registry rows are worth showing next to what is already installed.
 *
 * A row already in the bucket is not hidden — somebody searching for a plugin
 * they have wants to be told they have it, not to be shown nothing — but it is
 * marked, because "Install" on something already installed means *update*, and
 * those are different sentences.
 */
export function annotateResults(
  results: CommunityPlugin[],
  installed: ConsolePlugin[],
): Array<CommunityPlugin & { already: "managed" | "vault" | null }> {
  return results.map((row) => {
    const match = installed.find((plugin) => plugin.id === row.id);
    if (!match) return { ...row, already: null };
    return { ...row, already: match.source === "context" ? "managed" : "vault" };
  });
}

/** The verb for a registry row, given what is already in the bucket. */
export function installVerb(already: "managed" | "vault" | null): string {
  switch (already) {
    case "managed":
      return "Update to the latest release";
    case "vault":
      /*
        It is in the vault already, and installing puts a second copy under
        `.context/plugins/` that Context prefers on an id collision. That is a
        real choice with a real consequence, so the verb says what happens
        rather than pretending this is the same "Install" as the empty case.
      */
      return "Also install a managed copy";
    case null:
      return "Install";
  }
}

/* -------------------------------------------------------------------------- */
/*                          browsing rather than searching                    */
/* -------------------------------------------------------------------------- */

/**
 * How many rows the first look asks for, and how many the second one does.
 *
 * `searchCommunityPlugins` clamps its own `limit` to 50, so `REGISTRY_MAX` is
 * that ceiling written down on this side rather than discovered by asking for
 * more and quietly getting less. One "Show more" is therefore the whole of
 * paging today — see `REGISTRY_CAP_NOTE` for what is said when it runs out.
 */
export const REGISTRY_PAGE = 20;
export const REGISTRY_MAX = 50;

/**
 * Whether a result set is the server's ceiling rather than the end of the
 * matches.
 *
 * A short page means the matches ran out; a full one at the ceiling means they
 * did not, and saying "that is all of them" there would be a claim nobody
 * checked. The two have to be told apart before either sentence is printed.
 */
export function atRegistryCeiling(results: CommunityPlugin[] | undefined, limit: number): boolean {
  return results !== undefined && limit >= REGISTRY_MAX && results.length >= REGISTRY_MAX;
}

/** Whether asking for more could return more. */
export function canAskForMore(results: CommunityPlugin[] | undefined, limit: number): boolean {
  return results !== undefined && limit < REGISTRY_MAX && results.length >= limit;
}

/**
 * The sentence under a full page at the ceiling.
 *
 * The registry is a couple of thousand plugins and this endpoint returns at
 * most fifty of them, so a browser that stopped there silently would be
 * presenting a slice as the list. Naming the number is what keeps "50 rows" from
 * reading as "50 plugins exist".
 */
export const REGISTRY_CAP_NOTE =
  `Showing the first ${REGISTRY_MAX}. There are far more — type a word or two to narrow it down.`;

/** Said once, under an unsearched list, so the order is not mistaken for a ranking. */
export const REGISTRY_ORDER_NOTE =
  "In the order Obsidian's list carries them, which is not a popularity order — search if you know what you want.";

/**
 * What to say where results would be, when there are none to show.
 *
 * Three different situations reach the same empty space, and they want three
 * different sentences: the registry is being read, nothing matched what was
 * typed, or a filter matched nothing while the unfiltered list is fine. A
 * single "No results" for all three is the kind of message that makes a working
 * screen look broken.
 */
export function browseEmptyNote(
  query: string,
  results: CommunityPlugin[] | undefined,
  searching: boolean,
): string | null {
  if (results !== undefined && results.length > 0) return null;
  if (searching) return "Reading Obsidian\u2019s community list\u2026";
  if (results === undefined) return null;
  const needle = query.trim();
  if (needle === "") {
    return "Obsidian\u2019s community list came back empty, which usually means it could not be read just now.";
  }
  return `Nothing in the community list matches \u201c${needle}\u201d.`;
}
