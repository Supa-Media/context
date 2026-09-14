import { describe, expect, test } from "@jest/globals";

import {
  REGISTRATION_NOTE,
  REVOKED_NOTE,
  describeRegistrations,
  registrationsFor,
  isOwnerStop,
  isRevocation,
  rollbackTarget,
  runtimeDetail,
  runtimeFor,
  runtimeNote,
  runtimePill,
  type RuntimeState,
} from "../features/console/plugins/runtime";

/**
 * The first module in this section allowed to say a plugin is running, and
 * every check here is about not saying it anywhere else.
 *
 * A grant means *allowed*; an install means *present*; neither means *loaded*.
 * `listRuntimeStates` is the only thing that knows, because it reports what the
 * sandbox host actually did — so this module repeats the server and derives
 * nothing.
 *
 * Mutations these are written to catch:
 *
 *  - `runtimeFor` matching on the plugin id alone, so a row left by a version
 *    that is no longer installed reports a crash the current bundle never had —
 *    or reports it running;
 *  - a failure note that drops "your notes are untouched", which is the only
 *    question the reader actually has;
 *  - a revoked grant reading as a malfunction, and being offered a rollback for
 *    a version with nothing wrong with it.
 */

function state(over: Partial<RuntimeState> = {}): RuntimeState {
  return {
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    status: "loaded",
    attempts: 1,
    updatedAt: 1,
    ...over,
  };
}

const plugin = (fingerprint: string | null) => ({
  id: "highlightr-plugin",
  bundleFingerprint: fingerprint,
});

describe("a runtime row describes one bundle", () => {
  test("the installed bundle's own row is found", () => {
    expect(runtimeFor(plugin("fp-1"), [state()])?.status).toBe("loaded");
  });

  /*
    The one that matters. A row left behind by a version that is gone describes
    code that is not there, and rendering it against the new bundle reports a
    crash this bundle never had — or, worse, reports it running.
  */
  test("a row from a version that is no longer installed is not this plugin's", () => {
    expect(runtimeFor(plugin("fp-2"), [state()])).toBeNull();
  });

  test("a bundle nobody could identify matches nothing", () => {
    expect(runtimeFor(plugin(null), [state()])).toBeNull();
  });

  test("another plugin's row is not this plugin's", () => {
    expect(runtimeFor(plugin("fp-1"), [state({ pluginId: "obsidian-git" })])).toBeNull();
  });

  test("no row at all is null, never a status", () => {
    expect(runtimeFor(plugin("fp-1"), [])).toBeNull();
  });
});

describe("what each status says", () => {
  test("only a loaded row says running", () => {
    expect(runtimePill(state()).label).toBe("Running");
    expect(runtimePill(state({ status: "crash-looped" })).label).not.toMatch(/running/i);
    expect(runtimePill(state({ status: "blocked" })).label).not.toMatch(/running/i);
  });

  test("a crash loop and a block do not share a tone", () => {
    expect(runtimePill(state({ status: "crash-looped" })).tone).toBe("crit");
    expect(runtimePill(state({ status: "blocked" })).tone).toBe("warn");
  });

  /*
    The first sentence of a failure answers the only question the reader has,
    and answers it structurally rather than reassuringly.
  */
  test("every failure says the notes are untouched, and why", () => {
    for (const status of ["crash-looped", "blocked"] as const) {
      const note = runtimeNote(state({ status }));
      expect(note).toContain("untouched");
    }
    expect(runtimeNote(state({ status: "crash-looped" }))).toContain("did nothing");
  });

  test("the attempt count is counted, not printed raw", () => {
    expect(runtimeNote(state({ status: "crash-looped", attempts: 1 }))).toContain("once");
    expect(runtimeNote(state({ status: "crash-looped", attempts: 2 }))).toContain("twice");
    expect(runtimeNote(state({ status: "crash-looped", attempts: 3 }))).toContain("3 times");
  });

  test("a crash loop says Context stopped retrying rather than that it is retrying", () => {
    expect(runtimeNote(state({ status: "crash-looped", attempts: 3 }))).toContain(
      "stopped retrying",
    );
  });
});

describe("the server's own error survives", () => {
  test("a message is shown as written", () => {
    expect(runtimeDetail(state({ errorMessage: "Plugin access was revoked" }))).toBe(
      "Plugin access was revoked",
    );
  });

  /*
    A bare code is not an explanation, so it never appears as the whole of one.
  */
  test("a code with no message is given a sentence around it", () => {
    const detail = runtimeDetail(state({ errorCode: "GRANT_REVOKED" }));
    expect(detail).toContain("GRANT_REVOKED");
    expect(detail).not.toBe("GRANT_REVOKED");
  });

  test("nothing reported is nothing shown", () => {
    expect(runtimeDetail(state())).toBeNull();
  });
});

