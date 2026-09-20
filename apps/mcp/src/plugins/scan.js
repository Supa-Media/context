/**
 * Reading an Obsidian plugin bundle, and saying honestly what it would do here.
 *
 * Pure functions over text. Nothing in this file touches storage, the network,
 * or the plugin itself — a bundle is never executed to find out what it does,
 * because the whole point of the check is to run before anything runs.
 *
 * ## The verdict is a floor, and the code is shaped to keep it one
 *
 * A text scan can prove a bundle *does* reach for something. It cannot prove a
 * bundle does not: a minifier's output is not a contract, and a bundle that
 * assembles a module name at runtime is not readable at all. So the five
 * verdicts are deliberately asymmetric.
 *
 * `wont-run` and `needs-approval` rest on evidence we found and can name.
 * `runs` rests on evidence we did *not* find, which is the weaker claim, so
 * three things that would let an absence read as a clean bill are routed to
 * `unknown` instead:
 *
 * 1. **A bundle we could not read in full.** A cap is a budget, and a partial
 *    read that reports "no blockers" is reporting on the part it happened to
 *    reach. The same trap the note count documents: a floor must never be
 *    printed as a total.
 * 2. **A bundle that builds code or module names at runtime.** Not a finding
 *    about the plugin — a statement that this method does not apply to it.
 * 3. **A manifest we could not parse.** Without an id and a version there is
 *    nothing to attach a verdict to, and nothing to re-check on the next
 *    release.
 *
 * `unknown` is a real answer with its own screen, not an error. What it must
 * never be is quietly rounded up to `runs`.
 */

import {
  ABSENT_MEMBERS,
  BLOCKED_MEMBERS,
  BLOCKED_MODULES,
  BLOCKED_MODULE_NAMES,
  CURATED_PLUGINS,
  DYNAMIC_CODE_PATTERNS,
  NETWORK_MEMBERS,
  PARTIAL_MEMBERS,
  PLANNED_MEMBERS,
  SANDBOX_MODULE_EXPORTS,
  SUPPORTED_MEMBERS,
} from "./capabilities.js";

/**
 * The most bundle text one scan will read.
 *
 * **This is not a limit on what a customer may store.** It is their bucket and
 * their plugin; the only question here is how much of a bundle this Worker
 * pulls into memory to check it, and a bundle over the line is reported
 * `unknown` — "could not be read" — rather than scanned partially.
 *
 * Raised from 4MB, which was too close to real plugins to be a safety margin:
 * Bible Reference ships 4.11MB because it bundles the scripture text offline,
 * and came back unreadable by 2.7%. A cap that ordinary plugins trip is not
 * protecting anything, it is just refusing to answer.
 *
 * Sized against the Workers 128MB isolate, which is the real bound, and the
 * arithmetic that matters is that **a JavaScript string holds two bytes per
 * code unit**: 16MB of text is a ~33MB string, about a quarter of the isolate,
 * next to a report that holds one bundle at a time. CPU is not the constraint —
 * measured on real minified JavaScript, 4MB, 8MB and 16MB all scan in under a
 * millisecond, because the alternations stop at the first match per name.
 *
 * Deliberately equal to `MAX_PLUGIN_ASSET_BYTES` in `functions/obsidianPlugins.ts`,
 * which bounds the download. Installing something we then cannot check is the
 * one combination worth ruling out by construction.
 *
 * Compared against `String.length`, which counts UTF-16 code units rather than
 * bytes. The name is the budget's intent and the comparison is the cheap
 * approximation of it; for the ASCII a JavaScript bundle is almost entirely
 * made of the two agree, and where they do not the check admits a larger object
 * than the number says rather than a smaller one.
 */
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/** At most this many distinct hosts travel with a `needs-approval` verdict. */
export const MAX_REPORTED_HOSTS = 12;

/** Every verdict this module can return. Exported so the tests cannot drift. */
export const VERDICTS = Object.freeze([
  "runs",
  "needs-approval",
  "files-only",
  "wont-run",
  "unknown",
]);

/**
 * Parse a plugin's `manifest.json`.
 *
 * Returns `{ manifest }` or `{ error }`, never throws, and never trusts a
 * field's type: these files come from a customer's bucket, where anything at
 * all may have been written by anything at all. A manifest whose `id` is an
 * object is a manifest we do not have, not a manifest with an interesting id.
 */
