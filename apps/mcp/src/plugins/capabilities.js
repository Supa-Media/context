/**
 * What an Obsidian plugin may reach for, and which of those Context answers.
 *
 * A plugin is a bundle of JavaScript written against Obsidian's API, which is
 * a *types-only* npm package: `import { Plugin } from "obsidian"` resolves to
 * nothing at install time, and Obsidian injects the real module at runtime.
 * Anything else that runs those bundles has to supply that module itself, and
 * the honest question for every plugin is therefore "does the module we supply
 * cover what this bundle actually touches".
 *
 * This file is the answer to the second half of that question, as data: three
 * sets of identifiers, and what each one means for a plugin that references it.
 * `scan.js` does the matching; nothing here executes anything.
 *
 * ## Why identifiers and module strings, and not an AST
 *
 * Published plugins ship minified. A minifier renames locals freely and cannot
 * rename two things: **property names** reached through a member expression,
 * because the object's shape is not knowable at build time, and **string
 * literals** naming a module, because they are the module's identity. So
 * `plugin.registerMarkdownPostProcessor(...)` and `require("child_process")`
 * both survive minification intact, while the variable that held the plugin
 * does not. Matching on those two things is why a text scan is worth anything
 * here at all — and why matching on anything else would not be.
 *
 * It is still a *floor*, not a proof. See `scan.js` for what that costs and how
 * the verdict is bounded so the floor never reads as a guarantee.
 */

/**
 * Obsidian API members Context implements, or has committed to implementing in
 * the shim that runs plugins in the console.
 *
 * A bundle touching only these is one the sandbox can serve. `Vault` maps onto
 * the storage adapter, `MetadataCache` onto the search indexer's parse of the
 * same files, and the editor half onto CodeMirror 6 — which Context's editor is
 * already built on, and which is the reason editor-decorating plugins are in
 * this list rather than the blocked one.
 */
export const SUPPORTED_MEMBERS = Object.freeze([
  // Vault: the file surface. Every one of these has a storage-adapter answer.
  "getAbstractFileByPath",
  "getFiles",
  "getMarkdownFiles",
  "getAllLoadedFiles",
  "cachedRead",
  "createFolder",
  "getFileByPath",
  "getFolderByPath",

  // MetadataCache: frontmatter, headings, tags, links. The search indexer
  // already parses all four out of the same bytes.
  "getFileCache",
  "getFirstLinkpathDest",
  "resolvedLinks",
  "unresolvedLinks",
  "fileToLinktext",

  // Plugin lifecycle and registration.
  "addCommand",
  "addRibbonIcon",
  "addStatusBarItem",
  "addSettingTab",
  "registerEvent",
  "registerInterval",
  "registerDomEvent",
  "registerMarkdownPostProcessor",
  "registerMarkdownCodeBlockProcessor",
  "registerEditorExtension",
  "registerEditorSuggest",
  "registerView",
  "registerExtensions",
  "loadData",
  "saveData",

  // Workspace, to the extent the console has one.
  "getActiveFile",
  "getActiveViewOfType",
  "getLeavesOfType",
  "getRightLeaf",
  "getLeftLeaf",

  // UI classes the shim provides.
  "MarkdownRenderer",
  "SuggestModal",
  "FuzzySuggestModal",
  "setIcon",
  "normalizePath",
]);

/**
 * Node builtins and desktop-only surfaces, with the reason each one has no
 * answer here.
 *
 * These are matched as **module specifiers** — the string inside a `require`
 * or `import` — because that is the form that survives bundling. A plugin
 * reaching for any of them is reaching for a machine, and the console is a
 * browser tab over somebody's bucket. There is no machine.
 *
 * `path` is deliberately absent. Bundlers routinely polyfill it, it is pure
 * string arithmetic, and flagging it would fail plugins that never touch a
 * filesystem — the cost of a false `wont-run` is a person believing their
 * working plugin is broken, which is worse than a missed one.
 */
