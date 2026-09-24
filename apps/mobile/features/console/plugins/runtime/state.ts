/**
 * A plugin's runtime lifecycle: whether it is actually running, and what
 * stopped it if not. Pure and React-free, split out of `../runtime.ts` — see
 * that facade for the file this used to be.
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
 * When `af685c6c` (#545) gave the guest its CodeMirror compatibility modules.
 *
 * Deliberately the merge instant rather than a generous margin after it. The
 * two ways to be wrong are not symmetric: refusing a genuine old row costs one
 * press of Start, which is exactly the behaviour this repository had before
 * #803, while admitting a forged one is the defect.
 */
const SANDBOX_COMPATIBILITY_FIX = Date.parse("2026-09-14T18:03:50Z");

/**
 * A crash the current guest can repair without asking its owner to discover
 * and press Start again.
 *
 * Runtime rows survive app deployments. That is right for a plugin whose own
 * bundle keeps throwing, but it also preserved the three failed YouVersion
 * loads from before the guest supplied its CodeMirror compatibility modules.
 * The repaired guest was therefore never tried: the durable safety stop had
 * become a durable record of code that no longer existed.
 *
 * Keep this deliberately exact. A generic crash-loop must stay stopped, and a
 * blocked row was an owner or security decision. These three module failures
 * are the complete compatibility gap fixed by the current guest, so each old
 * row gets one ordinary bounded start in this tab. If it still fails,
 * `resumed` in `useRuntime` prevents another attempt until the next visit and
 * the truthful crash row remains on screen.
 *
 * ## THE MESSAGE IS WRITTEN BY THE PLUGIN, SO THE DATE IS WHAT BOUNDS THIS
 *
 * `requireModule` is the only thing that has ever produced that sentence, and
 * since #545 the guest supplies all three of those modules — so it cannot
 * produce it any more. Every occurrence from here on is a bundle that threw
 * the text itself: `sandbox.js` sends `String(error.message).slice(0, 500)`
 * from the plugin's own load error and `reportCrash` stores it verbatim.
 *
 * Matching on the message alone therefore turns a rule meant for three known
 * old rows into a standing offer, and a crash-loop stop that any plugin can
 * lift by naming its crash correctly is not a stop — "a generic crash-loop
 * must stay stopped" is precisely what it stops being.
 *
 * So the rule is bounded by the one field in the row a plugin cannot choose:
 * `updatedAt`, written by the control plane. A row recorded after the guest
 * gained those modules is one the guest could not have written. That also
 * makes this self-expiring by construction rather than by somebody
 * remembering — no new row can ever match it, so once the old ones are gone
 * the whole predicate can be deleted.
 */
export function shouldResumeRuntime(state: RuntimeState): boolean {
  if (state.status === "loaded") return true;
  if (state.status !== "crash-looped" || state.errorCode !== "PLUGIN_LOAD_FAILED") return false;
  // `!(a < b)` rather than `a >= b`: the two differ only on a NaN timestamp,
  // where this form refuses and the tidier one admits. The control plane
  // declares `updatedAt` as `v.number()` and writes `Date.now()`, so NaN does
  // not arrive and no test can honestly stage one — the form is chosen for the
  // direction it fails in, and this note is here because the "simplification"
  // is the kind a later reader makes without knowing it picked a side.
  if (!(state.updatedAt < SANDBOX_COMPATIBILITY_FIX)) return false;
  return /^Context sandbox does not provide module: @codemirror\/(?:language|state|view)$/
    .test(state.errorMessage ?? "");
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

export function isOwnerStop(state: RuntimeState): boolean {
  return state.status === "blocked" && state.errorCode === "OWNER_DISABLED";
}

export const REVOKED_NOTE =
  "You revoked its access, so Context stopped it. Approve it again whenever you want it back.";