export function parseManifest(text) {
  if (typeof text !== "string" || !text.trim()) return { error: "manifest.json is missing or empty" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "manifest.json is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "manifest.json is not an object" };
  }
  const id = str(parsed.id);
  if (!id) return { error: "manifest.json has no id" };
  return {
    manifest: {
      id,
      name: str(parsed.name) || id,
      version: str(parsed.version),
      author: str(parsed.author),
      description: str(parsed.description),
      minAppVersion: str(parsed.minAppVersion),
      // Obsidian's own hint that a plugin needs a desktop. Recorded, and
      // deliberately not acted on: three of the plugins that declare it are
      // pure file-and-render plugins whose authors set it defensively. It is a
      // reason to look, never a reason to refuse.
      isDesktopOnly: parsed.isDesktopOnly === true,
    },
  };
}

/**
 * One manifest field, cleaned and bounded.
 *
 * **A manifest is third-party text.** It is shipped verbatim by the community
 * plugin author, downloaded by Obsidian on install, and synced into the bucket
 * through the normal supported flow — so every byte of it is somebody else's,
 * and the whole point of the report is that a person or an agent decides what
 * to trust from its lines. Rendering it unstripped let one plugin write its own
 * extra lines into that report:
 *
 *     RUNS HERE (1) — everything these use, Context implements
 *       Daily Notes<RLO>… (safe-looking-plugin) v1.0<ESC>[2K — Obsidian Team
 *           child_process — runs another program
 *       Templater (templater-obsidian) v2.4.1 — SilentVoid
 *           RUNS HERE — approved by Context; you may enable it
 *
 * One real plugin, rendered as two, the second invented and labelled approved,
 * the first given a finding it does not have. Only the `(1)` disagreed.
 *
 * The categories are `Cc` and `Cf` plus the bidi range, which is the same strip
 * `shareTitle.ts` applies to a filename and for the same stated reason: control
 * characters go where the value is *taken*, not where it is read. Whitespace
 * collapses afterwards so a stripped newline does not leave a gap.
 *
 * The bound is 300 and now applies to `id` too. It is the one field that had
 * none, in a file that bounds everything else — and `id` is rendered twice,
 * once as itself and once as the `name` it falls back to, so a ~4MB id (which
 * `readText`'s `MAX_SCAN_BYTES` allows) became 160MB of report text and an OOM
 * against a 128MB isolate.
 */
