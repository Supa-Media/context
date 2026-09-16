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
  "registerMarkdownPostProcessor",
  "registerEvent",
  "registerInterval",
  "registerDomEvent",
  "loadData",
  "saveData",

  // Workspace: which note the console has open, and events when it changes.
  "getActiveFile",

  // The suggestion dialog, by the same inversion as `registerEditorSuggest`:
  // the plugin's `getSuggestions` and `renderSuggestion` run in the sandbox and
  // the console draws the list. They are here rather than in `ABSENT_MEMBERS`
  // because a plugin *extends* them — a missing base class is not a missing
  // feature, it is `extends undefined` thrown before `onload` and the whole
  // plugin gone.
  "SuggestModal",
  "FuzzySuggestModal",

  // An event bus, and a plain-text dialog. Both are base classes a plugin
  // extends at module scope, which is why they are here rather than on a list
  // of things that would be nice: Bible Reference extends `Events` eighty
  // kilobytes into its bundle and `Modal` at the end of it, and each missing
  // one was `extends undefined` before `onload` — the whole plugin gone, over a
  // secondary flow. Neither had ever been listed anywhere, not even as absent,
  // so the scanner called the bundle `runs` while it could not load at all.
  // `pluginBundles.spec.ts` runs the real release in a real browser now,
  // because that is the only check that could have found them.
  "Events",
  "Modal",

  // Helpers the shim exports from the `obsidian` module.
  "normalizePath",

  // Globals rather than module exports, and Obsidian defines them as both. A
  // plugin builds a detached element with the global form — YouVersion's read
  // preview opens with `createDiv({ cls: … })` — so their absence is not a
  // missing convenience, it is a ReferenceError inside a callback nobody awaits.
  "createEl",
  "createDiv",
  "createSpan",
]);

/**
 * Members the shim answers, with a bound worth saying out loud.
 *
 * ## Why a third list rather than a flag on the other two
 *
 * `SUPPORTED_MEMBERS` and `PLANNED_MEMBERS` split "answers" from "does not",
 * and that split is what stopped a roadmap being read out as a capability. It
 * has no room for the third thing, which arrived with the read preview:
 * `registerMarkdownPostProcessor` genuinely runs a plugin's processor and
 * genuinely shows what it produces — against a document Context builds, which
 * carries the note's links and not its prose.
 *
 * Putting that in `PLANNED_MEMBERS` would say the feature does not work, which
 * is false and would hide a working preview behind a "not yet". Leaving it out
 * of both would say it works exactly as Obsidian does, which is the overclaim
 * this file exists to prevent. So a partial member is **in `SUPPORTED_MEMBERS`
 * as well as here**: it is answered, and the answer has a shape worth knowing.
 *
 * The scanner turns each into its own kind of limitation — "works here, with a
 * limit" rather than "not yet, so that part will not work".
 */
export const PARTIAL_MEMBERS = Object.freeze({
  registerMarkdownPostProcessor:
    "a processor runs against the note's links rather than its whole rendered text, so one that decorates headings, code or embeds finds nothing to work on",
});

/**
 * Members the shim is committed to and does not answer yet — the two kinds.
 *
 * This used to be one map, `PLANNED_MEMBERS`, whose comment named both kinds
 * and whose data did not distinguish them. The distinction was described as
 * mattering "to whoever implements them", and it turned out to matter to the
 * *scanner* first, in a way that overclaimed:
 *
 * - An **inert** member is reachable and does nothing. `addSettingTab` accepts
 *   a registration and drops it, so the plugin loads happily and its settings
 *   pane never appears. "Not yet, so that part will not work" is exactly true.
 * - An **absent** member is not on the shim at all. Calling one is a
 *   `TypeError` in whatever path calls it — still a limitation, since the rest
 *   of the plugin runs. **Extending one is not.** `class X extends
 *   api.SuggestModal {}` evaluates `extends undefined` and throws where it
 *   stands, so the bundle never finishes loading and nothing of the plugin
 *   arrives. Reported as a limitation on a `runs` row, that is the roadmap
 *   being read out as a capability all over again, one level down.
 *
 * So the two are separate maps and `scanBundle` can ask which kind it found.
 * `PLANNED_MEMBERS` below is their union, unchanged in shape, because every
 * reader that only needs "name → sentence" should not have to know.
 *
 * **Both halves are checked against the real shim**, in the only place that can
 * run it: `pluginSandboxGuest.test.ts` walks the sandbox and asserts every
 * inert name is reachable on it and every absent name is not. That is the
 * direction the guard could not prove before, and the comment there said so.
 */
