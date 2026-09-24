/**
 * The plugin return validators, and the result types they describe.
 *
 * Split out of `functions/files.ts`, which registers every function that uses
 * them; that file's header holds the rules they keep.
 */

import { v } from "convex/values";

const pluginVerdictValidator = v.union(
  v.literal("runs"),
  v.literal("needs-approval"),
  v.literal("files-only"),
  v.literal("wont-run"),
  v.literal("unknown"),
);

const pluginEvidenceValidator = v.object({
  id: v.string(),
  kind: v.union(
    v.literal("module"),
    v.literal("member"),
    v.literal("network"),
    v.literal("dynamic"),
    v.literal("scan"),
  ),
  reason: v.string(),
});

const pluginValidator = v.object({
  source: v.union(v.literal("obsidian"), v.literal("context")),
  folder: v.string(),
  id: v.string(),
  name: v.string(),
  version: v.string(),
  author: v.string(),
  description: v.string(),
  bundleFingerprint: v.union(v.string(), v.null()),
  isDesktopOnly: v.boolean(),
  manifestError: v.union(v.string(), v.null()),
  verdict: pluginVerdictValidator,
  evidence: v.array(pluginEvidenceValidator),
  notes: v.array(v.string()),
  limitations: v.array(v.string()),
  hosts: v.array(v.string()),
  reason: v.string(),
  supported: v.array(v.string()),
  /**
   * A Context-managed install whose id is also a folder in `.obsidian/plugins/`.
   *
   * Optional because it is only ever true: absent means "no duplicate", which
   * is every row in almost every bucket, and a boolean on all of them would be
   * a field the console has to read to learn nothing.
   */
  alsoInVault: v.optional(v.boolean()),
  /**
   * Members the shim has committed to and does not answer yet.
   *
   * Reported beside `supported` rather than folded into it, because the two are
   * different claims: `supported` says the sandbox serves this, `planned` says
   * it will. Mixing them is exactly the drift the scanner's own list had, where
   * twenty names read as implemented and threw on first call. The console does
   * not render this array directly — `limitations` already carries a sentence
   * per distinct cause — but it travels so the two halves stay auditable
   * against each other.
   */
  planned: v.array(v.string()),
});

export const pluginInventoryValidator = v.object({
  kind: v.literal("pluginInventory"),
  available: v.boolean(),
  reason: v.union(v.string(), v.null()),
  plugins: v.array(pluginValidator),
  // Convex object-validator fields are identifiers, so verdicts containing
  // hyphens must be represented as string record keys instead of object fields.
  counts: v.record(v.string(), v.number()),
  found: v.number(),
  scanned: v.number(),
  truncated: v.boolean(),
  checkedAt: v.string(),
});

/**
 * What Context installed in this bucket, without any claim about whether it runs.
 *
 * Deliberately a different shape from `pluginInventoryValidator` rather than a
 * thinner version of it. A row here carries an id, the version that was pinned
 * and where it came from — three facts read out of a pointer — and nothing
 * else. There is no verdict field to leave empty and therefore no way for a
 * console to draw this answer as though a scan had run.
 */
export const pluginManagedInstallsValidator = v.object({
  kind: v.literal("pluginManagedInstalls"),
  available: v.boolean(),
  reason: v.union(v.string(), v.null()),
  installs: v.array(
    v.object({
      id: v.string(),
      /** `null` for a pointer that names no release — corrupt, or mid-operation. */
      version: v.union(v.string(), v.null()),
      repository: v.union(v.string(), v.null()),
    }),
  ),
  truncated: v.boolean(),
  checkedAt: v.string(),
});

export const pluginSettingsValidator = v.object({
  kind: v.literal("pluginSettings"),
  json: v.string(),
  etag: v.union(v.string(), v.null()),
});

/**
 * One built-in Context plugin, resolved against this bucket's settings file.
 *
 * Flattened out of the manifest rather than passed through, because the wire
 * shape is a contract with the console and the manifest is the gateway's.
 * `offMeans` travels with the row for the same reason it exists at all: the
 * switch is only honest if the cost is on screen beside it, and a console that
 * had to keep its own copy of that sentence is a console whose copy goes stale.
 */
const contextPluginValidator = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
  version: v.string(),
  author: v.string(),
  enabled: v.boolean(),
  defaultEnabled: v.boolean(),
  tools: v.array(v.string()),
  surfaces: v.array(v.string()),
  offMeans: v.string(),
});

export const contextPluginsValidator = v.object({
  kind: v.literal("contextPlugins"),
  plugins: v.array(contextPluginValidator),
  // Why a row might not reflect what somebody set: a settings file that will
  // not parse resolves to the defaults, and saying so is the difference
  // between a console that looks wrong and one that explains itself.
  settingsError: v.union(v.string(), v.null()),
});

export const pluginManagedValidator = v.object({
  kind: v.literal("pluginManaged"),
  pluginId: v.string(),
  version: v.string(),
});

export const pluginBundleValidator = v.object({
  kind: v.literal("pluginBundle"),
  pluginId: v.string(),
  version: v.string(),
  bundleFingerprint: v.string(),
  manifestJson: v.string(),
  mainJs: v.string(),
  stylesCss: v.union(v.string(), v.null()),
});

type PluginVerdict = "runs" | "needs-approval" | "files-only" | "wont-run" | "unknown";
export type ContextPluginRow = {
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
};

export type PluginInventory = {
  available: boolean;
  reason: string | null;
  plugins: Array<{
    source: "obsidian" | "context";
    folder: string;
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    bundleFingerprint: string | null;
    isDesktopOnly: boolean;
    manifestError: string | null;
    verdict: PluginVerdict;
    evidence: Array<{
      id: string;
      kind: "module" | "member" | "network" | "dynamic" | "scan";
      reason: string;
    }>;
    notes: string[];
    limitations: string[];
    hosts: string[];
    reason: string;
    supported: string[];
    alsoInVault?: boolean;
    planned: string[];
  }>;
  counts: Record<PluginVerdict, number>;
  found: number;
  scanned: number;
  truncated: boolean;
  checkedAt: string;
};

/** What `listManagedInstalls` answers: the pointers, and no verdict about any of them. */
export type ManagedInstalls = {
  available: boolean;
  reason: string | null;
  installs: Array<{ id: string; version: string | null; repository: string | null }>;
  truncated: boolean;
  checkedAt: string;
};