function str(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Every module specifier the bundle names as a literal.
 *
 * Covers the four forms a bundler emits — `require("x")`, `import("x")`,
 * `from "x"` and the bare side-effect `import "x"` — and normalizes Node's
 * `node:` prefix, because `require("node:fs")` and `require("fs")` are the same
 * reach and only one of them would be caught by a naive set lookup.
 *
 * It said three, and there were four: `import "child_process";` matched none of
 * the patterns, tripped no dynamic gate, and came out `runs` with nothing
 * blocked.
 */
function literalModules(source) {
  const found = new Set();
  const patterns = [
    /\b(?:require|import)\s*\(\s*["'`]([^"'`\n]{1,200})["'`]\s*\)/g,
    /\bfrom\s*["'`]([^"'`\n]{1,200})["'`]/g,
    // The bare side-effect form. `import(` is already covered above, and a `(`
    // is not a quote, so these two cannot both match the same call.
    /\bimport\s*["'`]([^"'`\n]{1,200})["'`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1].startsWith("node:") ? match[1].slice(5) : match[1];
      found.add(specifier);
    }
  }
  return found;
}

/**
 * Hosts the bundle names as literals, for the approval screen.
 *
 * Only absolute `http(s)` URLs, and only the host — a path would be noise on a
 * consent screen, and a grant is per host anyway. Anything unparseable is
 * dropped rather than shown half-decoded: a consent screen is the last place
 * for a string nobody can read.
 */
function literalHosts(source) {
  const hosts = new Set();
  for (const match of source.matchAll(/\bhttps?:\/\/([^\s"'`<>\\)]{1,253})/g)) {
    let host = match[1].split("/")[0].split("?")[0].split("#")[0].split("@").pop();
    host = host.replace(/:\d+$/, "").toLowerCase();
    // A template placeholder or a bundler's own sentinel is not a host.
    if (!host || host.includes("${") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    hosts.add(host);
    if (hosts.size >= MAX_REPORTED_HOSTS) break;
  }
  return [...hosts];
}

/**
 * Read one bundle and report what it reaches for.
 *
 * Matching is on member names and module strings only — see `capabilities.js`
 * for why those two survive minification when nothing else does.
 */
export function scanBundle(source) {
  if (typeof source !== "string") {
    return emptyScan({ unreadable: "the plugin's main.js could not be read" });
  }
  if (source.length > MAX_SCAN_BYTES) {
    return emptyScan({
      unreadable: `main.js is larger than the ${Math.round(MAX_SCAN_BYTES / 1024 / 1024)}MB this check reads`,
    });
  }

  const dynamic = DYNAMIC_CODE_PATTERNS.filter((entry) =>
    entry.detect ? entry.detect(source) : entry.pattern.test(source)
  ).map((entry) => ({ id: entry.id, reason: entry.reason }));

  const modules = literalModules(source);
  const blockedModules = [];
  for (const name of modules) {
    if (BLOCKED_MODULE_NAMES.has(name)) {
      blockedModules.push({ id: name, kind: "module", reason: BLOCKED_MODULES[name] });
    }
  }
  blockedModules.sort((a, b) => a.id.localeCompare(b.id));

  const blockedNames = namesPresent(source, BLOCKED_MEMBER_MATCHER);
  const blockedMembers = [...blockedNames].map((name) => ({
    id: name,
    kind: "member",
    reason: BLOCKED_MEMBERS[name],
  }));

  const networkNames = namesPresent(source, NETWORK_MATCHER);
  const network = [...networkNames].map((name) => ({ id: name, reason: NETWORK_MEMBERS[name] }));

  const presentSupported = namesPresent(source, SUPPORTED_MATCHER);
  const supported = SUPPORTED_MEMBERS.filter((name) => presentSupported.has(name));

  // Named, not counted, and carried separately from `supported`: these are the
  // members the shim has committed to and does not answer, so a plugin using
  // one still runs with that part of it missing. `verdictFor` turns each into a
  // limitation, which is the only place the difference is visible to a reader.
  const presentPlanned = namesPresent(source, PLANNED_MATCHER);
  const planned = Object.keys(PLANNED_MEMBERS).filter((name) => presentPlanned.has(name));

  // Answered, and bounded. Separate from `planned` because the sentence a
  // reader needs is a different one: "this works here, within this" rather than
  // "this does not work here yet". Collapsing the two would either hide a
  // working feature behind a "not yet" or drop the bound entirely.
  const presentPartial = namesPresent(source, PARTIAL_MATCHER);
  const partial = Object.keys(PARTIAL_MEMBERS).filter((name) => presentPartial.has(name));

  /*
    The one way a member the shim does not have stops being a limitation and
    becomes a blocker: a bundle extending it never finishes evaluating, so no
    part of the plugin arrives rather than one part of it missing. Carried
    separately from `blocked` because the reason differs — nothing here reaches
    outside the sandbox, it reaches for something inside that is not built yet.
  */
  const missingBases = [
    ...new Set([
      ...[...source.matchAll(MISSING_BASE_MATCHER)].map((match) => match[1]),
      // And the ones no list has ever mentioned, derived from what the shim
      // exports rather than from what somebody wrote down. See
      // `undeclaredBases`: this half is what would have caught `Events` and
      // `Modal`, each of which took a whole plugin down while the card said it
      // ran.
      ...undeclaredBases(source),
    ]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: name,
      kind: "member",
      reason: Object.hasOwn(ABSENT_MEMBERS, name)
        ? `used as a base class, and ${ABSENT_MEMBERS[name]}`
        : // Nothing is claimed about a name we only know we do not have. "Not
          // built yet" would be a roadmap promise about somebody else's API,
          // which is the mistake `SUPPORTED_MEMBERS` was split in two to end.
          "used as a base class, and Context's plugin runtime does not provide it",
    }));

  return {
    unreadable: null,
    dynamic,
    blocked: [...blockedModules, ...blockedMembers],
    network,
    supported,
    planned,
    partial,
    missingBases,
    hosts: network.length ? literalHosts(source) : [],
  };
}

function emptyScan({ unreadable }) {
  return {
    unreadable,
    dynamic: [],
    blocked: [],
    network: [],
    supported: [],
    planned: [],
    missingBases: [],
    hosts: [],
  };
}

/**
 * Which of these identifiers the bundle names, in one pass.
 *
 * `\b` on both sides, so `os` inside `close` does not match and neither does a
 * property whose name merely ends in one we care about. Deliberately does not
 * require a leading `.`: `FileSystemAdapter` and `XMLHttpRequest` are reached
 * as bare identifiers, and a destructured `const { requestUrl } = obsidian` is
 * the normal way a plugin takes the ones that are members.
 *
 * One alternation per table rather than one regex per name. Written the obvious
 * way — `names.filter((n) => new RegExp(`\\b${n}\\b`).test(source))` — a report
 * walks all three tables for every plugin it opens: 49 passes over a bundle
 * that may be megabytes, twenty times over, inside one Worker invocation's CPU
 * budget.
 *
 * Measured over a 1.24MB bundle for 20 plugins: **206ms per-name, 94ms as three
 * alternations.** Worth having and worth stating accurately — the first version
 * of this comment claimed a fifteen-fold gain, which nothing had measured. The
 * factor is smaller than the pass count suggests because `test()` stops at the
 * first match while `matchAll` collects every occurrence, and collecting is the
 * part we need: the question is *which* names appear, not whether any does.
 *
 * The alternations are built once at module load. Every name in them is a
 * hardcoded identifier from `capabilities.js`, so there is nothing to escape;
 * a name with regex syntax in it would be a bug in that file, not input.
 */
function namesPresent(source, matcher) {
  const found = new Set();
  for (const match of source.matchAll(matcher)) found.add(match[0]);
  return found;
}

function alternation(names) {
  return new RegExp(`\\b(?:${names.join("|")})\\b`, "g");
}

/**
 * `class X extends <something the shim does not have>`.
 *
 * One alternation like the others, with the `extends` and an optional dotted
 * prefix in front of it. The prefix is what makes this survive bundling: a
 * minifier renames the namespace an import lands in — `class extends
 * Ge.SuggestModal` is real output — but it cannot rename the member, which is
 * the same property every matcher in this file already rests on.
 *
 * `\s*` around the dots rather than none, because a bundler is free to emit
 * `a . B` and a formatter will. `(?:…)*` rather than `?` so a deeper chain
 * (`a.b.SuggestModal`) matches too.
 *
 * It reads text, so the literal string `"extends SuggestModal"` in a comment
 * would fail a plugin that works. That trade is this file's existing one rather
 * than a new one — every matcher here would do the same for `child_process` in
 * a comment — and this one is the *narrower* end of it: the others match a bare
 * identifier anywhere, and this needs the keyword immediately in front.
 *
 * The nested quantifier is the shape that backtracks catastrophically when two
 * adjacent parts can match the same character. These cannot — `[\w$]` and `\s`
 * are disjoint, and each repetition is anchored by a literal dot — and it is
 * measured rather than argued: 200k dotted segments ending in no match, 100k
 * spaced ones, and 100k near-misses each scan in ~25ms, the same as 4MB of
 * ordinary text.
 */
const MISSING_BASE_MATCHER = new RegExp(
  `\\bextends\\s+(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*(${Object.keys(ABSENT_MEMBERS).join("|")})\\b`,
  "g"
);

/**
 * Which local names the bundle bound `require("obsidian")` to.
 *
 * ## Why the list above was not enough, twice
 *
 * `MISSING_BASE_MATCHER` can only find a name somebody thought to write down,
 * and it found `SuggestModal` because somebody had. `Events` and `Modal` were
 * on no list at all — not supported, not planned, not absent — so a bundle that
 * extends them scanned clean and was reported as *"runs here: everything these
 * use, Context implements"* while it could not finish evaluating. Two names, a
 * verdict that was exactly backwards, and a hand-written list that could not
 * have found either.
 *
 * So this derives the answer instead. Anything reached off the `obsidian`
 * module and used as a base class is a base class the shim has to have; if it
 * is not in `SANDBOX_MODULE_EXPORTS` it will be `extends undefined`, whatever
 * anybody wrote on a list. Adding a member to the shim is what makes it stop
 * being reported, which is the right direction for that dependency to run.
 *
 * **It keys off the module string, not off the identifier.** A minifier renames
 * the namespace freely — `var eo = require("obsidian")` is real output from the
 * release this was written for — but it cannot rename the string, and the same
 * property everything else in this file rests on holds here. Only members
 * reached through a namespace that provably came from `obsidian` are
 * considered, so a bundled third-party library's own `foo.Widget` is not
 * mistaken for one of ours.
 */
const OBSIDIAN_NAMESPACE_MATCHER =
  /(?:^|[^\w$])(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']obsidian["']\s*\)/g;

