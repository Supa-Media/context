import type { PluginGrant } from "./grants";
import type { VaultEventMessage } from "./sandboxTypes";
/**
 * Whether a plugin is actually running, and what stopped it if not.
 *
 * Pure and React-free, like the three modules beside it.
 *
 * ## This is the file that earns the word "running"
 *
 * Every screen before it refused to say so, deliberately: an approved grant
 * means *allowed*, never *loaded*, and a console that read one as the other
 * would be telling somebody their plugin works on the strength of a permission
 * they granted. `listRuntimeStates` is the first thing in the product that can
 * answer the question, because it reports what the sandbox host actually did —
 * a bundle loaded, a load that failed three times, or a version Context has
 * stopped.
 *
 * So the rule the earlier modules kept by staying silent, this one keeps by
 * only ever repeating the server: nothing here derives "running" from a grant,
 * from a verdict, or from an install. A plugin with no row is not reported as
 * anything.
 */

/** One row of `obsidianPlugins.listRuntimeStates`, as the control plane returns it. */
export interface RuntimeState {
  pluginId: string;
  bundleFingerprint: string;
  status: "loaded" | "crash-looped" | "blocked";
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  /** A version Context can go back to, when a blocked one has one. */
  rollbackFingerprint?: string;
  updatedAt: number;
}

/**
 * A command or ribbon action a running plugin registered with the shim.
 *
 * It exists only while the bundle that registered it is loaded. A plugin that
 * stops takes its commands with it, and a list left on screen afterwards would
 * be claiming the console has something it does not.
 */
export interface PluginRegistration {
  kind: "command" | "ribbon";
  id: string;
  name: string;
}

export interface RuntimeView {
  /** Absent until the owner-only query answers, and for anyone who is not the owner. */
  states?: RuntimeState[];
  loading: boolean;
  /** The trusted, invisible host. Render once at console scope. */
  host?: ReactNode;
  /**
   * What each running plugin registered, keyed by plugin id.
   *
   * Held here rather than on `RuntimeState` because the two have different
   * lifetimes and different authorities: a state row is the control plane's
   * record and survives a reload, while a registration is something the
   * sandbox said in this browser tab and is gone the moment the frame is.
   */
  registrations?: Record<string, PluginRegistration[]>;
  /** Absent for anyone the server would refuse, and in the demo. */
  actions?: RuntimeActions;
}

export interface ActiveSandbox {
  bundle: import("./sandboxTypes").PluginRuntimeBundle;
  nonce: string;
  attempts: number;
}

export interface RuntimeActions {
  start: (pluginId: string, bundleFingerprint: string) => Promise<void>;
  stop: (pluginId: string, bundleFingerprint: string) => Promise<void>;
}

/**
 * This plugin's runtime row, or null.
 *
 * Matched on the plugin **and its exact bundle**, for the same reason a grant
 * is. A row left behind by a version that is no longer installed describes code
 * that is no longer there, and rendering it against the new bundle would report
 * a crash that this bundle never had — or, worse, report it loaded.
 */
export function runtimeFor(
  plugin: { id: string; bundleFingerprint: string | null },
  states: RuntimeState[],
): RuntimeState | null {
  if (plugin.bundleFingerprint === null) return null;
  return (
    states.find(
      (row) => row.pluginId === plugin.id && row.bundleFingerprint === plugin.bundleFingerprint,
    ) ?? null
  );
}

/** The chip for a runtime row. */
export function runtimePill(state: RuntimeState): {
  label: string;
  tone: "ok" | "warn" | "crit";
} {
  switch (state.status) {
    case "loaded":
      return { label: "Running", tone: "ok" };
    case "crash-looped":
      return { label: "Stopped itself", tone: "crit" };
    case "blocked":
      return { label: "Turned off", tone: "warn" };
  }
}

/**
 * What happened, in the reader's terms, and always answering the only question
 * they actually have first: whether their notes are all right.
 *
 * They are, and the reason is structural rather than reassuring — a plugin runs
 * in a sandbox with no access it was not granted, so a plugin that cannot start
 * is a plugin that did nothing. That sentence is here rather than in a component
 * because it is the one line that must not be dropped from a failure screen to
 * save space.
 */
