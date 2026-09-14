import { describe, expect, test } from "@jest/globals";

import {
  REGISTRATION_NOTE,
  REVOKED_NOTE,
  describeRegistrations,
  registrationsFor,
  commandOutcomeFor,
  invokeFor,
  isOwnerStop,
  isRevocation,
  rollbackTarget,
  runtimeDetail,
  runtimeFor,
  runtimeNote,
  maySeePaths,
  runtimePill,
  vaultEventForOperation,
  appliedPluginNoteWrite,
  type RuntimeState,
} from "../features/console/plugins/runtime";
import type { PluginGrant } from "../features/console/plugins/grants";

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

/*
  A plugin's own write is a change to this context exactly as a save in the
  console is, so the plugins listening have to hear about it.

  What this pins is the refusal half. Every operation this does not recognise
  has to produce nothing: a write reported as a `modify` with no version is
  worse than one not reported, because a plugin acts on it — and the next
  operation kind somebody adds arrives here as precisely that.
*/
describe("a plugin's write becomes the event the other plugins see", () => {
  const ok = (result?: Record<string, unknown>) => ({ ok: true, result: result ?? {} });

  test("a create and a modify carry the path and the new version", () => {
    expect(vaultEventForOperation({ kind: "vault.create", path: "a.md" }, ok({ etag: "e1" })))
      .toEqual({ kind: "create", path: "a.md", etag: "e1" });
    expect(vaultEventForOperation({ kind: "vault.modify", path: "a.md" }, ok({ etag: "e2" })))
      .toEqual({ kind: "modify", path: "a.md", etag: "e2" });
  });

  /*
    A delete with an etag beside it is an invitation to write over whatever
    replaced the file, so the version is dropped rather than carried.
  */
  test("a delete carries no version", () => {
    expect(vaultEventForOperation({ kind: "vault.delete", path: "a.md" }, ok({ etag: "e1" })))
      .toEqual({ kind: "delete", path: "a.md", etag: null });
  });

  test("a rename reports the new path, with the old one beside it", () => {
    expect(
      vaultEventForOperation(
        { kind: "vault.rename", from: "a.md", to: "b.md" },
        ok({ etag: "e3" }),
      ),
    ).toEqual({ kind: "rename", path: "b.md", from: "a.md", etag: "e3" });
  });

  test("a read is not a change", () => {
    expect(vaultEventForOperation({ kind: "vault.read", path: "a.md" }, ok())).toBeNull();
    expect(vaultEventForOperation({ kind: "metadata.get", path: "a.md" }, ok())).toBeNull();
    expect(vaultEventForOperation({ kind: "settings.save", path: "a.md" }, ok())).toBeNull();
  });

  test("a write the server refused changed nothing, so it reports nothing", () => {
    expect(
      vaultEventForOperation(
        { kind: "vault.modify", path: "a.md" },
        { ok: false, error: { code: "ETAG_CONFLICT", message: "someone else wrote it" } },
      ),
    ).toBeNull();
  });

  test("an unrecognised operation is silent rather than guessed at", () => {
    expect(vaultEventForOperation({ kind: "vault.obliterate", path: "a.md" }, ok())).toBeNull();
    expect(vaultEventForOperation(undefined, ok())).toBeNull();
    expect(vaultEventForOperation({ path: "a.md" }, ok())).toBeNull();
  });

  test("a write with no path, and a rename with no destination, report nothing", () => {
    expect(vaultEventForOperation({ kind: "vault.modify" }, ok({ etag: "e" }))).toBeNull();
    expect(vaultEventForOperation({ kind: "vault.rename", from: "a.md" }, ok({ etag: "e" }))).toBeNull();
  });

  test("a missing etag is null rather than undefined, so the shape never varies", () => {
    expect(vaultEventForOperation({ kind: "vault.modify", path: "a.md" }, ok()))
      .toEqual({ kind: "modify", path: "a.md", etag: null });
  });
});

