/**
 * WHAT ONE PLUGIN ROW SAYS, AND THE ONE THING IT OFFERS TO PRESS.
 *
 * The plugins panel drew everything it knew about a plugin on the row: the
 * blurb, the named findings, the hosts, the limitations, the notes, the scan's
 * route out, and three cards of controls under it. Reported from a phone as
 * "soooo much jargon text — people just want to enable or disable a plugin".
 * They are right, and the fix is not shorter sentences: it is that a row
 * answers one question and a screen answers the rest.
 *
 * This is the row's half, as a pure function, because the row's half is a
 * decision rather than a layout: which of three sources — the runtime, the
 * grant, the scan — gets to speak, and what the single press does.
 *
 * ## The rule the tests below are all instances of
 *
 * **A running plugin's own state outranks everything.** The scan is a reading
 * of a bundle, a grant is permission, and neither is evidence about what is
 * happening now. A row that said "Needs approval" over a plugin that was
 * running would be the panel preferring its taxonomy to the facts.
 *
 * ## And the press is one press or it is a door
 *
 * Start and Stop are complete actions and happen on the row. Enabling is not:
 * it needs capabilities chosen and hosts named, and a button that said
 * "Enable" and silently granted a default set would be the consent screen
 * skipped. So anything with a choice in it opens the detail screen instead,
 * and says so with an ellipsis.
 */

import { describe, expect, test } from "@jest/globals";
import { pluginRowControl, pluginRowSummary } from "../features/console/plugins/pluginRow";
import type { ConsolePlugin, PluginVerdict } from "../features/console/plugins/plugins";
import type { GrantStanding } from "../features/console/plugins/grants";
import type { RuntimeState } from "../features/console/plugins/runtime";

function pluginWith(verdict: PluginVerdict): ConsolePlugin {
  return {
    id: "obsidian-bible-reference",
    name: "Bible Reference",
    verdict,
    findings: [],
    limitations: [],
    notes: [],
    bundleFingerprint: "sha256-one",
  } as unknown as ConsolePlugin;
}

const ACTIVE: GrantStanding = {
  kind: "active",
  grant: { pluginId: "obsidian-bible-reference", bundleFingerprint: "sha256-one" },
} as unknown as GrantStanding;

const STALE: GrantStanding = {
  kind: "stale",
  grant: { pluginId: "obsidian-bible-reference", bundleFingerprint: "sha256-old" },
  installed: "sha256-one",
} as unknown as GrantStanding;

const NONE: GrantStanding = { kind: "none" };