export function runtimeNote(state: RuntimeState): string {
  switch (state.status) {
    case "loaded":
      return "Loaded and running in a sandbox of its own, with only what you approved.";
    case "crash-looped":
      return (
        `It failed to load ${countWord(state.attempts)} in a row, so Context stopped retrying rather than looping. ` +
        "Your notes are untouched: a plugin runs with no access it was not granted, so one that cannot start did nothing."
      );
    case "blocked":
      return (
        "Context turned this version off. Your notes are untouched, and the audit trail lists every write it made " +
        "before it stopped."
      );
  }
}

function countWord(attempts: number): string {
  if (attempts === 1) return "once";
  if (attempts === 2) return "twice";
  return `${attempts} times`;
}

/**
 * The version to go back to, when a blocked one names one.
 *
 * Null rather than a disabled control everywhere else, because "roll back" with
 * nothing to roll back to is a button whose precondition the reader cannot
 * satisfy — the same argument that keeps `unknown` from having an install path.
 */
export function rollbackTarget(state: RuntimeState): string | null {
  return state.status === "blocked" && state.rollbackFingerprint
    ? state.rollbackFingerprint
    : null;
}

/**
 * The server's own error, when it left one.
 *
 * `errorMessage` is written for this reader — "Plugin access was revoked" is
 * more use than anything this module could compose from a code — and the code
 * is shown beside it only when there is no message, so a bare
 * `GRANT_REVOKED` never appears as the whole explanation.
 */
export function runtimeDetail(state: RuntimeState): string | null {
  const message = state.errorMessage?.trim();
  if (message) return message;
  const code = state.errorCode?.trim();
  return code ? `The runtime reported ${code}, with no further detail.` : null;
}

/**
 * What a running plugin added to Context, in a sentence.
 *
 * Null when it added nothing — most plugins register nothing at all, and "adds
 * 0 commands" on every row is noise that makes the rows that *do* add something
 * harder to spot.
 *
 * Deliberately a count and a list of names rather than a row of buttons, and
 * the reason is narrower than it first looks. The *guest* can already run a
 * command: `sandbox.js` keeps a `commands` Map and handles an inbound
 * `{ type: "command", id }` by invoking it and answering `command-result`.
 * What is missing is the **host** half — neither `PluginSandbox` posts that
 * message nor does `sandboxTypes.ts` know the reply — so the button would have
 * nothing behind it today, which is the failure this section has refused in
 * four other places. Wiring the host half is frontend work and needs nobody's
 * permission; until it is done, these are names.
 */
