// @ts-check

/**
 * What the shim actually answers, and what it has only promised.
 *
 * ## Why this lives in the runtime package rather than in the scanner
 *
 * It was in `apps/mcp/src/plugins/capabilities.js`, beside the blocked-module
 * and network tables, and it drifted: twenty names were listed as supported
 * that `sandbox.js` in this package does not implement. A bundle touching only
 * those scanned clean, was labelled `runs` — "everything these use, Context
 * implements" — was approved by somebody reading that sentence, loaded, and
 * threw on its first call.
 *
 * The drift was structural, not careless. The list described one file and lived
 * next to another, in a different app, maintained by a different half of the
 * project. So it moved next to the shim it describes: the package that
 * implements these members is the package that declares them, and the scanner
 * imports the declaration rather than keeping a copy of it.
 *
 * `apps/mcp` imports this by relative path — the `packages/meetings`
 * arrangement, no dependency and no build step — so the gateway stays
 * dependency-free.
 */

/**
 * Obsidian API members the shim **answers today**.
 *
 * ## Why this list shrank, and what a "commitment" was costing
 *
 * It used to read "implements, or has committed to implementing", and mixed
 * both into one list. Twenty of its entries were the second kind:
 * `resolvedLinks`, `MarkdownRenderer`, `registerView` and the rest were not
 * reachable on the shim at all, and `addSettingTab` and
 * `registerMarkdownPostProcessor` were reachable and did nothing.
 *
 * That is the note count's bug in a new place. A bundle touching only these
 * names scans clean, gets `runs` — whose blurb is *"everything these use,
 * Context implements"* — is approved by somebody reading that sentence, loads,
 * and throws on its first call. The verdict is documented everywhere as a
 * floor, and this was the one place it was a ceiling: a roadmap being read out
 * as a capability.
 *
 * So the two are separated. This list is what the sandbox serves; anything
 * still on the way is in `PLANNED_MEMBERS` below with the sentence to say about
 * it, and a bundle that uses one is told rather than surprised.
 *
 * **The test that holds it is in the client, not here**, because only the
 * client can run the shim: `pluginSandboxGuest.test.ts` loads the real sandbox
 * document and asserts every name below is reachable on it. A name added here
 * without an implementation reddens that suite.
 */
export const SUPPORTED_MEMBERS = Object.freeze([
  // Vault: the file surface, over the storage adapter and its etags.
  "getAbstractFileByPath",
  "getFiles",
  "getMarkdownFiles",
  "cachedRead",

  // MetadataCache: frontmatter, headings and tags, parsed from the same bytes.
  "getFileCache",

  // Plugin lifecycle, registration and its own settings file.
  "addCommand",
  "addRibbonIcon",
  "addStatusBarItem",
  "registerEditorSuggest",
  "registerEvent",
  "registerInterval",
  "registerDomEvent",
  "loadData",
  "saveData",

  // Workspace: which note the console has open, and events when it changes.
  "getActiveFile",

  // Helpers the shim exports from the `obsidian` module.
  "normalizePath",
]);

/**
 * Members the shim is committed to and does not answer yet.
 *
 * Each one is a sentence rather than a flag, because a plugin naming one still
 * runs — it is the *feature behind it* that will not work, and "this plugin is
 * unavailable" would be false. `scanBundle` turns each into a limitation on the
 * row, so the console says which half of a plugin arrives.
 *
 * Two kinds are in here and the distinction matters to whoever implements them:
 *
 * - **Absent.** `resolvedLinks`, `registerView`, `MarkdownRenderer` — a plugin
 *   calling one gets a `TypeError` and, if it is in `onload`, a crash the
 *   runtime reports honestly.
 * - **Present and inert.** `addSettingTab`, `registerMarkdownPostProcessor` and
 *   `registerEditorExtension` accept a registration and drop it, so the plugin
 *   loads happily and its settings pane, its rendering or its editor decoration
 *   never appears. That is the harder failure to report, which is exactly why
 *   it is named here rather than left to be noticed.
 */
export const PLANNED_MEMBERS = Object.freeze({
  getAllLoadedFiles: "listing every loaded file is not wired to the adapter yet",
  createFolder: "creating a folder has no operation in the plugin RPC yet",
  getFileByPath: "looking a file up by path is not wired yet",
  getFolderByPath: "looking a folder up by path is not wired yet",
  getFirstLinkpathDest: "the link graph is not exposed to plugins yet",
  resolvedLinks: "the link graph is not exposed to plugins yet",
  unresolvedLinks: "the link graph is not exposed to plugins yet",
  fileToLinktext: "the link graph is not exposed to plugins yet",
  addSettingTab: "a plugin's own settings pane is accepted and not drawn yet",
  registerMarkdownPostProcessor: "rendering a plugin's markdown output is accepted and not drawn yet",
  registerMarkdownCodeBlockProcessor: "plugin-rendered code blocks are not drawn yet",
  registerEditorExtension: "editor decorations are accepted and not applied yet",
  registerView: "a plugin's own panel is not drawn yet",
  registerExtensions: "opening a plugin's own file type is not wired yet",
  getActiveViewOfType: "the console has no views for this to find yet",
  getLeavesOfType: "the console has no leaves for this to find yet",
  getRightLeaf: "the console has no side panels yet",
  getLeftLeaf: "the console has no side panels yet",
  MarkdownRenderer: "rendering markdown on a plugin's behalf is not available yet",
  SuggestModal: "the suggestion dialog is not available yet",
  FuzzySuggestModal: "the suggestion dialog is not available yet",
  setIcon: "the icon set is not exposed to plugins yet",
});