/**
 * The same binding written the other three ways every plugin is written.
 *
 * A namespace bound by `require` is what esbuild emits, and reading only that
 * left the check blind to the form the official sample plugin uses. Measured on
 * one unknown base class: the namespace form answered `wont-run`, and the
 * destructured form answered `runs`.
 *
 *  - a destructuring off the same `require` — hand-written `main.js` and
 *    rollup's CJS output;
 *  - a named ESM import, which reaches a scan whenever a plugin ships
 *    unbundled or bundles to ESM;
 *  - an ESM namespace import, the twin of the `require` form above.
 *
 * All four key off the module string for the reason the first one does: a
 * minifier renames the local binding freely and cannot rename the string.
 *
 * NO IMPORT-SHAPED EXAMPLE IN THIS COMMENT, AND THAT IS NOT STYLE.
 * `scripts/check-gateway-imports.mjs` strips comments with a walker that
 * tracks strings and not regex literals, so the `["']` classes below leave it
 * inside a string state and the prose after them is scanned as code — measured:
 * four docblock lines here were reported as bare-package imports of
 * `obsidian`, and the job that failed was "Gateway stays dependency-free".
 * It fails in the safe direction (string content is kept, so a real import is
 * never hidden — only a comment is wrongly read), but the example belongs in
 * the test file, where it is a string and where it is checked.
 */
