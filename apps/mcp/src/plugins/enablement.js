/**
 * Which Context plugins this bucket's owner turned off.
 *
 * ## The decision lives in the bucket, with the notes
 *
 * It could have lived in the control plane — it is small, it is not note
 * content, and Convex already holds the plugin *grants*. It does not, and the
 * reason is non-negotiable #1 rather than convenience: a customer who takes
 * their bucket elsewhere, or self-hosts the gateway at it, should find their
 * context configured the way they left it. A workspace whose forms silently
 * come back on after an export is a workspace that was partly ours.
 *
 * It is also the shape Obsidian already chose. `.obsidian/community-plugins.json`
 * is a list of enabled plugin ids sitting in the vault, so a person who knows
 * where Obsidian keeps that knows where this is, and can edit it in a text
 * editor without asking anybody.
 *
 * ## Two lists, not one, because these default to on
 *
 * Obsidian's file is a bare array of enabled ids, and the absence of an id
 * means off. Copying that exactly would be wrong here in the one case that
 * matters most — a bucket that has never seen this file at all, which is every
 * bucket today. Under Obsidian's shape an empty file and a missing file both
 * mean *everything off*, so shipping it would turn five working features off
 * for every existing customer at once.
 *
 * So the file records **decisions**, and an id nobody has decided about takes
 * its manifest's default:
 *
 * ```json
 * { "version": 1, "enabled": [], "disabled": ["context-meetings"] }
 * ```
 *
 * An id in both lists is not a third state to invent a rule for — it is a file
 * that has been edited into a contradiction, and it makes the file malformed.
 *
 * ## Malformed and unreachable both fall back to the defaults, on purpose
 *
 * The rule this rests on, stated once here and enforced everywhere a switch is
 * read: **turning a Context plugin off removes a capability and never a
 * protection.** No guard, no privacy rule, no write refusal is part of any
 * switch. That is what makes "unreadable means default" the safe failure: the
 * worst it can do is hand somebody back a feature they had hidden. The opposite
 * failure — a storage blip disabling forms across a shared workspace, so a
 * member's bug report is refused with no explanation anybody can act on — is
 * both worse and silent.
 *
 * The parse follows the same discipline the privacy manifest and the form block
 * keep: a file we cannot read is reported as unreadable, never guessed at, and
 * never half-applied. What it does *not* do is refuse to serve the context,
 * because a typo in a preferences file must not be able to take a workspace's
 * tools away.
 */

import { CONTEXT_PLUGINS, contextPluginById } from "./catalog.js";

/** Beside the managed installs, and deliberately not inside `.obsidian/`. */
export const ENABLEMENT_KEY = ".context/plugins/enabled.json";

/** The only version this gateway writes, and the only one it reads. */
export const ENABLEMENT_VERSION = 1;

/**
 * A ceiling on the file, so a bucket cannot make the parser the expensive part
 * of a request. Two lists of plugin ids are a few hundred bytes; 64KB is four
 * orders of magnitude of headroom and still a bound.
 */
export const MAX_ENABLEMENT_BYTES = 64 * 1024;

/** As many decisions as anybody can have made. Ids are short; this is generous. */
const MAX_DECISIONS = 200;

/** The empty decision set: everything takes its manifest default. */
export function noDecisions() {
  return { enabled: [], disabled: [] };
}

function isUsableId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    // The same category strip the inventory applies to a folder name, for the
    // same reason: these ids are printed back into a console row and into an
    // audit line, and a name that can move a cursor or reverse a run of text
    // draws its own lines in somebody else's report.
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/]/u.test(value)
  );
}

function readIdList(raw, seen) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_DECISIONS) return null;
  const ids = [];
  for (const entry of raw) {
    if (!isUsableId(entry)) return null;
    // A repeat within one list is harmless and is still a file somebody's tool
    // wrote wrong; collapsing it quietly would let it accumulate. Across the
    // two lists it is the contradiction described in the header.
    if (seen.has(entry)) return null;
    seen.add(entry);
    ids.push(entry);
  }
  return ids;
}

