/**
 * Context plugins: the catalogue, and the switch a bucket holds.
 *
 * Three properties carry this feature, and the checks below are grouped by
 * them rather than by module:
 *
 *  1. **A bucket cannot impersonate a built-in.** The `context-` prefix is
 *     reserved, and a plugin folder synced into a vault under one of those ids
 *     must never present itself as the thing whose row carries an off switch.
 *  2. **Unreadable means default, and default means on.** Every failure this
 *     file can produce — absent, empty, truncated, contradictory, from the
 *     future, from a backend that threw — resolves to the manifest's default,
 *     because a switch removes a capability and never a protection.
 *  3. **The file round-trips.** It is synced into somebody's vault and opened
 *     in their editor, so toggling off and on again has to produce the bytes
 *     that were there before rather than a reordering.
 *
 * The gateway half — a switched-off tool leaving `tools/list` and being refused
 * per call — lives in `test.mjs`, because it needs the worker and a session.
 */

import { R2Store } from "../src/store/r2.js";
import { renderPluginReport } from "../src/plugins/report.js";
import {
  CONTEXT_PLUGINS,
  CONTEXT_PLUGIN_IDS,
  CONTEXT_PLUGIN_PREFIX,
  TOOL_OWNERS,
  contextPluginById,
  isReservedPluginId,
  pluginForTool,
} from "../src/plugins/catalog.js";
import {
  ENABLEMENT_KEY,
  EnablementConflict,
  MAX_ENABLEMENT_BYTES,
  disabledToolNames,
  disabledToolRefusal,
  enabledPluginIds,
  noDecisions,
  parseEnablement,
  pluginEnabled,
  readEnablement,
  renderEnablement,
  resolveContextPlugins,
  setPluginEnabled,
  withDecision,
} from "../src/plugins/enablement.js";