const OBSIDIAN_ESM_NAMESPACE_MATCHER =
  /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']obsidian["']/g;
const OBSIDIAN_DESTRUCTURE_MATCHER =
  /(?:^|[^\w$])(?:var|let|const)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']obsidian["']\s*\)/g;
const OBSIDIAN_NAMED_IMPORT_MATCHER =
  /\bimport\s*\{([^}]*)\}\s*from\s*["']obsidian["']/g;

/**
 * `{ Modal, Events as Bus }` → the local name each one is reachable by, with
 * the **export** it stands for.
 *
 * The export is what gets reported, because the export is what the shim would
 * have to provide: a bundle extending `Bus` is extending `obsidian.Events`, and
 * "Context does not provide Bus" would name a local variable at somebody
 * reading a plugin card.
 */
function boundMembers(clause) {
  const bindings = [];
  for (const part of String(clause).split(",")) {
    const pair = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*|\s+as\s+([A-Za-z_$][\w$]*)\s*)?$/.exec(part);
    if (pair === null) continue;
    const exported = pair[1];
    const local = pair[2] ?? pair[3] ?? exported;
    bindings.push({ local, exported });
  }
  return bindings;
}

/**
 * Every Obsidian class this bundle extends that the shim does not export.
 *
 * Returns names, in source order, deduplicated. A name already caught by
 * `MISSING_BASE_MATCHER` comes back from both and the caller unions them — the
 * two overlap on purpose, because the older matcher still catches an
 * `ABSENT_MEMBERS` name reached without a namespace (a destructured import),
 * which this one by construction cannot see.
 */
