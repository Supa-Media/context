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
 * Deliberately a count and a list of names rather than a row of buttons. The
 * shim reports these registrations; there is no channel to invoke one back
 * through yet (`PluginSandbox` posts the bundle and RPC responses into the
 * frame and nothing else). Drawing a pressable command would be drawing a
 * control with nothing behind it — the failure this section has refused in four
 * other places.
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
 */
export const REGISTRATION_NOTE =
  "Context can see what this plugin added but cannot run it from here yet — the sandbox reports its commands and has no way to be told to run one.";

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
