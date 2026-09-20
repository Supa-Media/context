import type { GrantStanding } from "./grants";
import type { RuntimeState } from "./runtime";
import { isOwnerStop, isRevocation } from "./runtime";
import type { ConsolePlugin } from "./plugins";

/**
 * What one plugin row says, and the one thing it offers to press.
 *
 * ## Why this exists
 *
 * The panel drew everything it knew on the row — the author's blurb, the named
 * findings, the hosts, the limitations, the notes, the scan's route out, and
 * three cards of controls underneath. Reported from a phone as "soooo much
 * jargon text; people just want to enable or disable a plugin". The fix is not
 * shorter sentences. It is that **a row answers one question and a screen
 * answers the rest** — so the row needs a decision about which of its three
 * sources gets to speak, which is this function, and the rest goes to
 * `PluginDetail`.
 *
 * ## The rule
 *
 * **A running plugin's own state outranks everything.** The scan is a reading
 * of a bundle and a grant is permission; neither is evidence about what is
 * happening now. A row saying "Needs approval" over a plugin that is running
 * would be the panel preferring its taxonomy to the facts, and the taxonomy is
 * the part the reader did not ask for.
 *
 * ## The pill is "is this on", so it is absent where there is no such answer
 *
 * A `wont-run` plugin is not off — it is not a thing that has an on. Filling
 * the pill with the verdict would repeat the group heading directly above it on
 * every row, which is the wall this whole change is undoing. It gets no pill,
 * and the heading carries the meaning it always did.
 *
 * ## One press, or a door
 *
 * Start and Stop are complete actions and happen on the row. Enabling is not:
 * it needs capabilities chosen and hosts named, and a button reading "Enable"
 * that quietly granted a default set would be the consent screen skipped. So
 * anything with a choice inside it opens the detail screen instead and ends in
 * an ellipsis, which is the one piece of punctuation carrying that difference.
 */
export interface PluginRowStatus {
  label: string;
  tone: "ok" | "warn" | "crit" | "neutral";
  /** Running right now — the only state that earns a filled dot. */
  live: boolean;
}

export type PluginRowPrimary =
  /** Complete on the row. */
  | { kind: "start"; label: string }
  | { kind: "stop"; label: string }
  /** Has a choice in it, so it opens the detail screen. */
  | { kind: "open"; label: string };