export function undeclaredBases(source) {
  const namespaces = [
    ...new Set([
      ...[...source.matchAll(OBSIDIAN_NAMESPACE_MATCHER)].map((match) => match[1]),
      ...[...source.matchAll(OBSIDIAN_ESM_NAMESPACE_MATCHER)].map((match) => match[1]),
    ]),
  ];
  const members = [
    ...[...source.matchAll(OBSIDIAN_DESTRUCTURE_MATCHER)],
    ...[...source.matchAll(OBSIDIAN_NAMED_IMPORT_MATCHER)],
  ].flatMap((match) => boundMembers(match[1]));
  if (namespaces.length === 0 && members.length === 0) return [];
  const exported = new Set(SANDBOX_MODULE_EXPORTS);
  const found = new Set();
  for (const namespace of namespaces) {
    // The namespace is an identifier captured from this bundle, so it can carry
    // no regex syntax — `[A-Za-z_$][\w$]*` is the whole of what matched.
    const matcher = new RegExp(
      `\\bextends\\s+${namespace}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b`,
      "g"
    );
    for (const match of source.matchAll(matcher)) {
      if (!exported.has(match[1])) found.add(match[1]);
    }
  }
  /*
    A name bound straight out of the module is extended by its local name, so
    the bundle is searched for that and the EXPORT is what gets reported. The
    same caveat the namespace half carries applies: a local rebound later in the
    file is still judged by its binding here, which is the trade that keeps this
    a scan rather than an interpreter.
  */
  for (const { local, exported: name } of members) {
    if (exported.has(name)) continue;
    const matcher = new RegExp(`\\bextends\\s+${local}\\b`, "g");
    if (matcher.test(source)) found.add(name);
  }
  return [...found];
}

const SUPPORTED_MATCHER = alternation(SUPPORTED_MEMBERS);
const PLANNED_MATCHER = alternation(Object.keys(PLANNED_MEMBERS));
const PARTIAL_MATCHER = alternation(Object.keys(PARTIAL_MEMBERS));
const BLOCKED_MEMBER_MATCHER = alternation(Object.keys(BLOCKED_MEMBERS));
const NETWORK_MATCHER = alternation(Object.keys(NETWORK_MEMBERS));

/**
 * Combine a manifest, a bundle scan and our own curation into one verdict.
 *
 * Order matters and is the safety property: every path that could turn missing
 * evidence into a confident `runs` is taken first.
 */