function stateWith(
  status: RuntimeState["status"],
  errorCode?: string,
): RuntimeState {
  return {
    pluginId: "obsidian-bible-reference",
    bundleFingerprint: "sha256-one",
    status,
    attempts: 1,
    updatedAt: 0,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

/**
 * An owner of a fully loaded console: both halves available.
 *
 * Two flags rather than one because they really do come apart — the runtime
 * and the grants are different views with different loading — and collapsing
 * them put an Enable on no row at all in a console that could approve but had
 * no runtime yet.
 */
const owner = { canPower: true, canGrant: true, approvable: true };

describe("a running plugin's own state outranks the scan and the grant", () => {
  test("loaded reads Running, and the press stops it", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("needs-approval"),
      standing: ACTIVE,
      state: stateWith("loaded"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Running", tone: "ok", live: true });
    expect(summary.primary).toEqual({ kind: "stop", label: "Stop" });
  });

  /**
   * A plugin that gave up on its own is neither on nor off, and calling it
   * either would be the console reporting an outcome nobody got. It keeps its
   * own word, and the press is the one that would try again.
   */
  test("a plugin that crash-looped says so rather than reading Off", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: ACTIVE,
      state: stateWith("crash-looped"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Stopped itself", tone: "crit", live: false });
    expect(summary.primary).toEqual({ kind: "start", label: "Start again" });
  });

  test("an owner stop is Off, and the press starts it again", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: ACTIVE,
      state: stateWith("blocked", "OWNER_DISABLED"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Off", tone: "neutral", live: false });
    expect(summary.primary).toEqual({ kind: "start", label: "Start" });
  });

  /**
   * A revoked grant is the one blocked state a Start cannot fix: there is no
   * permission to run under any more. The press has to be the door to the
   * consent screen, not a button that will fail.
   */
  test("a revoked grant is Off, and the press reopens the consent screen", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: NONE,
      state: stateWith("blocked", "GRANT_REVOKED"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Off", tone: "neutral", live: false });
    expect(summary.primary).toEqual({ kind: "open", label: "Enable…" });
  });

  test("blocked for any other reason keeps the warning rather than reading Off", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: ACTIVE,
      state: stateWith("blocked", "BUNDLE_TOO_LARGE"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Turned off", tone: "warn", live: false });
    expect(summary.primary).toEqual({ kind: "start", label: "Start again" });
  });
});

describe("nothing running, so the grant answers", () => {
  test("approved and not started is Off, and one press starts it", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: ACTIVE,
      state: null,
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Off", tone: "neutral", live: false });
    expect(summary.primary).toEqual({ kind: "start", label: "Start" });
  });

  /**
   * The bundle changed under an approval that described the old code. That is
   * a consent question and never a Start: the press opens the screen where the
   * new bundle is approved.
   */
  test("a bundle that changed under its approval asks to be looked at", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: STALE,
      state: null,
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Update needed", tone: "warn", live: false });
    expect(summary.primary).toEqual({ kind: "open", label: "Review…" });
  });

  test("never approved is Off, and the press is the door rather than the deed", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: NONE,
      state: null,
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Off", tone: "neutral", live: false });
    expect(summary.primary).toEqual({ kind: "open", label: "Enable…" });
  });

  /**
   * A plugin that names hosts outside Context needs those hosts approved, and
   * the word on the button is the one thing standing between the reader and a
   * consent screen they did not expect.
   */
  test("one that calls out to the network says what the press is for", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("needs-approval"),
      standing: NONE,
      state: null,
      ...owner,
    });
    expect(summary.primary).toEqual({ kind: "open", label: "Approve…" });
  });
});

describe("a door with nothing behind it is worse than no door", () => {
  /**
   * A plugin naming hosts, on a deployment that cannot enforce egress, cannot
   * be approved at all — `approvalOffer` says `network-unavailable`. A row
   * reading "Approve…" over it promises a press that can only ever land on the
   * sentence saying so, which is a worse first answer than the one Details
   * gives.
   */
  test("a plugin that cannot be approved here is not invited to be", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("needs-approval"),
      standing: NONE,
      state: null,
      canPower: true,
      canGrant: true,
      approvable: false,
    });
    expect(summary.status).toEqual({ label: "Off", tone: "neutral", live: false });
    expect(summary.primary).toBeNull();
  });

  /** Starting is unaffected: it is not an approval and does not consult one. */
  test("but an approved plugin can still be started", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("needs-approval"),
      standing: ACTIVE,
      state: null,
      canPower: true,
      canGrant: true,
      approvable: false,
    });
    expect(summary.primary).toEqual({ kind: "start", label: "Start" });
  });
});

describe("a plugin Context cannot run has no on and no off", () => {
  /**
   * The row's pill is the answer to "is this on" — so on a plugin that has no
   * such answer it is absent rather than filled with the scan's verdict. The
   * group heading above the row already carries that, and repeating it on
   * every row is exactly the wall this change is undoing.
   */
  test.each(["files-only", "wont-run", "unknown"] as const)("%s gets no pill and no press", (verdict) => {
    const summary = pluginRowSummary({
      plugin: pluginWith(verdict),
      standing: NONE,
      state: null,
      ...owner,
    });
    expect(summary.status).toBeNull();
    expect(summary.primary).toBeNull();
  });

  /**
   * Except when it is running anyway, which `files-only` plugins are not but a
   * re-scan can make a row claim. The runtime still outranks the verdict —
   * otherwise a downgrade in the scan would silently hide a Stop from the only
   * person who can press it.
   */
  test("unless one is somehow running, which still outranks the verdict", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("wont-run"),
      standing: ACTIVE,
      state: stateWith("loaded"),
      ...owner,
    });
    expect(summary.status).toEqual({ label: "Running", tone: "ok", live: true });
    expect(summary.primary).toEqual({ kind: "stop", label: "Stop" });
  });
});