export function describeRegistrations(list: PluginRegistration[]): string | null {
  if (list.length === 0) return null;
  const commands = list.filter((one) => one.kind === "command").length;
  const ribbon = list.filter((one) => one.kind === "ribbon").length;
  const parts: string[] = [];
  if (commands > 0) parts.push(plural(commands, "command", "commands"));
  if (ribbon > 0) parts.push(plural(ribbon, "ribbon action", "ribbon actions"));
  return `Registered ${parts.join(" and ")}.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The registrations to show for one plugin, and only while it is running.
 *
 * A stopped, crashed or blocked plugin reports none, whatever is still sitting
 * in the map — the map is keyed by plugin and a frame can leave without
 * clearing it, so the status is what decides, not the leftovers.
 */
export function registrationsFor(
  state: RuntimeState,
  registrations: Record<string, PluginRegistration[]> | undefined,
): PluginRegistration[] {
  if (state.status !== "loaded") return [];
  return registrations?.[state.pluginId] ?? [];
}

/**
 * Why the names are listed and nothing is pressable.
 *
 * Said once, on any plugin that registered something, because the alternative
 * is a reader wondering why a command they can see does nothing when they look
 * for it in the palette.
 *
 * The copy says what is true for the reader — Context has not wired a way to
 * run these — without claiming, as an earlier draft did, that no such channel
 * exists. One does, on the guest side; see `describeRegistrations`.
 */
export const REGISTRATION_NOTE =
  "Context can see what this plugin added but cannot run it from here yet — nothing in the console is wired to these names.";

/**
 * A revoked grant is the one "blocked" that is not a fault.
 *
 * `revokePlugin` marks the runtime row blocked with `GRANT_REVOKED`, so this
 * state is the ordinary, healthy consequence of somebody pressing Revoke. It
 * must not read as a malfunction, and it must not offer a rollback — there is
 * nothing wrong with the version.
 */
export function isRevocation(state: RuntimeState): boolean {
  return state.status === "blocked" && state.errorCode === "GRANT_REVOKED";
}

export function isOwnerStop(state: RuntimeState): boolean {
  return state.status === "blocked" && state.errorCode === "OWNER_DISABLED";
}

export const REVOKED_NOTE =
  "You revoked its access, so Context stopped it. Approve it again whenever you want it back.";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/*                    a plugin's own write, as an event                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn one successful plugin RPC into the change the other plugins are told
 * about, or `null` when it was not a change.
 *
 * Pure, and here rather than in `useRuntime`, because the decision is the part
 * worth pinning: which operations count, what path each reports, and what it
 * does with anything it does not recognise.
 *
 * **The writer's own guest is told too.** Obsidian dispatches vault events to
 * every handler including the one whose write caused them, and a shim that
 * filtered the author out would be a difference nobody could debug from inside
 * a plugin.
 *
 * Silence on anything unrecognised is the load-bearing half. An unknown write
 * reported as a `modify` with no version is worse than one not reported at all,
 * because a plugin acts on it — and a future operation kind would arrive here
 * as exactly that.
 */
export function vaultEventForOperation(
  operation: { kind?: unknown; path?: unknown; from?: unknown; to?: unknown } | undefined,
  response: unknown,
): Omit<VaultEventMessage, "seq"> | null {
  if (!operation || typeof operation.kind !== "string") return null;
  if ((response as { ok?: unknown } | null)?.ok !== true) return null;
  const etag = (response as { result?: { etag?: unknown } }).result?.etag;
  const version = typeof etag === "string" ? etag : null;
  const path = typeof operation.path === "string" ? operation.path : null;
  switch (operation.kind) {
    case "vault.create":
      return path === null ? null : { kind: "create", path, etag: version };
    case "vault.modify":
      return path === null ? null : { kind: "modify", path, etag: version };
    case "vault.delete":
      // No version: there is nothing left to hold one, and a path with a stale
      // etag beside it is an invitation to write over what replaced it.
      return path === null ? null : { kind: "delete", path, etag: null };
    case "vault.rename": {
      // Obsidian hands a rename handler the file at its *new* path and the old
      // path beside it, so `to` is the event's path and `from` is the extra.
      const to = typeof operation.to === "string" ? operation.to : null;
      if (to === null) return null;
      const from = typeof operation.from === "string" ? operation.from : undefined;
      return { kind: "rename", path: to, from, etag: version };
    }
    default:
      return null;
  }
}

/**
 * Which loaded plugins may be told the path of a note.
 *
 * **Found reviewing the diff that introduced the active file.** The host was
 * handing `active-file` and every `vault-event` to every loaded guest alike —
 * including one approved for nothing but its own settings. A plugin with no
 * vault grant cannot read a single note, and was nonetheless being told, live,
 * the path of whatever its owner had open and the path of everything they
 * edited. That is a read the consent screen never offered and the RPC would
 * refuse.
 *
 * A path is note data. So this is the same rule the RPC enforces, applied to the
 * state the host pushes rather than the state a plugin asks for: `vault:read` or
 * `metadata:read`, or nothing crosses.
 *
 * Keyed on the fingerprint as well as the id, like `runtimeFor`: a grant for a
 * bundle that is no longer the one running is not this plugin's grant.
 */
export function maySeePaths(
  sandbox: { pluginId: string; bundleFingerprint: string },
  grants: readonly PluginGrant[] | undefined,
): boolean {
  if (grants === undefined) return false;
  const grant = grants.find(
    (one) =>
      one.pluginId === sandbox.pluginId &&
      one.bundleFingerprint === sandbox.bundleFingerprint &&
      one.status === "active",
  );
  if (grant === undefined) return false;
  return grant.capabilities.includes("vault:read") || grant.capabilities.includes("metadata:read");
}