export const BLOCKED_MODULES = Object.freeze({
  fs: "reads and writes a local filesystem; your notes live in your bucket",
  "fs/promises": "reads and writes a local filesystem; your notes live in your bucket",
  child_process: "runs another program; there is no process to start in a browser tab",
  electron: "uses Electron's desktop APIs, which the console does not have",
  net: "opens raw sockets, which a browser cannot do",
  dgram: "opens raw sockets, which a browser cannot do",
  worker_threads: "spawns Node worker threads; the sandbox runs one isolate",
  os: "reads the host machine's identity, which is not yours to read here",
  v8: "reaches into the Node runtime, which is not the runtime here",
  vm: "compiles and runs new code outside the sandbox",
  module: "loads code by path at runtime, which defeats the install-time check",
});

/**
 * Obsidian internals that are private, undocumented, and not implemented.
 *
 * Matched as member names. These are not a policy decision — there is no
 * published contract to implement against, and guessing at one produces a shim
 * that breaks differently on every plugin release. A plugin using them is
 * coupled to a specific Obsidian build, and only Obsidian can honour that.
 */
export const BLOCKED_MEMBERS = Object.freeze({
  internalPlugins: "reaches Obsidian's private internal-plugin registry",
  hotkeyManager: "reaches Obsidian's private hotkey internals",
  viewRegistry: "reaches Obsidian's private view registry",
  metadataTypeManager: "reaches Obsidian's private metadata internals",
  customCss: "reaches Obsidian's private theme internals",
  FileSystemAdapter: "requires the desktop filesystem adapter",
  getBasePath: "asks for a filesystem path to the vault; a bucket has no base path",
});

/**
 * Ways a bundle can reach the network.
 *
 * Not blockers. A plugin that syncs highlights is a plugin people want, and
 * refusing it outright would be the wrong trade — so these move a plugin to
 * `needs-approval`, where the owner names the hosts and the audit trail records
 * the calls. `requestUrl` is Obsidian's own CORS-free fetch and is the strongest
 * signal of the four, because nothing but a plugin author reaching outward has
 * a reason to call it.
 */
export const NETWORK_MEMBERS = Object.freeze({
  requestUrl: "uses Obsidian's requestUrl to call a server",
  XMLHttpRequest: "makes HTTP requests",
  WebSocket: "opens a WebSocket",
  EventSource: "opens a server-sent event stream",
});

/**
 * Constructs that build code, or a module name, at runtime.
 *
 * These are the reason the scan is bounded rather than trusted. A bundle that
 * can assemble `require("child_" + "process")` after it starts is a bundle no
 * static reading can characterise, so finding one of these is not a *finding*
 * about what the plugin does — it is the scan reporting that it cannot answer.
 *
 * They therefore never produce `runs`. Treating them as ordinary blockers would
 * be nearly right and wrong in the one direction that matters: an obfuscated
 * bundle would be labelled with the confidence of a clean reading.
 */