/**
 * Read the file's text into decisions, or say why it could not be read.
 *
 * Returns `{ decisions, error }` with exactly one of the two set. Nothing here
 * throws: the caller is a request path, and an unreadable preferences file is
 * not a reason to fail one.
 */
export function parseEnablement(text) {
  if (typeof text !== "string") return { decisions: null, error: "not text" };
  if (text.length > MAX_ENABLEMENT_BYTES) return { decisions: null, error: "file is too large" };
  const trimmed = text.trim();
  // An empty file is a file somebody truncated, not a decision to make. It
  // reads as the default set rather than as an error, because that is what it
  // means and because reporting it would put a warning on a console row for a
  // bucket in a perfectly ordinary state.
  if (trimmed === "") return { decisions: noDecisions(), error: null };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { decisions: null, error: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { decisions: null, error: "not a JSON object" };
  }
  if (parsed.version !== ENABLEMENT_VERSION) {
    // Named rather than ignored. A version from the future is the one case
    // where carrying on would be actively wrong: it is a file a newer gateway
    // wrote, and quietly rewriting it in the old shape loses whatever that
    // version added.
    return { decisions: null, error: `unsupported version ${JSON.stringify(parsed.version)}` };
  }
  const seen = new Set();
  const disabled = readIdList(parsed.disabled, seen);
  if (!disabled) return { decisions: null, error: "`disabled` is not a list of plugin ids" };
  const enabled = readIdList(parsed.enabled, seen);
  if (!enabled) {
    return {
      decisions: null,
      error: "`enabled` is not a list of plugin ids, or repeats one that is already disabled",
    };
  }
  return { decisions: { enabled, disabled }, error: null };
}

/**
 * The file's canonical text.
 *
 * Sorted and pretty-printed because this file is synced into a vault and opened
 * in editors: a stable byte sequence means toggling a plugin off and on again
 * produces the file that was there before, and a diff shows one line rather
 * than a reordering.
 */