describe("somebody who cannot act is shown the state and offered nothing", () => {
  /**
   * A member sees a context's plugins and owns none of them. The row still
   * says whether one is running — that is a fact about the context they are
   * in — and offers no press at all, rather than a control that fails.
   */
  test("the pill survives and the press does not", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: ACTIVE,
      state: stateWith("loaded"),
      canPower: false,
      canGrant: false,
      approvable: true,
    });
    expect(summary.status).toEqual({ label: "Running", tone: "ok", live: true });
    expect(summary.primary).toBeNull();
  });

  /**
   * THE ONE THE RENDER TEST CAUGHT.
   *
   * A console that can approve but has no runtime yet is an ordinary state —
   * two views, two loads — and gating the door to the consent screen on the
   * runtime put an "Enable…" on no row at all. Approving is the grant view's
   * action and has nothing to do with whether anything can be started.
   */
  test("approving does not wait on a runtime, because it is not a runtime action", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: NONE,
      state: null,
      canPower: false,
      canGrant: true,
      approvable: true,
    });
    expect(summary.primary).toEqual({ kind: "open", label: "Enable…" });
  });

  /** And the converse: a runtime with no way to grant offers no door. */
  test("a console that cannot approve offers no Enable", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: NONE,
      state: null,
      canPower: true,
      canGrant: false,
      approvable: true,
    });
    expect(summary.primary).toBeNull();
  });

  /**
   * Grants not loaded yet is not the same as no grant, and guessing either way
   * puts a wrong button on the row. It reads as unknown and offers nothing
   * until the answer arrives.
   */
  test("a standing nobody has read yet offers nothing rather than Enable", () => {
    const summary = pluginRowSummary({
      plugin: pluginWith("runs"),
      standing: null,
      state: null,
      ...owner,
    });
    expect(summary.primary).toBeNull();
  });
});

/**
 * The shape the press is drawn as, which is a consent rule wearing a control.
 *
 * `pluginSwitch.test.ts` proves the panel obeys this; these four cases are the
 * rule itself, where it is cheap to state exhaustively. The mutation worth
 * catching is a widened `switch` branch: `open` becoming flickable is the
 * consent screen skipped, and it would still render, still look right, and
 * still pass every test about wording.
 */
describe("a complete action is a switch, a choice is a door", () => {
  test("stop is a switch that is on", () => {
    expect(pluginRowControl({ kind: "stop", label: "Stop" })).toEqual({
      kind: "switch",
      on: true,
      action: "stop",
    });
  });

  test("start is a switch that is off", () => {
    expect(pluginRowControl({ kind: "start", label: "Start" })).toEqual({
      kind: "switch",
      on: false,
      action: "start",
    });
  });

  /*
    Both doors, and both by name: "Enable…" and "Approve…" reach different
    screens, and neither is a flick. A test naming only one of them would go
    green on a mutation that special-cased the other.
  */
  test("every opening press stays a door, and keeps its own word", () => {
    expect(pluginRowControl({ kind: "open", label: "Enable…" })).toEqual({
      kind: "door",
      label: "Enable…",
    });
    expect(pluginRowControl({ kind: "open", label: "Approve…" })).toEqual({
      kind: "door",
      label: "Approve…",
    });
  });

  test("a row with no press has no control", () => {
    expect(pluginRowControl(null)).toBeNull();
  });
});
