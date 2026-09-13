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

export interface RuntimeView {
  /** Absent until the owner-only query answers, and for anyone who is not the owner. */
  states?: RuntimeState[];
  loading: boolean;
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

export const REVOKED_NOTE =
  "You revoked its access, so Context stopped it. Approve it again whenever you want it back.";