describe("a revoked grant is not a malfunction", () => {
  const revoked = state({ status: "blocked", errorCode: "GRANT_REVOKED" });

  test("it is recognised as the ordinary consequence of pressing Revoke", () => {
    expect(isRevocation(revoked)).toBe(true);
    expect(isRevocation(state({ status: "blocked", errorCode: "VERSION_BLOCKED" }))).toBe(false);
    expect(isRevocation(state({ status: "crash-looped" }))).toBe(false);
  });

  test("its note says how to undo it rather than describing a fault", () => {
    expect(REVOKED_NOTE).toContain("Approve it again");
    expect(REVOKED_NOTE).not.toMatch(/error|failed|crash/i);
  });
});

describe("stopping is not revoking", () => {
  test("the owner's stop has its own state and keeps approval reversible", () => {
    const stopped = state({ status: "blocked", errorCode: "OWNER_DISABLED" });
    expect(isOwnerStop(stopped)).toBe(true);
    expect(isRevocation(stopped)).toBe(false);
  });
});

describe("rollback is offered only where there is something to roll back to", () => {
  test("a blocked version with a recorded predecessor offers it", () => {
    expect(rollbackTarget(state({ status: "blocked", rollbackFingerprint: "fp-0" }))).toBe("fp-0");
  });

  test("a blocked version with none offers nothing", () => {
    expect(rollbackTarget(state({ status: "blocked" }))).toBeNull();
  });

  test("a crash loop is not a rollback situation", () => {
    expect(rollbackTarget(state({ status: "crash-looped", rollbackFingerprint: "fp-0" }))).toBeNull();
  });
});


/**
 * What a running plugin added to Context.
 *
 * The shim reports a command or ribbon action as the bundle registers it, and
 * before this the console dropped every one of them on the floor. Surfacing
 * them is the transparency half of "plugin commands and ribbon actions": a
 * person can see what somebody else's code put into their console.
 *
 * The half that is *not* here is invoking one, and that is a missing channel
 * rather than a missing screen — `PluginSandbox` posts the bundle and RPC
 * responses into the frame and nothing else. So these are names, not buttons.
 *
 * Mutations these catch:
 *
 *  - registrations surviving the frame that made them, so a stopped plugin
 *    still claims to have added commands;
 *  - "registered 0 commands" on every row, which buries the rows that added
 *    something;
 *  - a pressable command with nothing behind it.
 */
describe("what a running plugin added", () => {
  const command = { kind: "command" as const, id: "highlight-pink", name: "Highlight — pink" };
  const ribbon = { kind: "ribbon" as const, id: "highlightr", name: "Highlightr" };

  test("a loaded plugin reports what it registered", () => {
    expect(
      registrationsFor(state(), { "highlightr-plugin": [command, ribbon] }),
    ).toHaveLength(2);
  });

  /*
    The one that matters. A command exists while the frame that registered it
    is alive; a list outliving the frame claims the console has something it
    does not.
  */
  test("a stopped, crashed or blocked plugin reports none, whatever is left in the map", () => {
    for (const status of ["crash-looped", "blocked"] as const) {
      expect(
        registrationsFor(state({ status }), { "highlightr-plugin": [command] }),
      ).toEqual([]);
    }
  });

  test("another plugin's registrations are not this one's", () => {
    expect(registrationsFor(state(), { "obsidian-git": [command] })).toEqual([]);
  });

  test("no map at all is no registrations, not a crash", () => {
    expect(registrationsFor(state(), undefined)).toEqual([]);
  });

  test("nothing registered says nothing at all", () => {
    expect(describeRegistrations([])).toBeNull();
  });

  test("commands and ribbon actions are counted separately and pluralised", () => {
    expect(describeRegistrations([command])).toBe("Registered 1 command.");
    expect(describeRegistrations([command, { ...command, id: "b" }])).toBe("Registered 2 commands.");
    expect(describeRegistrations([command, ribbon])).toBe(
      "Registered 1 command and 1 ribbon action.",
    );
  });

  test("the note says why the names are not pressable", () => {
    expect(REGISTRATION_NOTE).toContain("cannot run it from here yet");
    expect(REGISTRATION_NOTE).not.toMatch(/error|broken|failed/i);
  });
});
