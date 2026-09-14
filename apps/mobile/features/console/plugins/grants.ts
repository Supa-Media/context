import { PLUGIN_CAPABILITIES } from "@context/obsidian-runtime";
import type { ConsolePlugin } from "./plugins";

/**
 * What a plugin has been allowed to do, and what it would take to change that.
 *
 * Pure and React-free, like `plugins.ts` beside it. The gateway decides whether
 * a plugin *can* run; this decides nothing — it reconciles a grant the owner
 * gave against the bundle sitting in the bucket right now, and says which of
 * four things is true about that pair.
 *
 * ## The pair is the point
 *
 * A grant is bound to an exact `bundleFingerprint`. `approvePlugin` re-scans and
 * refuses anything else, and `resolveActiveGrant` gives a runtime no authority
 * without an exact match. So a grant is never a property of *a plugin*; it is a
 * property of **a plugin at one version of its code**, and the moment the bundle
 * changes the grant stops applying to what is installed.
 *
 * That has a name on screen — `stale` — and it is deliberately not "revoked".
 * The owner revoked nothing. They answered a question about code that is no
 * longer there, and the honest report is that their answer still stands for the
 * bundle they read and does not reach the new one. Rendering that as a
 * revocation blames the reader for an update; rendering it as still-approved is
 * the security failure the fingerprint exists to prevent.
 */

/** The capability names, from the package that enforces them. Never restated here. */
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** One row of `obsidianPlugins.listPluginGrants`, as the control plane returns it. */
export interface PluginGrant {
  pluginId: string;
  bundleFingerprint: string;
  capabilities: PluginCapability[];
  networkHosts: string[];
  status: "active" | "revoked";
  grantedAt: number;
  updatedAt: number;
  revokedAt?: number;
}

export interface GrantsView {
  /** Absent while the owner-only query has not answered, or for a non-owner. */
  grants?: PluginGrant[];
  loading: boolean;
  /**
   * Whether this **deployment** has a public-only egress service configured.
   *
   * A fact about the server, not about the plugin or the person — which is why
   * it arrives from `pluginRuntimeCapabilities` rather than being inferred. A
   * self-hoster who never configured one, and this deployment until its
   * Cloudflare token gains Containers access, both sit at `false`, and the
   * console has to be honest there rather than offering a control whose only
   * outcome is `NETWORK_EGRESS_UNAVAILABLE`.
   *
   * **Defaults to false while the query is in flight.** Offering the network
   * tickbox a moment early and withdrawing it is worse than offering it a
   * moment late.
   */
  egress: boolean;
  /** Absent for anyone the server would refuse, and in the demo. */
  actions?: GrantActions;
}