export function verdictFor({ manifest, scan }) {
  const curated = (manifest && CURATED_PLUGINS[manifest.id]) || {};
  /*
    A member the shim has committed to and does not answer yet is a limitation
    on every verdict that can carry one, not a blocker and not silence.

    Silence is what this replaced, and it was the one place a verdict overclaimed:
    a plugin using only `registerMarkdownPostProcessor` scanned clean, read as
    "everything these use, Context implements", loaded, registered, and rendered
    nothing — with no sentence anywhere to explain it. One line per distinct
    reason rather than one per member, so a plugin naming all four link-graph
    members says the link graph is not exposed, once.
  */
  /*
    A name that is *extended* is reported as the blocker it is, below, and not
    also as a limitation here. Both would be one row saying the plugin does not
    run and, underneath, that one part of it will not — which reads as a
    contradiction and buries the sentence that matters.
  */
  const extended = new Set((scan.missingBases || []).map((entry) => entry.id));
  const limitations = [
    ...[
      ...new Set(
        (scan.planned || [])
          .filter((name) => !extended.has(name))
          .map((name) => PLANNED_MEMBERS[name])
      ),
    ].map((reason) => `Not yet, so that part will not work: ${reason}.`),
    /*
      And the other kind, which arrived with the read preview: a member that is
      answered within a bound. "Not yet" would be false about it and silence
      would be an overclaim, so it gets its own sentence in the same list —
      a reader wants both facts in one place, and only the wording separates
      "missing" from "bounded".
    */
    ...[...new Set((scan.partial || []).map((name) => PARTIAL_MEMBERS[name]))]
      .map((reason) => `Works here, within a limit: ${reason}.`),
  ];
  const notes = curated.note ? [curated.note] : [];

  if (!manifest) {
    return result("unknown", { evidence: [], notes, limitations, reason: "manifest-unreadable" });
  }
  if (scan.unreadable) {
    return result("unknown", {
      evidence: [{ id: "unreadable", kind: "scan", reason: scan.unreadable }],
      notes,
      limitations,
      reason: "bundle-unreadable",
    });
  }
  if (scan.dynamic.length) {
    return result("unknown", {
      evidence: scan.dynamic.map((entry) => ({ ...entry, kind: "dynamic" })),
      notes,
      limitations,
      reason: "bundle-not-statically-readable",
      supported: scan.supported,
      planned: scan.planned,
    });
  }

  // Curation may move a blocker out of the way of the *label*. It cannot move
  // it out of the way of the sandbox: the runtime still has no answer for it,
  // and this only stops one optional feature failing a whole plugin.
  const optional = new Set(curated.optionalBlockers || []);
  const blocking = scan.blocked.filter((entry) => !optional.has(entry.id));
  for (const entry of scan.blocked) {
    if (optional.has(entry.id) && curated.limitation) limitations.push(curated.limitation);
  }

  if (blocking.length) {
    return result(curated.formatSupported ? "files-only" : "wont-run", {
      evidence: blocking,
      notes,
      limitations,
      reason: curated.formatSupported ? "runs-in-obsidian-format-read-here" : "reaches-outside-the-sandbox",
      supported: scan.supported,
      planned: scan.planned,
    });
  }

  /*
    A base class the shim does not have, which is the one member failure that is
    not a limitation: `class X extends api.SuggestModal {}` evaluates `extends
    undefined` and throws where it stands, so the bundle never finishes loading
    and nothing of the plugin arrives.

    Ordered here — after a blocker, before the network and before `runs` — for
    the reason the header states: every path that could turn missing evidence
    into a confident `runs` is taken first. A plugin that cannot load does not
    need a host approved.

    Curation moves the label exactly as it does for a blocker, and never more
    than the label: a plugin whose format Context reads strands no data, whatever
    it cannot do here. Mirrored rather than special-cased so the two paths cannot
    drift into disagreeing about one plugin.
  */
  if ((scan.missingBases || []).length) {
    return result(curated.formatSupported ? "files-only" : "wont-run", {
      evidence: scan.missingBases,
      notes,
      limitations,
      reason: curated.formatSupported
        ? "runs-in-obsidian-format-read-here"
        : "extends-a-class-the-shim-does-not-have",
      supported: scan.supported,
      planned: scan.planned,
    });
  }

  if (scan.network.length) {
    return result("needs-approval", {
      evidence: scan.network.map((entry) => ({ ...entry, kind: "network" })),
      notes,
      limitations,
      hosts: scan.hosts,
      reason: "calls-a-host-outside-context",
      supported: scan.supported,
      planned: scan.planned,
    });
  }

  return result("runs", {
    evidence: [],
    notes,
    limitations,
    reason: "no-calls-outside-the-sandbox-found",
    supported: scan.supported,
    planned: scan.planned,
  });
}

function result(verdict, { evidence, notes, limitations, hosts = [], reason, supported = [], planned = [] }) {
  return { verdict, evidence, notes, limitations, hosts, reason, supported, planned };
}

/**
 * The whole check for one plugin: manifest, bundle, verdict.
 *
 * `id` is the folder the plugin was found in. It is reported beside the
 * manifest's own id and never substituted for it — a folder renamed by hand is
 * a thing that happens, and the manifest is the plugin's actual identity.
 */
export function scanPlugin({ id, manifestText, source }) {
  const parsed = parseManifest(manifestText);
  const scan = scanBundle(source);
  const verdict = verdictFor({ manifest: parsed.manifest || null, scan });
  return {
    folder: id,
    // Stripped again on the fallback. `isSafeFolder` screens the listing, and a
    // folder reaching here from anywhere else must not depend on that having
    // been the path it took — the manifest half of this is `str()` already.
    id: parsed.manifest?.id || str(id),
    name: parsed.manifest?.name || str(id),
    version: parsed.manifest?.version || "",
    author: parsed.manifest?.author || "",
    description: parsed.manifest?.description || "",
    isDesktopOnly: parsed.manifest?.isDesktopOnly === true,
    manifestError: parsed.error || null,
    ...verdict,
  };
}

/** Counts per verdict, in the order the console draws them. */
export function summarize(plugins) {
  const counts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0]));
  for (const plugin of plugins) {
    if (counts[plugin.verdict] === undefined) continue;
    counts[plugin.verdict] += 1;
  }
  return counts;
}