export function renderEnablement(decisions) {
  const body = {
    version: ENABLEMENT_VERSION,
    enabled: [...(decisions?.enabled || [])].sort(),
    disabled: [...(decisions?.disabled || [])].sort(),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Is this plugin on, given these decisions? Absent from both lists: its default. */
export function pluginEnabled(manifest, decisions) {
  if (!manifest) return false;
  if (decisions?.disabled?.includes(manifest.id)) return false;
  if (decisions?.enabled?.includes(manifest.id)) return true;
  return manifest.context?.defaultEnabled !== false;
}

/** Apply one decision, dropping the id from whichever list it was in. */
export function withDecision(decisions, id, enabled) {
  const base = decisions || noDecisions();
  const strip = (list) => (list || []).filter((entry) => entry !== id);
  const next = { enabled: strip(base.enabled), disabled: strip(base.disabled) };
  /*
    A decision that agrees with the manifest's default is recorded rather than
    dropped. Turning something back on has to survive a later change of default,
    and a file that only ever grows by one line per plugin is not a size problem.

    The id is not checked against the catalogue here: a decision about a plugin
    this build does not have is kept and never acted on, so a newer console
    talking to an older gateway does not lose somebody's setting.
  */
  if (enabled) next.enabled.push(id);
  else next.disabled.push(id);
  return next;
}

/**
 * Read the decisions out of a bucket.
 *
 * Never throws and never rejects: `{ decisions, etag, error }`, with the
 * defaults and a named `error` whenever the file could not be read or parsed.
 */
export async function readEnablement(store) {
  let object;
  try {
    object = await store.get(ENABLEMENT_KEY);
  } catch {
    return {
      decisions: noDecisions(),
      etag: null,
      // The message is ours, not the backend's: a storage error carries an
      // object key, and keys are the customer's own paths.
      error: "this context's plugin settings could not be read",
      unreachable: true,
    };
  }
  if (!object) return { decisions: noDecisions(), etag: null, error: null, absent: true };
  let text;
  try {
    text = await object.text();
  } catch {
    return {
      decisions: noDecisions(),
      etag: object.etag ?? null,
      error: "this context's plugin settings could not be read",
      unreachable: true,
    };
  }
  const { decisions, error } = parseEnablement(text);
  return {
    decisions: decisions || noDecisions(),
    etag: object.etag ?? null,
    error,
    malformed: Boolean(error),
  };
}

/**
 * Every built-in, with the switch resolved.
 *
 * Returns `{ plugins: [{ manifest, enabled }], error }` so one read answers both
 * "what does this context have" and "why does that row carry a warning".
 */
export async function resolveContextPlugins(store) {
  const state = await readEnablement(store);
  return {
    plugins: CONTEXT_PLUGINS.map((manifest) => ({
      manifest,
      enabled: pluginEnabled(manifest, state.decisions),
    })),
    decisions: state.decisions,
    etag: state.etag,
    error: state.error || null,
  };
}

/** The ids that are on right now. */
export async function enabledPluginIds(store) {
  const { plugins } = await resolveContextPlugins(store);
  return new Set(plugins.filter((entry) => entry.enabled).map((entry) => entry.manifest.id));
}

/** Raised when a conditional write lost to a concurrent one. */
export class EnablementConflict extends Error {}

/**
 * Turn one plugin on or off.
 *
 * Conditional on the etag read in the same call, so two owners toggling at once
 * cannot silently lose one of the two decisions — the same rule every other
 * read-modify-write in this gateway keeps. A store without conditional writes
 * gets an unconditional one and is not refused: the failure mode there is a
 * lost *preference*, not lost content, which is the line `forms.md` draws when
 * it refuses a submission on the same stores.
 */
export async function setPluginEnabled(store, id, enabled) {
  if (!contextPluginById(id)) throw new Error(`unknown Context plugin ${id}`);
  const state = await readEnablement(store);
  if (state.unreachable) throw new Error("this context's plugin settings could not be read");
  const next = withDecision(state.decisions, id, enabled);
  const body = renderEnablement(next);
  const conditional = store?.capabilities?.conditionalWrite === true;
  const options = conditional
    ? state.etag
      ? { onlyIf: { etagMatches: state.etag } }
      : { onlyIf: { absent: true } }
    : undefined;
  const written = await store.put(ENABLEMENT_KEY, body, options);
  if (conditional && !written) {
    throw new EnablementConflict("these plugin settings changed while you were editing them");
  }
  return next;
}

/**
 * The tool names a switch is currently holding back.
 *
 * One read answers the whole listing, which is why `tools/list` costs one
 * object GET rather than one per plugin. A context with nothing turned off
 * still pays that read; it is a single small object beside the notes, and the
 * alternative — caching per workspace in an isolate that outlives a request —
 * is the cache key that this gateway's own session module refuses for
 * credentials, for a preference that is not worth the class of bug.
 */
export async function disabledToolNames(store) {
  const { plugins } = await resolveContextPlugins(store);
  const names = new Set();
  for (const { manifest, enabled } of plugins) {
    if (enabled) continue;
    for (const tool of manifest.context.tools) names.add(tool);
  }
  return names;
}

/**
 * The refusal a call to a switched-off tool gets.
 *
 * Names the plugin and where to turn it on, because "unknown tool" is what a
 * client would otherwise report to somebody whose own settings caused it — the
 * `report.js` rule that a refusal always carries its next step, applied to the
 * one refusal an owner can undo in a single press.
 */
export function disabledToolRefusal(toolName) {
  const manifest = CONTEXT_PLUGINS.find((plugin) => plugin.context.tools.includes(toolName));
  if (!manifest) return null;
  return (
    `${manifest.name} is turned off in this context, so ${toolName} is unavailable. ` +
    "An owner can turn it back on under Settings → Plugins."
  );
}