describe("a successful plugin note replacement can refresh the trusted editor", () => {
  const operation = {
    kind: "vault.modify",
    path: "proof.md",
    text: "[John 3:16](https://www.bible.com/bible/1/JHN.3.16)",
    expectedEtag: "etag-1",
  };

  test("carries the exact authorized request body and both versions", () => {
    expect(appliedPluginNoteWrite(operation, { ok: true, result: { etag: "etag-2" } })).toEqual({
      path: operation.path,
      text: operation.text,
      expectedEtag: "etag-1",
      etag: "etag-2",
    });
  });

  test("a refusal, malformed version, or different operation refreshes nothing", () => {
    expect(appliedPluginNoteWrite(operation, { ok: false })).toBeNull();
    expect(appliedPluginNoteWrite(operation, { ok: true, result: {} })).toBeNull();
    expect(appliedPluginNoteWrite({ ...operation, kind: "vault.create" }, {
      ok: true,
      result: { etag: "etag-2" },
    })).toBeNull();
  });
});

/*
  Found reviewing the diff that added the active file, not by a failing test.

  The host was handing the open note's path, and the path of every write, to
  every loaded guest alike — including one approved for nothing but its own
  settings. A path is note data: that is a read the consent screen never offered
  and the RPC itself would refuse, arriving through state the host pushes rather
  than state a plugin asks for.
*/
describe("a path only reaches a plugin allowed to read notes", () => {
  const sandbox = { pluginId: "highlightr-plugin", bundleFingerprint: "fp-1" };
  const grant = (over: Partial<PluginGrant> = {}): PluginGrant => ({
    pluginId: "highlightr-plugin",
    bundleFingerprint: "fp-1",
    capabilities: ["vault:read"],
    networkHosts: [],
    status: "active",
    grantedAt: 1,
    updatedAt: 1,
    ...over,
  });

  test("reading notes is enough", () => {
    expect(maySeePaths(sandbox, [grant()])).toBe(true);
  });

  test("reading metadata is enough too, because that is the same files", () => {
    expect(maySeePaths(sandbox, [grant({ capabilities: ["metadata:read"] })])).toBe(true);
  });

  test("a plugin approved for its own settings alone is told nothing", () => {
    expect(
      maySeePaths(sandbox, [grant({ capabilities: ["settings:read", "settings:write"] })]),
    ).toBe(false);
  });

  test("writing without reading does not buy the path either", () => {
    expect(maySeePaths(sandbox, [grant({ capabilities: ["vault:write"] })])).toBe(false);
  });

  test("a revoked grant is not a grant", () => {
    expect(maySeePaths(sandbox, [grant({ status: "revoked" })])).toBe(false);
  });

  /*
    The same rule `runtimeFor` keeps: a grant for a bundle that is not the one
    running is somebody's answer about different code.
  */
  test("a grant for another bundle of the same plugin does not carry over", () => {
    expect(maySeePaths(sandbox, [grant({ bundleFingerprint: "fp-2" })])).toBe(false);
  });

  test("another plugin's grant is not this plugin's", () => {
    expect(maySeePaths(sandbox, [grant({ pluginId: "obsidian-git" })])).toBe(false);
  });

  /*
    Fail closed while the owner-only query is in flight. The alternative —
    treating "not loaded yet" as "no restriction" — leaks for exactly as long as
    the subscription takes, on every console open.
  */
  test("an unanswered grants query means nobody, not everybody", () => {
    expect(maySeePaths(sandbox, undefined)).toBe(false);
    expect(maySeePaths(sandbox, [])).toBe(false);
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

  /*
    The note now renders only where there are no controls — the demo console —
    so it has to say *that*, not that Context cannot run commands. It could,
    and one screen over it does.
  */
  test("the note explains the preview rather than claiming a missing feature", () => {
    expect(REGISTRATION_NOTE).toMatch(/preview/i);
    expect(REGISTRATION_NOTE).not.toMatch(/error|broken|failed|cannot run/i);
  });
});

/**
 * Which frame a pressed command is sent to.
 *
 * The active note and vault events are **broadcast** — every guest allowed to
 * see paths gets them. A command is the opposite: it must reach exactly the
 * plugin whose button was pressed, because delivering it to the others would
 * run whatever *they* registered under that id. The guest's own ignore-unknown-
 * id rule is a second line, not the first: two plugins can register the same
 * obvious id (`toggle`, `refresh`) without either being at fault.
 *
 * So this is routing, and it is tested as routing.
 */
describe("a pressed command reaches one frame and no other", () => {
  const frame = (pluginId: string, nonce: string) => ({ bundle: { pluginId }, nonce });
  const request = { seq: 3, pluginId: "highlightr", nonce: "nonce-1", id: "toggle" };

  test("the frame it was aimed at receives it", () => {
    expect(invokeFor(frame("highlightr", "nonce-1"), request)).toEqual({ seq: 3, id: "toggle" });
  });

  /*
    The failure this exists to prevent: a plugin that registered its own
    `toggle` running because somebody pressed a different plugin's.
  */
  test("a plugin sharing the command id does not receive it", () => {
    expect(invokeFor(frame("virtual-linker", "nonce-1"), request)).toBeUndefined();
  });

  /*
    THE RESTART CASE, and the reason a plugin id alone is not an address.

    A restart mounts a new sandbox, whose effect fires on `loaded` with the
    previous press still in the slot — so the replacement would run a command
    nobody pressed. The guest cannot refuse it: a restarted plugin registers the
    same ids it registered before, so `toggle` resolves and runs.
  */
  test("the frame that replaced it does not inherit the press", () => {
    expect(invokeFor(frame("highlightr", "nonce-2"), request)).toBeUndefined();
  });

  test("nothing pressed sends nothing", () => {
    expect(invokeFor(frame("highlightr", "nonce-1"), undefined)).toBeUndefined();
  });

  /*
    The counter has to survive routing, or a second press of the same command
    is indistinguishable from the first and the host posts nothing.
  */
  test("the sequence number is carried through so a repeat press is a repeat", () => {
    const one = frame("highlightr", "nonce-1");
    const first = invokeFor(one, { seq: 1, pluginId: "highlightr", nonce: "nonce-1", id: "toggle" });
    const again = invokeFor(one, { seq: 2, pluginId: "highlightr", nonce: "nonce-1", id: "toggle" });
    expect(first).not.toEqual(again);
    expect(again!.seq).toBe(2);
  });
});

/**
 * Pairing a command's outcome with the name it was pressed under.
 *
 * The interesting case is not the happy one. A bundle can register a different
 * set of commands across two loads, so an outcome can outlive the command it
 * describes — and attaching a failure to whichever command now sits in that
 * position is worse than showing nothing.
 */
describe("an outcome is shown against a command that still exists", () => {
  const registered = [
    { kind: "command" as const, id: "toggle", name: "Toggle highlight" },
    { kind: "ribbon" as const, id: "ribbon-0", name: "Highlight" },
  ];

  test("the name is resolved, because an id means nothing to a reader", () => {
    expect(commandOutcomeFor(registered, { id: "toggle", ok: true, error: null }))
      .toEqual({ name: "Toggle highlight", ok: true, error: null, timedOut: false });
  });

  test("a failure carries its message through", () => {
    expect(commandOutcomeFor(registered, { id: "ribbon-0", ok: false, error: "boom" }))
      .toEqual({ name: "Highlight", ok: false, error: "boom", timedOut: false });
  });

  test("no outcome is no outcome", () => {
    expect(commandOutcomeFor(registered, undefined)).toBeNull();
  });

  /*
    The regression this exists for: a result from the previous load rendered
    against this load's commands.
  */
  test("an outcome for a command this load did not register is dropped", () => {
    expect(commandOutcomeFor(registered, { id: "from-last-time", ok: false, error: "boom" }))
      .toBeNull();
  });

  test("a plugin listing nothing shows no outcome at all", () => {
    expect(commandOutcomeFor([], { id: "toggle", ok: true, error: null })).toBeNull();
  });
});