export function pluginRowSummary(options: {
  plugin: ConsolePlugin;
  /**
   * The grant, or `null` while nobody has read them yet.
   *
   * `null` is not `{ kind: "none" }` and the difference is a button: guessing
   * "never approved" before the answer arrives puts an Enable on a row that is
   * already approved, and guessing the other way hides one that is not.
   */
  standing: GrantStanding | null;
  state: RuntimeState | null;
  /**
   * Whether this console can start and stop — the runtime's own actions.
   *
   * Separate from `canGrant`, and they really do come apart: the two are
   * different views with different loading, and a member has neither. Gating
   * the door to the consent screen on the *runtime* put an Enable on no row at
   * all in a console that could approve but had no runtime yet, which is what
   * `pluginsAccess.test.ts` caught.
   */
  canPower: boolean;
  /** Whether this console can approve and revoke — the grant view's actions. */
  canGrant: boolean;
  /**
   * Whether an approval is actually on offer for this bundle — `approvalOffer`
   * coming back `available`.
   *
   * A door with nothing behind it is worse than no door. A plugin naming hosts
   * on a deployment with no egress cannot be approved at all, and a row reading
   * "Approve…" over it promises a press that can only ever land on the sentence
   * saying so. Without this the row invited everybody to find that out for
   * themselves; with it the row offers Details, which is where the reason is.
   */
  approvable: boolean;
}): { status: PluginRowStatus | null; primary: PluginRowPrimary | null } {
  const { plugin, standing, state, canPower, canGrant, approvable } = options;

  /*
    A press needs the standing either way: "Enable…" on a plugin that is already
    approved and "Start" on one that is not are the same mistake in two
    directions, and before the grants have loaded there is no way to tell which
    one this is.
  */
  const press = (primary: PluginRowPrimary): PluginRowPrimary | null => {
    if (standing === null) return null;
    if (primary.kind === "open") return canGrant && approvable ? primary : null;
    return canPower ? primary : null;
  };

  if (state !== null) {
    if (state.status === "loaded") {
      return {
        status: { label: "Running", tone: "ok", live: true },
        primary: press({ kind: "stop", label: "Stop" }),
      };
    }
    if (state.status === "crash-looped") {
      return {
        status: { label: "Stopped itself", tone: "crit", live: false },
        primary: press({ kind: "start", label: "Start again" }),
      };
    }
    /*
      A revocation is the one blocked state a Start cannot fix: there is no
      permission left to run under, so the press has to be the door to the
      consent screen rather than a button that will fail.
    */
    if (isRevocation(state)) {
      return {
        status: { label: "Off", tone: "neutral", live: false },
        primary: press({ kind: "open", label: "Enable…" }),
      };
    }
    /*
      An owner stop is the ordinary off. Anything else blocked is a fault the
      reader has not seen yet, and it keeps its warning rather than being
      flattened into the same word — "Off" on a plugin that refused to load is
      a state nobody chose reported as a choice.
    */
    if (isOwnerStop(state)) {
      return {
        status: { label: "Off", tone: "neutral", live: false },
        primary: press({ kind: "start", label: "Start" }),
      };
    }
    return {
      status: { label: "Turned off", tone: "warn", live: false },
      primary: press({ kind: "start", label: "Start again" }),
    };
  }

  if (standing !== null && standing.kind === "active") {
    return {
      status: { label: "Off", tone: "neutral", live: false },
      primary: press({ kind: "start", label: "Start" }),
    };
  }

  if (standing !== null && standing.kind === "stale") {
    return {
      status: { label: "Update needed", tone: "warn", live: false },
      primary: press({ kind: "open", label: "Review…" }),
    };
  }

  /*
    Nothing running and nothing approved, so the scan is all that is left — and
    it is the only place the verdict reaches the row at all. Two of the five
    verdicts have an on to offer; the other three have no on, so they get no
    pill and no press, and the group heading above says what they are.
  */
  if (plugin.verdict === "runs") {
    return {
      status: { label: "Off", tone: "neutral", live: false },
      primary: press({ kind: "open", label: "Enable…" }),
    };
  }
  if (plugin.verdict === "needs-approval") {
    return {
      status: { label: "Off", tone: "neutral", live: false },
      /*
        A different word from "Enable…" because a different screen is behind
        it: this one names hosts outside Context, and the press is the last
        thing standing between the reader and a consent screen they did not
        expect.
      */
      primary: press({ kind: "open", label: "Approve…" }),
    };
  }
  return { status: null, primary: null };
}

/**
 * The control that press is drawn as.
 *
 * ## Why the shape is decided here and not in the panel
 *
 * The rule above — "One press, or a door" — is the reason the list can carry a
 * switch at all, and it is a consent rule rather than a layout one. Start and
 * stop are complete: everything they need has already been granted, so a flick
 * is the whole action. Enabling is not, and a switch that quietly granted a
 * default set of folders and hosts would be the consent screen skipped by a
 * control too small to hold the question.
 *
 * So a row that ends in an ellipsis stays a button, and only the two complete
 * actions become a switch. Keeping that decision beside `pluginRowSummary`
 * means a panel cannot quietly widen it — there is one place to change, and it
 * has the argument written next to it.
 *
 * `on` is not a second reading of the runtime: it is the press inverted. A row
 * offering Stop is a row whose plugin is running, so its switch is on. That
 * equivalence is the point — a switch that consulted the runtime separately
 * could disagree with the button it replaced.
 */
export type PluginRowControl =
  | { kind: "switch"; on: boolean; action: "start" | "stop" }
  | { kind: "door"; label: string };

export function pluginRowControl(primary: PluginRowPrimary | null): PluginRowControl | null {
  if (primary === null) return null;
  if (primary.kind === "open") return { kind: "door", label: primary.label };
  return { kind: "switch", on: primary.kind === "stop", action: primary.kind };
}