export const INERT_MEMBERS = Object.freeze({
  addSettingTab: "a plugin's own settings pane is accepted and not drawn yet",
  registerEditorExtension: "editor decorations are accepted and not applied yet",
  getActiveViewOfType: "the console has no views for this to find yet",
  getLeavesOfType: "the console has no leaves for this to find yet",
});

/**
 * Not on the shim at all. Reaching one is a `TypeError`; extending one is a
 * bundle that never loads — see `INERT_MEMBERS` above for why that matters here
 * rather than only to whoever implements them.
 */
export const ABSENT_MEMBERS = Object.freeze({
  getAllLoadedFiles: "listing every loaded file is not wired to the adapter yet",
  createFolder: "creating a folder has no operation in the plugin RPC yet",
  getFileByPath: "looking a file up by path is not wired yet",
  getFolderByPath: "looking a folder up by path is not wired yet",
  getFirstLinkpathDest: "the link graph is not exposed to plugins yet",
  resolvedLinks: "the link graph is not exposed to plugins yet",
  unresolvedLinks: "the link graph is not exposed to plugins yet",
  fileToLinktext: "the link graph is not exposed to plugins yet",
  registerMarkdownCodeBlockProcessor: "plugin-rendered code blocks are not drawn yet",
  registerView: "a plugin's own panel is not drawn yet",
  registerExtensions: "opening a plugin's own file type is not wired yet",
  getRightLeaf: "the console has no side panels yet",
  getLeftLeaf: "the console has no side panels yet",
  MarkdownRenderer: "rendering markdown on a plugin's behalf is not available yet",
  setIcon: "the icon set is not exposed to plugins yet",
});

/**
 * Every member still on the way, whichever kind, with the sentence to say.
 *
 * Derived rather than typed out a third time: a name added to one of the maps
 * above and forgotten here would be a member the scanner stops mentioning at
 * all, which is the silence this whole split exists to end.
 *
 * A member that is answered but *bounded* belongs in neither map. It is in
 * `SUPPORTED_MEMBERS` and in `PARTIAL_MEMBERS` above — the read preview is the
 * first, and the paragraph up there says why that needed a third list.
 */
export const PLANNED_MEMBERS = Object.freeze({ ...INERT_MEMBERS, ...ABSENT_MEMBERS });


/**
 * Exactly what `require("obsidian")` hands back inside the sandbox.
 *
 * ## A different question from `SUPPORTED_MEMBERS`, and the one nothing asked
 *
 * That list is mostly *methods* — `getMarkdownFiles`, `addCommand`,
 * `registerEditorSuggest` — and it answers "will this call work". This answers
 * "does this name exist on the module at all", which is the question that
 * decides whether a bundle finishes evaluating.
 *
 * Nothing asked it, and two classes fell through the gap. `Events` and `Modal`
 * were on no list in this repository: not supported, not planned, not absent.
 * A bundle extending either scanned clean and was labelled *"runs here"*, and
 * then died on `extends undefined` before `onload` — the whole plugin gone, for
 * a class it used in a flow nobody would have called central.
 *
 * `scan.js` reads this to decide whether a base class the bundle reaches off
 * the `obsidian` module is one the shim actually has. So a class added to the
 * shim and not to this list makes the scanner fail a plugin that works, and a
 * class on this list that the shim does not export makes it pass one that
 * cannot load. Both directions are wrong, and both are caught in one place:
 * `pluginSandboxGuest.test.ts` asserts this list and `Object.keys(api)` are the
 * same set, against the real document.
 */
export const SANDBOX_MODULE_EXPORTS = Object.freeze([
  "Plugin",
  "Notice",
  "Component",
  "Events",
  "Modal",
  "MarkdownView",
  "ItemView",
  "EditorSuggest",
  "SuggestModal",
  "FuzzySuggestModal",
  "PluginSettingTab",
  "Setting",
  "TFile",
  "TFolder",
  "Vault",
  "Workspace",
  "MetadataCache",
  "normalizePath",
  "requestUrl",
]);