/** The same shape `plugins.test.mjs` uses, minus the listing behaviours. */
function makeBucket() {
  const objects = new Map();
  let etagCounter = 0;
  const encoder = new TextEncoder();
  return {
    objects,
    seed(key, text) {
      objects.set(key, { bytes: encoder.encode(text), etag: `e${++etagCounter}` });
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      if (entry.explode) throw new Error("backend refused this object");
      return {
        etag: entry.etag,
        text: async () => {
          if (entry.explodeText) throw new Error("backend refused this body");
          return new TextDecoder().decode(entry.bytes);
        },
        arrayBuffer: async () => entry.bytes.slice().buffer,
      };
    },
    async put(key, value, options = {}) {
      if (this.refuseConditional && options?.onlyIf) throw new Error("this backend has no conditional writes");
      if (this.loseWrites) return null;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
      const etag = `e${++etagCounter}`;
      objects.set(key, { bytes, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

function makeStore() {
  const bucket = makeBucket();
  const store = new R2Store(bucket);
  return { bucket, store };
}

function storedText(bucket) {
  const entry = bucket.objects.get(ENABLEMENT_KEY);
  return entry ? new TextDecoder().decode(entry.bytes) : undefined;
}

export async function runContextPluginChecks(check) {
  // ---------------------------------------------------------------- catalogue

  check(
    "every Context plugin id carries the reserved prefix",
    CONTEXT_PLUGINS.length > 0 &&
      CONTEXT_PLUGINS.every((plugin) => plugin.id.startsWith(CONTEXT_PLUGIN_PREFIX))
  );
  check(
    "the manifest is Obsidian's shape, with one context key",
    CONTEXT_PLUGINS.every(
      (plugin) =>
        typeof plugin.name === "string" &&
        typeof plugin.version === "string" &&
        typeof plugin.minAppVersion === "string" &&
        typeof plugin.description === "string" &&
        typeof plugin.author === "string" &&
        typeof plugin.isDesktopOnly === "boolean" &&
        typeof plugin.context === "object"
    )
  );
  // The off switch is only honest if a person is told what it costs before
  // they press it. Empty copy here is a row that says "Forms" and nothing else.
  check(
    "every plugin says what turning it off means",
    CONTEXT_PLUGINS.every(
      (plugin) => typeof plugin.context.offMeans === "string" && plugin.context.offMeans.length > 40
    )
  );
  check(
    "ids are unique",
    new Set(CONTEXT_PLUGIN_IDS).size === CONTEXT_PLUGIN_IDS.length
  );
  /*
    The drawings lesson, pinned.

    Drawings was in this catalogue and was taken out: every surface it has is a
    read of a file that is already there, and gating a read would be the switch
    hiding content rather than removing a capability — so its switch governed
    nothing, which is worse than no switch, because the sentence beside it
    promised something the product did not do.

    A tool is the one surface a switch provably governs, in `toolsForSession`
    and in `callToolForSession`. A plugin arriving here with none needs a
    console write path gated on it *and* a check proving that, at which point
    this assertion is the right thing to make more specific — not the thing to
    delete.
  */
  check(
    "every Context plugin has a surface its switch actually governs",
    CONTEXT_PLUGINS.every((plugin) => plugin.context.tools.length > 0)
  );
  check(
    "a tool resolves to the plugin that declares it",
    pluginForTool("submit_form") === "context-forms" &&
      pluginForTool("read_image") === "context-images" &&
      pluginForTool("read_meeting") === "context-meetings"
  );
  // The tools nothing may switch off. `write_note`, `read_note` and `search`
  // are the product; a catalogue that grew a switch over one of them would be
  // a plugin that can turn the notes off.
  check(
    "no Context plugin claims a core tool",
    ["read_note", "write_note", "search", "search_notes", "orient", "list_notes"].every(
      (tool) => pluginForTool(tool) === null
    )
  );
  check(
    "a tool no plugin owns has no owner",
    pluginForTool("set_visibility") === null && !Object.hasOwn(TOOL_OWNERS, "set_visibility")
  );
  /*
    `pluginForTool` uses `Object.hasOwn` rather than a truthiness test on the
    lookup, and this is the check that pins it: `TOOL_OWNERS` is a plain object,
    so `TOOL_OWNERS["constructor"]` is a function and a `!!` test would report
    that every prototype member is a governed tool — which, one line later in
    `callToolForSession`, is a storage read on every call to a tool named
    `toString`.
  */
  check(
    "a prototype member is not mistaken for a governed tool",
    pluginForTool("constructor") === null && pluginForTool("toString") === null
  );
  check(
    "a vault folder cannot borrow a built-in id",
    isReservedPluginId("context-forms") &&
      isReservedPluginId("context-anything-added-later") &&
      !isReservedPluginId("dataview") &&
      !isReservedPluginId("obsidian-context")
  );
  check("an unknown id has no manifest", contextPluginById("dataview") === null);

  // ---------------------------------------------------------------- parsing

  check(
    "an absent file means every default",
    (() => {
      const { decisions, error } = parseEnablement("");
      return error === null && decisions.enabled.length === 0 && decisions.disabled.length === 0;
    })()
  );
  check(
    "a decision file parses",
    (() => {
      const { decisions, error } = parseEnablement(
        JSON.stringify({ version: 1, disabled: ["context-meetings"], enabled: [] })
      );
      return error === null && decisions.disabled[0] === "context-meetings";
    })()
  );
  check("a file that is not JSON is named as such", parseEnablement("{oops").error === "not valid JSON");
  check("a JSON array is refused", parseEnablement("[]").error === "not a JSON object");
  check(
    "a version from the future is refused rather than rewritten",
    parseEnablement(JSON.stringify({ version: 2, disabled: [] })).error?.includes("unsupported version") === true
  );
  check(
    "an id in both lists makes the file malformed",
    parseEnablement(
      JSON.stringify({ version: 1, enabled: ["context-forms"], disabled: ["context-forms"] })
    ).decisions === null
  );
  check(
    "a repeated id in one list makes the file malformed",
    parseEnablement(JSON.stringify({ version: 1, disabled: ["context-forms", "context-forms"] }))
      .decisions === null
  );
  check(
    "a list that is not a list is refused",
    parseEnablement(JSON.stringify({ version: 1, disabled: "context-forms" })).decisions === null
  );
  // An id is printed back into a console row and an audit line. A name that can
  // reverse a run of text draws its own lines in somebody else's report — the
  // strip the plugin inventory already applies to a folder name.
  check(
    "an id carrying a bidi control is refused",
    // Escaped rather than pasted, which is `check-no-identifiers.mjs`'s rule and
    // is the same argument this check is about: a literal U+202E in source
    // reverses the line for the reviewer reading it, so the file would be doing
    // to a human exactly what the parser refuses to let a bucket do to a report.
    parseEnablement(JSON.stringify({ version: 1, disabled: ["context-\u202eforms"] }))
      .decisions === null
  );
  check(
    "an id carrying a path separator is refused",
    parseEnablement(JSON.stringify({ version: 1, disabled: ["../../privacy.md"] })).decisions === null
  );
  check(
    "a file past the cap is refused without being parsed",
    parseEnablement(" ".repeat(MAX_ENABLEMENT_BYTES + 1)).error === "file is too large"
  );

  // ----------------------------------------------------------- the defaults

  check(
    "a plugin nobody decided about takes its manifest default",
    CONTEXT_PLUGINS.every((plugin) => pluginEnabled(plugin, noDecisions()) === true)
  );
  check(
    "disabled wins over an explicit enable on the same id",
    // Cannot be produced by `parseEnablement`, which calls it malformed; this
    // pins the resolver's own order so a hand-built decision set from anywhere
    // else cannot resolve to "on".
    pluginEnabled(contextPluginById("context-forms"), {
      enabled: ["context-forms"],
      disabled: ["context-forms"],
    }) === false
  );

  // --------------------------------------------------------------- the file

  const { bucket, store } = makeStore();
  check(
    "a bucket with no settings file reports every plugin on",
    (await enabledPluginIds(store)).size === CONTEXT_PLUGINS.length
  );
  check("nothing is written by reading", storedText(bucket) === undefined);

  await setPluginEnabled(store, "context-meetings", false);
  check(
    "turning one off takes its tools out of the gate",
    (await disabledToolNames(store)).has("read_meeting") &&
      !(await disabledToolNames(store)).has("submit_form")
  );
  check(
    "the refusal names the plugin and where to undo it",
    disabledToolRefusal("read_meeting")?.includes("Meetings") === true &&
      disabledToolRefusal("read_meeting")?.includes("Plugins") === true
  );
  check("a tool no plugin owns has no such refusal", disabledToolRefusal("read_note") === null);

  const afterOff = storedText(bucket);
  await setPluginEnabled(store, "context-meetings", true);
  check(
    "turning it back on records the decision rather than dropping it",
    (await enabledPluginIds(store)).has("context-meetings") &&
      storedText(bucket)?.includes('"context-meetings"') === true
  );
  await setPluginEnabled(store, "context-meetings", false);
  check("off, on, off again produces the bytes it produced the first time", storedText(bucket) === afterOff);
  check(
    "the file is the shape a person can hand-edit",
    (() => {
      const text = storedText(bucket);
      return text?.endsWith("\n") === true && text.includes('"version": 2') === false;
    })()
  );
  check(
    "the rendered file round-trips through the parser",
    (() => {
      const decisions = { enabled: ["context-images"], disabled: ["context-forms"] };
      const back = parseEnablement(renderEnablement(decisions)).decisions;
      return (
        back.enabled.join() === decisions.enabled.join() && back.disabled.join() === decisions.disabled.join()
      );
    })()
  );
  check(
    "a decision about a plugin this build does not have is kept, never acted on",
    (() => {
      const next = withDecision({ enabled: [], disabled: ["context-from-a-newer-build"] }, "context-forms", false);
      return next.disabled.includes("context-from-a-newer-build") && next.disabled.includes("context-forms");
    })()
  );
  check(
    "turning something on removes it from the disabled list rather than listing it twice",
    (() => {
      const next = withDecision({ enabled: [], disabled: ["context-forms"] }, "context-forms", true);
      return next.disabled.length === 0 && next.enabled.join() === "context-forms";
    })()
  );
  try {
    await setPluginEnabled(store, "not-a-context-plugin", false);
    check("an unknown plugin id is refused rather than written", false);
  } catch {
    check("an unknown plugin id is refused rather than written", true);
  }

  // --------------------------------------------- every failure means default

  const malformed = makeStore();
  malformed.bucket.seed(ENABLEMENT_KEY, "{ not json at all");
  const malformedState = await resolveContextPlugins(malformed.store);
  check(
    "a malformed file leaves every plugin at its default and says why",
    malformedState.plugins.every((entry) => entry.enabled) && malformedState.error === "not valid JSON"
  );
  check("a malformed file switches nothing off", (await disabledToolNames(malformed.store)).size === 0);

  const broken = makeStore();
  broken.bucket.seed(ENABLEMENT_KEY, "{}");
  broken.bucket.objects.get(ENABLEMENT_KEY).explode = true;
  const brokenState = await readEnablement(broken.store);
  check(
    "a backend that throws leaves every plugin at its default",
    brokenState.decisions.disabled.length === 0 && brokenState.unreachable === true
  );
  check(
    "the storage failure is reported in our words, never the backend's",
    brokenState.error?.includes("could not be read") === true &&
      brokenState.error?.includes(ENABLEMENT_KEY) === false
  );
  check(
    "a switch never fails closed: an unreachable file disables nothing",
    (await disabledToolNames(broken.store)).size === 0
  );

  const bodyBroken = makeStore();
  bodyBroken.bucket.seed(ENABLEMENT_KEY, "{}");
  bodyBroken.bucket.objects.get(ENABLEMENT_KEY).explodeText = true;
  check(
    "an object that will not decode leaves every plugin at its default",
    (await disabledToolNames(bodyBroken.store)).size === 0
  );
  try {
    await setPluginEnabled(bodyBroken.store, "context-forms", false);
    check("a write is refused while the current settings cannot be read", false);
  } catch (error) {
    // Refused rather than overwritten: the file we cannot read is the file that
    // holds somebody else's decisions, and writing over it would lose them.
    check(
      "a write is refused while the current settings cannot be read",
      !(error instanceof EnablementConflict)
    );
  }

  // ------------------------------------------------------------- the report

  /*
    `list_plugins` answers one question with both halves. The empty-vault report
    is used here on purpose: that is the bucket most customers have, and before
    this the only answer it could give was "no Obsidian plugins found" for a
    context that was running four plugins at the time.
  */
  const emptyVault = {
    available: true,
    reason: null,
    plugins: [],
    counts: {},
    found: 0,
    scanned: 0,
    truncated: false,
    checkedAt: new Date().toISOString(),
  };
  const withContext = await resolveContextPlugins(store);
  const rendered = renderPluginReport(emptyVault, withContext.plugins);
  check(
    "a context with no vault plugins still reports the ones it is running",
    rendered.includes("CONTEXT PLUGINS") && rendered.includes("Markdown forms")
  );
  check(
    "an off plugin is reported as off, with what that costs",
    rendered.includes("(context-meetings) — off") &&
      rendered.includes("The two meeting tools disappear")
  );
  check(
    "an on plugin names the tools it is the reason for",
    rendered.includes("tools: submit_form")
  );
  check(
    "and a caller that passes none gets exactly the report it got before",
    renderPluginReport(emptyVault).startsWith("No Obsidian plugins found")
  );

  // ------------------------------------------------------- concurrent owners

  const contended = makeStore();
  await setPluginEnabled(contended.store, "context-forms", false);
  const before = storedText(contended.bucket);
  // Every conditional write loses: the file changed under this caller between
  // its read and its write, which is the shape two owners on one settings page
  // actually produce.
  contended.bucket.loseWrites = true;
  let conflicted = false;
  try {
    await setPluginEnabled(contended.store, "context-images", false);
  } catch (error) {
    conflicted = error instanceof EnablementConflict;
  }
  check("a losing conditional write is reported, never reported as saved", conflicted);
  check("and it leaves the other owner's decision standing", storedText(contended.bucket) === before);

  const unconditional = makeStore();
  unconditional.store.capabilities = { ...unconditional.store.capabilities, conditionalWrite: false };
  unconditional.bucket.refuseConditional = true;
  await setPluginEnabled(unconditional.store, "context-forms", false);
  /*
    B2 and Wasabi. `forms.md` refuses a *submission* on these stores because a
    lost write there destroys somebody's content; a lost preference does not,
    so this one writes unconditionally rather than refusing — and it must not
    send an `onlyIf` the adapter would reject.
  */
  check(
    "a store without conditional writes still records the decision",
    (await disabledToolNames(unconditional.store)).has("submit_form")
  );
}