export const DYNAMIC_CODE_PATTERNS = Object.freeze([
  {
    id: "eval",
    pattern: /\beval\s*\(/,
    reason: "builds and runs code at runtime, which the install-time check cannot read",
  },
  {
    id: "new-function",
    pattern: /\bnew\s+Function\s*\(/,
    reason: "builds and runs code at runtime, which the install-time check cannot read",
  },
  {
    id: "computed-module",
    detect: hasComputedModuleName,
    reason: "loads a module whose name is assembled at runtime, so what it loads cannot be known here",
  },
]);

/**
 * Whether any `require(...)` or `import(...)` takes anything but one plain
 * string literal.
 *
 * A regex alone gets this wrong in the direction that matters. The obvious
 * "`require(` not followed by a quote" test passes `require("child_" + "process")`
 * — which begins with a quote, is not a literal module name, and is precisely
 * how somebody hides a blocked module from a text scan. So the argument is read
 * up to its closing parenthesis and must be *exactly* a quoted string: anything
 * else, concatenation included, is a module name this check cannot resolve.
 *
 * `__webpack_require__` and esbuild's `__require` are untouched, because `\b`
 * does not match between two word characters — bundler plumbing is not a plugin
 * reaching for something.
 */
function hasComputedModuleName(source) {
  const call = /\b(?:require|import)\s*\(/g;
  for (const match of source.matchAll(call)) {
    const from = match.index + match[0].length;
    // A bounded window, never `source.slice(from)`. A module specifier that
    // needs more than this is not one, and slicing the tail instead copies up
    // to the whole bundle *per call site* — on a minified plugin with thousands
    // of `require(`s that is gigabytes of copying to answer a question about a
    // few hundred characters.
    const window = source.slice(from, from + MODULE_ARGUMENT_WINDOW);
    // One quoted literal, then the closing parenthesis. Anything else —
    // concatenation included — is a name this check cannot resolve.
    const literal = /^\s*(["'`])([^"'`\n]*)\1\s*\)/.exec(window);
    if (!literal) return true;
    // **A literal whose text is not its value is one this method cannot
    // resolve either.** A call whose specifier is written with a hex escape —
    // `child_` followed by `\x70rocess` inside one pair of quotes — satisfies
    // the rule above honestly, because it IS precisely one quoted string, and
    // it loads `child_process`, since the escape is decoded by the engine and
    // not by us. Reading the source text and looking that text up in
    // `BLOCKED_MODULE_NAMES` therefore produced `runs` with nothing blocked:
    // the strongest reading of the strongest evasion, and the documented
    // `"child_" + "process"` case one door over. Decoding it here would mean
    // implementing JavaScript string escapes to answer a yes/no question, so
    // it reads as computed instead — `unknown`, never `runs`, which is the
    // direction this whole family falls in.
    if (literal[2].includes("\\")) return true;
  }
  return false;
}

/**
 * How much of a `require(`'s argument is read.
 *
 * Longer than any real module specifier and short enough that the read is free.
 * A specifier longer than this reads as computed, which is the safe direction:
 * it produces `unknown`, never `runs`.
 */
const MODULE_ARGUMENT_WINDOW = 512;

/**
 * Human judgement about specific plugins, kept deliberately small and separate.
 *
 * Two things live here, and the distinction between them is load-bearing:
 *
 * - **`formatSupported`** — the plugin cannot run in the console, but Context
 *   reads the files it writes, so its data is not lost by staying in Obsidian.
 *   That is a claim about *our* parser and cannot be derived from their bundle.
 * - **`optionalBlockers`** — a blocked call this plugin confines to an optional
 *   feature, so the rest of it runs with that feature off.
 *
 * **An `optionalBlockers` entry changes the label and never the sandbox.** The
 * runtime still has no `child_process`; saying so here only stops us telling
 * somebody their whole templating plugin is unavailable because one optional
 * command runner is. A curation file that could widen what code may do would be
 * a privilege-escalation path with a friendly name — this one cannot, by
 * construction, because nothing reads it but the labelling in `scan.js`.
 */
export const CURATED_PLUGINS = Object.freeze({
  "templater-obsidian": {
    optionalBlockers: ["child_process"],
    limitation: "User System Commands stays off — it shells out, and there is no shell here.",
  },
  "obsidian-git": {
    note: "Context keeps an audit trail of every write. For version history, turn on object versioning at your storage provider — that also captures what you edit in Obsidian directly.",
  },
  "remotely-save": {
    formatSupported: true,
    note: "This is your sync to the bucket, and Context is the other end of it. Leave it running in Obsidian.",
  },
  "obsidian-excalidraw-plugin": {
    formatSupported: true,
    note: "Your .excalidraw.md files stay intact, versioned and searchable here.",
  },
  "obsidian-livesync": {
    formatSupported: true,
    note: "A second sync engine for the same files. Context reads whatever it writes.",
  },
});

/** Every module name the scan knows how to refuse, as a Set for lookup. */
export const BLOCKED_MODULE_NAMES = Object.freeze(new Set(Object.keys(BLOCKED_MODULES)));
