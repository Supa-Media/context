/**
 * @jest-environment jsdom
 */

/**
 * The gap #533 named and left open, closed.
 *
 * ## What it was
 *
 * #533 shipped command invocation and said so in its own log entry: *"a command
 * that is slow or never answers shows nothing between the press and the result.
 * The honest version needs a timeout this change lacks."* #552 added one on the
 * suggestion path and #554 one on the preview path, because both are entered on
 * a keystroke and a hang there is unmissable. The command path kept none, and
 * it is the one a person actually presses.
 *
 * So pressing `Generate links` on a plugin that is thinking, wedged, or quietly
 * gone produced the same screen in all three cases: **nothing at all**, for
 * ever. No spinner, no failure, no way to tell a slow verse lookup from a dead
 * frame. The control looked broken exactly when the plugin was working.
 *
 * ## What "answered" and "did not answer" have to be kept apart
 *
 * The guest answers `command-result` either way — `ok: false` is the *plugin*
 * failing inside the sandbox and reporting it honestly, which the card already
 * renders as **"the plugin reported: …"**. A timeout is not that. Nothing
 * reported anything, and saying the plugin reported something would put words
 * in its mouth and send somebody to the wrong place to look.
 *
 * Hence `timedOut`, and a different sentence. Most of this file is about
 * keeping those two apart under the conditions that blur them: an answer that
 * arrives late, an answer for a different command, and a frame that goes away
 * mid-press.
 */

import { describe, expect, test } from "@jest/globals";
import {
  COMMAND_TIMEOUT_MS,
  commandOutcomeFor,
  commandPendingFor,
} from "../features/console/plugins/runtime";
import type { CommandOutcome, PluginRegistration } from "../features/console/plugins/runtime";

const GENERATE: PluginRegistration = {
  kind: "command",
  id: "generate-links",
  name: "Generate links",
  needsEditor: true,
};

const SYNC: PluginRegistration = {
  kind: "command",
  id: "sync-now",
  name: "Sync now",
  needsEditor: false,
};

const REGISTERED = [GENERATE, SYNC];

describe("what the card says between the press and the answer", () => {
  test("a command in flight is named, so the press is visibly doing something", () => {
    expect(commandPendingFor(REGISTERED, { id: "generate-links", seq: 1 }))
      .toEqual({ name: "Generate links" });
  });

  test("nothing pending says nothing", () => {
    expect(commandPendingFor(REGISTERED, undefined)).toBeNull();
  });

  /*
    The same rule `commandOutcomeFor` already follows one function up: a press
    survives a restart in this map, and the replacement frame may register a
    different set. A row for an id this frame does not have would name a command
    that is not there to press.
  */
  test("a command the running frame does not register is not named", () => {
    expect(commandPendingFor(REGISTERED, { id: "gone", seq: 1 })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("a timeout and a failure are different sentences", () => {
  function outcome(over: Partial<CommandOutcome> = {}): CommandOutcome {
    return { id: "generate-links", ok: false, error: "Open a note first", ...over };
  }

  /*
    The plugin answered and said it failed. This is the case that already
    worked, asserted here so the new field cannot quietly change it.
  */
  test("a plugin that reported a failure still reports it, and is not a timeout", () => {
    const shown = commandOutcomeFor(REGISTERED, outcome());
    expect(shown).toEqual({
      name: "Generate links",
      ok: false,
      error: "Open a note first",
      timedOut: false,
    });
  });

  /*
    Nothing answered. `error` is null because there is no plugin message to
    quote — the card must not say "the plugin reported" about a silence, which
    is the whole reason this is a field rather than a sentinel error string.
  */
  test("a command that never answered is a timeout with nothing quoted", () => {
    const shown = commandOutcomeFor(REGISTERED, outcome({ error: null, timedOut: true }));
    expect(shown).toEqual({
      name: "Generate links",
      ok: false,
      error: null,
      timedOut: true,
    });
  });

  test("a success is never a timeout", () => {
    const shown = commandOutcomeFor(REGISTERED, { id: "sync-now", ok: true, error: null });
    expect(shown).toEqual({ name: "Sync now", ok: true, error: null, timedOut: false });
  });

  /*
    Absence means false, the rule this codebase applied to `needsEditor` for the
    same reason: a row written before this field existed reads as an ordinary
    failure, which is exactly what it was.
  */
  test("an outcome from before this field behaves as it did", () => {
    expect(commandOutcomeFor(REGISTERED, outcome())?.timedOut).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("how long the console waits", () => {
  /*
    Far longer than the suggestion path's 1.2 seconds and the preview's eight,
    and the asymmetry is the argument: those two are entered on a keystroke with
    somebody waiting mid-word, while a command is a deliberate press whose work
    may be a network round trip per verse through the broker. Giving up early
    would report a working plugin as wedged, which is worse than the silence
    this replaces.

    Pinned as a number rather than described, because "long enough" is the whole
    property and a later edit that made it 500ms would otherwise pass.
  */
  test("the wait is long enough for a command that reaches the network", () => {
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(20000);
  });

  test("and short enough that a wedged frame is not pending for ever", () => {
    expect(COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });
});