export interface GrantActions {
  approve: (input: {
    pluginId: string;
    bundleFingerprint: string;
    capabilities: PluginCapability[];
    /**
     * The exact hosts to grant, and empty unless `network:request` is among the
     * capabilities — `approvePlugin` refuses the two apart, in either
     * direction, with `INVALID_NETWORK_GRANT`.
     */
    networkHosts: string[];
  }) => Promise<void>;
  revoke: (pluginId: string) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                        a plugin's standing, right now                      */
/* -------------------------------------------------------------------------- */

export type GrantStanding =
  /** Never approved, or approved and then revoked. Nothing is allowed. */
  | { kind: "none"; revokedAt?: number }
  /** Approved, and the bundle in the bucket is the one that was approved. */
  | { kind: "active"; grant: PluginGrant }
  /**
   * Approved, and the bundle changed underneath. The old answer still describes
   * the old code; the new code has no authority at all.
   */
  | { kind: "stale"; grant: PluginGrant; installed: string | null };

/**
 * Reconcile one plugin against the grants the control plane holds.
 *
 * `installed === null` — a bundle the scan could not fingerprint — is **stale**,
 * never active. An unknown fingerprint cannot be shown to match one, and the
 * direction of that guess is the whole asymmetry: guessing "match" hands
 * authority to code nobody identified.
 */
export function standingFor(
  plugin: Pick<ConsolePlugin, "id" | "bundleFingerprint">,
  grants: PluginGrant[],
): GrantStanding {
  const grant = grants.find((row) => row.pluginId === plugin.id);
  if (!grant) return { kind: "none" };
  if (grant.status === "revoked") return { kind: "none", revokedAt: grant.revokedAt };
  const installed = plugin.bundleFingerprint ?? null;
  if (installed !== null && installed === grant.bundleFingerprint) {
    return { kind: "active", grant };
  }
  return { kind: "stale", grant, installed };
}

/* -------------------------------------------------------------------------- */
/*                       what each capability lets it do                      */
/* -------------------------------------------------------------------------- */

/**
 * One sentence per capability, in the plugin owner's terms rather than the
 * protocol's.
 *
 * A `Record` over the imported union, so adding a capability to
 * `@context/obsidian-runtime` fails this file to compile rather than silently
 * producing a consent screen with a row missing.
 */
const WORDS: Record<PluginCapability, { label: string; detail: string }> = {
  "vault:read": {
    label: "Read your notes",
    detail: "Open the Markdown of any note in this context that you can see.",
  },
  "metadata:read": {
    label: "Read links and tags",
    detail: "Frontmatter, headings, tags and the links between notes.",
  },
  "vault:write": {
    label: "Create and change notes",
    detail: "Write new notes and edit existing ones. Every write is audited and etag-checked.",
  },
  "vault:rename": {
    label: "Rename and move notes",
    detail: "A rename changes where a note lives, and every link pointing at it.",
  },
  "vault:delete": {
    label: "Delete notes",
    detail:
      "Removes notes from your bucket. Turn on object versioning at your storage provider first if you want this to be recoverable.",
  },
  "settings:read": {
    label: "Read its own settings",
    detail: "Only its own file under .context/plugins/, never another plugin's.",
  },
  "settings:write": {
    label: "Save its own settings",
    detail: "Only its own file under .context/plugins/. Your vault is untouched.",
  },
  "network:request": {
    label: "Reach the hosts it names",
    detail: "Every request goes through Context's proxy, and only to hosts you approved by name.",
  },
}

export function capabilityLabel(capability: PluginCapability): string {
  return WORDS[capability].label;
}

export function capabilityDetail(capability: PluginCapability): string {
  return WORDS[capability].detail;
}

/**
 * The capabilities that destroy or move something, as opposed to reading it.
 *
 * They are not refused — a rename plugin that cannot rename is not a plugin —
 * but they are the three a consent screen has to make heavier than the rest,
 * because they are the three whose mistake a person cannot undo from here.
 */
export function isDestructive(capability: PluginCapability): boolean {
  return (
    capability === "vault:write" ||
    capability === "vault:rename" ||
    capability === "vault:delete"
  );
}

/**
 * What a fresh approval starts ticked.
 *
 * Read-only, always, whatever the plugin appears to want. The scan reports the
 * members a bundle *names*, and turning that into a pre-ticked write grant would
 * be the client deriving authority from evidence — the one thing this frontend
 * is not allowed to do. Someone raising a plugin above reading has to do it on
 * purpose.
 */
export const DEFAULT_CAPABILITIES: readonly PluginCapability[] = [
  "vault:read",
  "metadata:read",
  "settings:read",
  "settings:write",
];

/** Every capability, in the order the package lists them. */
export const ALL_CAPABILITIES: readonly PluginCapability[] = PLUGIN_CAPABILITIES;

/**
 * The capabilities a consent form may offer, given what this deployment can
 * actually enforce.
 *
 * `network:request` is the only conditional one. `approvePlugin` refuses a
 * network grant with `NETWORK_EGRESS_UNAVAILABLE` where no public-only egress
 * service is configured, so a tickbox for it there is a control whose only
 * outcome is an error — which teaches people the product is broken rather than
 * that it is careful.
 *
 * Derived from `ALL_CAPABILITIES` rather than written out, so a capability
 * added to the enforcer appears here automatically and only a deliberate
 * exclusion has to be stated.
 */
export function grantableCapabilities(egress: boolean): readonly PluginCapability[] {
  return egress
    ? ALL_CAPABILITIES
    : ALL_CAPABILITIES.filter((capability) => capability !== "network:request");
}

/* -------------------------------------------------------------------------- */
/*                            whether to offer it                             */
/* -------------------------------------------------------------------------- */

export type ApprovalOffer =
  /**
   * Approval is available. `hosts` are the exact hosts the scan read out of the
   * bundle and the only ones `approvePlugin` will accept — empty for a plugin
   * that reaches nothing, and empty *also* for one that reaches the network
   * through an address this scan could not read, which `offerNote` explains.
   */
  | { kind: "available"; hosts: string[] }
  /** Nothing to approve: the verdict cannot run here at all. */
  | { kind: "not-runnable" }
  /** The scan could not identify the bundle, so there is nothing exact to bind a grant to. */
  | { kind: "unidentified" }
  /** It runs, but reaches the network and this deployment has no egress service. */
  | { kind: "network-unavailable"; hosts: string[] };

/**
 * Whether this plugin can be approved, and if not, which honest sentence to say.
 *
 * The `network-unavailable` branch is the one worth explaining. `approvePlugin`
 * refuses a networked plugin with `NETWORK_RUNTIME_UNAVAILABLE` until a
 * DNS-pinned, public-only egress service exists — because a direct fetch cannot
 * pin DNS across resolution and connection, so an approved public host could
 * rebind to a private address. That is a fail-closed the backend chose, and the
 * frontend's job is to *not offer the control*: a button whose only outcome is
 * an error teaches people the product is broken rather than that it is careful.
 */
export function approvalOffer(
  plugin: Pick<ConsolePlugin, "verdict" | "hosts" | "bundleFingerprint">,
  egress = false,
): ApprovalOffer {
  if (plugin.verdict !== "runs" && plugin.verdict !== "needs-approval") {
    return { kind: "not-runnable" };
  }
  /*
    THE FINGERPRINT CHECK COMES FIRST, AND IT DID NOT USED TO.

    While every networked plugin was unapprovable, `needs-approval` could
    short-circuit above this and the order never mattered. With egress
    configured it decides a real question: an unidentified bundle would be
    offered approval, and a grant is bound to an exact bundle — there would be
    nothing to bind it to. The order is the guard, so it has a test rather than
    this comment alone.
  */
  if (!plugin.bundleFingerprint) return { kind: "unidentified" };
  const hosts = plugin.hosts ?? [];
  if (plugin.verdict === "needs-approval" && !egress) {
    return { kind: "network-unavailable", hosts };
  }
  return { kind: "available", hosts };
}

/** The sentence a blocked offer carries. Null where approval is available. */
export function offerNote(offer: ApprovalOffer): string | null {
  switch (offer.kind) {
    case "available":
      return null;
    case "not-runnable":
      return "There is nothing to approve: this plugin cannot run in Context.";
    case "unidentified":
      return "This bundle could not be identified, and a grant is bound to an exact bundle. Nothing can be approved until it can be read.";
    case "network-unavailable":
      return (
        "This plugin calls out to the internet, and this deployment has no egress service that can hold a host to its address for the whole of a request. " +
        "Until it does, approving it would be approving something Context cannot enforce — so there is nothing to press here yet. It keeps working in Obsidian."
      );
  }
}

/**
 * The extra sentence a *networked* plugin needs on an available offer.
 *
 * Two cases, and they are not the same:
 *
 * - Hosts were read out of the bundle. The form lists them, and this says the
 *   list is the whole of what a grant can cover — a call anywhere else is
 *   refused at request time, not quietly allowed.
 * - The bundle reaches the network through an address the scan could not read,
 *   which happens when a plugin builds its URL rather than writing it down.
 *   `approvePlugin` only accepts detected hosts, so the network capability
 *   cannot be granted at all — the plugin installs and runs with that part
 *   failing. **Saying so is the point**: this is the half-installed state, and
 *   it is honest only when somebody is told before they press.
 */
export function networkNote(offer: ApprovalOffer, verdict: string): string | null {
  if (offer.kind !== "available" || verdict !== "needs-approval") return null;
  if (offer.hosts.length === 0) {
    return (
      "This plugin reaches the internet, and Context could not read which host from its code — it builds the address as it runs. " +
      "You can approve everything else, and its calls out will be refused; it keeps working in full in Obsidian."
    );
  }
  return (
    "Only the hosts listed here can be granted, and only these. A call anywhere else is refused when it is made, " +
    "not just unapproved — and every call that is made is written to your audit trail."
  );
}

/* -------------------------------------------------------------------------- */
/*                        what the row says about a grant                     */
/* -------------------------------------------------------------------------- */

/** The chip beside a plugin that carries a grant. Null where there is none. */
export function standingPill(
  standing: GrantStanding,
): { label: string; tone: "ok" | "warn" | "neutral"; dashed: boolean } | null {
  switch (standing.kind) {
    case "none":
      return standing.revokedAt === undefined
        ? null
        : { label: "Revoked", tone: "neutral", dashed: false };
    case "active":
      return { label: "Approved", tone: "ok", dashed: false };
    case "stale":
      /*
        Dashed, like `unknown` in the inventory, and for the same reason: this is
        not the outcome of a decision somebody made. Nobody revoked anything —
        the code moved out from under an answer that still stands for the code it
        was given about.
      */
      return { label: "Needs review", tone: "warn", dashed: true };
  }
}

/** What a stale grant means, said without blaming the reader for an update. */
export const STALE_NOTE =
  "The bundle changed since you approved it. What you approved still describes the version you read; " +
  "the version now in your bucket has no access at all until you review it.";

/**
 * What a plugin will and will not notice, said where somebody is deciding to
 * run one.
 *
 * A plugin's handlers fire for changes **Context** makes. An edit in Obsidian,
 * rclone, or anything else writing to the bucket directly never passes through
 * this console, so no plugin is told about it — the product took that limit
 * deliberately on 2026-09-14 rather than building the machinery to observe a
 * bucket from outside.
 *
 * It is on the consent form rather than in a hint at the bottom of the pane
 * because of what the failure looks like from the other side: a task panel that
 * is simply *wrong* after an evening's work in Obsidian, with nothing on screen
 * to say why. Somebody who has read this sentence knows to reopen it; somebody
 * who has not has a plugin they conclude is broken.
 */
export const EVENTS_NOTE =
  "A plugin sees the changes Context makes — what you edit here, and what other plugins write. " +
  "It does not see edits you make in Obsidian or another app against the same bucket; refresh to pick those up.";
