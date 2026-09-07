/**
 * THE ONE REACH FOR `window.desktop` — `src/bridge.ts`.
 *
 * `getDesktopBridge()` is what decides whether a person's screen offers to
 * record their machine's audio. It answers `null` in a browser, on a phone, in
 * an iframe, and on a shell it does not understand — and every one of those has
 * to be *checked*, because the failure mode is silent in both directions:
 *
 *  - too eager, and a page draws a system-audio switch and a Recording label
 *    against an object that answers nothing, so somebody holds a meeting and
 *    gets an empty note;
 *  - too strict, and the shell somebody installed becomes a browser that cannot
 *    hear the far side of their call, with no error anywhere saying why.
 *
 * So the checks below drive the whole refusal table by its reasons rather than
 * only asserting `null`, and the reference fake — the same one `apps/mobile`
 * tests against — is asserted to *pass*, which is the check that keeps the
 * validator satisfiable rather than merely strict.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `getDesktopBridge` reading `globalThis` rather than the scope it was given 42
 *   the credential-shaped-member check dropped                                 11
 *   the required-member loop dropped                                           11
 *   the sub-object (`connection`/`outbox`) member loop dropped                  7
 *   `isSupportedBridgeVersion` accepting anything `>= MIN`                      2
 *   ...the same check made own-properties-only (a prototype `getToken` passes)  1
 *   the frozen check dropped                                                    1
 *   ...accepting a non-integer version                                          0
 *
 * **The last row is a zero and it stays written down.** While
 * `MIN_BRIDGE_VERSION === BRIDGE_VERSION` the accepted range is a single
 * integer, so `Number.isInteger` cannot change any answer: `1.5` is already
 * outside `>= 1 && <= 1`. The refusal is kept because the range widens the day
 * a version 2 ships and `1.5` lands between the two — and it is recorded as
 * unreachable-today rather than left to look like a guard somebody checked.
 */

import {
  BRIDGE_VERSION,
  MIN_BRIDGE_VERSION,
  getDesktopBridge,
  inspectDesktopBridge,
  isSupportedBridgeVersion,
} from "../src/index.ts";
import { fakeDesktopBridge } from "../src/fake.ts";

const refusalFor = (desktop) => inspectDesktopBridge({ desktop }).refusal;

/** A structurally complete v1 bridge, built from plain values a test can edit. */
function bridgeLike(overrides = {}) {
  const noop = () => () => {};
  return {
    version: BRIDGE_VERSION,
    shell: { app: "Context", version: "0.0.0", platform: "macos" },
    capabilities: async () => ({}),
    startCapture: async () => ({}),
    pauseCapture: async () => {},
    resumeCapture: async () => {},
    stopCapture: async () => ({}),
    onSegment: noop,
    onLevel: noop,
    onCaptureState: noop,
    onDetection: noop,
    onTrayCommand: noop,
    connection: {
      get: async () => ({}),
      connect: () => {},
      disconnect: () => {},
      onChange: noop,
    },
    outbox: {
      status: async () => ({}),
      drain: () => {},
      onChange: noop,
    },
    ...overrides,
  };
}

const frozenBridge = (overrides = {}) => Object.freeze(bridgeLike(overrides));

export function runBridgeChecks(check) {
  // -- absence is the ordinary case, and it is not an error

  check("an empty scope has no bridge", getDesktopBridge({}) === null);
  check("...and says why", inspectDesktopBridge({}).refusal === "absent");
  check("an explicit undefined is absent", refusalFor(undefined) === "absent");
  check("...and so is null", refusalFor(null) === "absent");
  for (const value of [42, "desktop", true, Symbol("desktop")]) {
    check(
      `a ${typeof value} on window.desktop is not a bridge`,
      refusalFor(value) === "not-an-object",
    );
  }

  // -- a bridge a page could still edit is a page's own object
  //
  // The shell exposes `Object.freeze({...})` through `contextBridge`. Anything
  // mutable was put there by the document, which means a script on the page
  // decided what "recording" means. Refused.

  check("an unfrozen bridge is refused", refusalFor(bridgeLike()) === "not-frozen");
  check("...and the same object frozen is accepted", refusalFor(frozenBridge()) === null);

  // -- a page that fights back
  //
  // `window.desktop` is a property of a document, and a document can make
  // reading one throw. The answer is a refusal with a reason, never an
  // exception at the moment a screen is asking whether it is in a shell.

  check(
    "a getter that throws is a refusal, not a crash",
    (() => {
      const scope = {};
      Object.defineProperty(scope, "desktop", {
        get() {
          throw new Error("no");
        },
      });
      return inspectDesktopBridge(scope).refusal === "threw";
    })(),
  );
  check(
    "...and a bridge whose members throw on read is refused too",
    (() => {
      const hostile = new Proxy(Object.freeze(bridgeLike()), {
        get() {
          throw new Error("no");
        },
      });
      return inspectDesktopBridge({ desktop: hostile }).bridge === null;
    })(),
  );

  // -- versions

  check("this bundle understands its own version", isSupportedBridgeVersion(BRIDGE_VERSION));
  check("...and the oldest it supports", isSupportedBridgeVersion(MIN_BRIDGE_VERSION));
  check("a shell newer than this bundle is refused", !isSupportedBridgeVersion(BRIDGE_VERSION + 1));
  check("...as a version, not as a shape", refusalFor(frozenBridge({ version: BRIDGE_VERSION + 1 })) === "version-unsupported");
  check("version 0 is not a version", !isSupportedBridgeVersion(0));
  check("nor is a negative one", !isSupportedBridgeVersion(-1));
  check("nor a fraction", !isSupportedBridgeVersion(1.5));
  check("nor a numeric string, which is what a sloppy shell would send", !isSupportedBridgeVersion("1"));
  check("nor NaN", !isSupportedBridgeVersion(Number.NaN));
  check(
    "a bridge with no version at all is unreadable rather than unsupported",
    refusalFor(frozenBridge({ version: undefined })) === "version-unreadable",
  );
  check(
    "a bridge whose version is a string is refused",
    refusalFor(frozenBridge({ version: "1" })) === "version-unsupported",
  );

  // -- the surface has to be there
  //
  // Driven member by member rather than asserted once: a validator that
  // happened to check only the first name in the list would pass a single
  // hand-written case and fail every real shell that dropped a later one.

  for (const member of [
    "capabilities",
    "startCapture",
    "pauseCapture",
    "resumeCapture",
    "stopCapture",
    "onSegment",
    "onLevel",
    "onCaptureState",
    "onDetection",
    "onTrayCommand",
  ]) {
    check(
      `a bridge missing ${member} is incomplete`,
      refusalFor(frozenBridge({ [member]: undefined })) === "surface-incomplete",
    );
  }
  check(
    "a member that is present but not callable is not a member",
    refusalFor(frozenBridge({ startCapture: "yes" })) === "surface-incomplete",
  );
  check(
    "a missing connection object is incomplete",
    refusalFor(frozenBridge({ connection: undefined })) === "surface-incomplete",
  );
  for (const member of ["get", "connect", "disconnect", "onChange"]) {
    const connection = bridgeLike().connection;
    delete connection[member];
    check(
      `a connection without ${member} is incomplete`,
      refusalFor(frozenBridge({ connection })) === "surface-incomplete",
    );
  }
  for (const member of ["status", "drain", "onChange"]) {
    const outbox = bridgeLike().outbox;
    delete outbox[member];
    check(
      `an outbox without ${member} is incomplete`,
      refusalFor(frozenBridge({ outbox })) === "surface-incomplete",
    );
  }

  // -- the credential never crosses, and this is where that is enforced
  //
  // `docs/decisions/desktop.md`: "There is no `getToken` here and there must
  // not be." A shell that grew one is refused outright rather than used
  // carefully, because the page that would use it carefully is the page an
  // attacker is trying to become.

  check(
    "a bridge with a getToken is refused",
    refusalFor(frozenBridge({ getToken: async () => "secret-value" })) ===
      "credential-shaped-member",
  );
  for (const name of ["token", "accessToken", "refreshToken", "clientSecret", "credential", "password", "authorization", "cookie"]) {
    check(
      `...and one with a ${name}`,
      refusalFor(frozenBridge({ [name]: "x" })) === "credential-shaped-member",
    );
  }
  check(
    "a credential hidden on the connection object is found too",
    refusalFor(
      frozenBridge({ connection: { ...bridgeLike().connection, accessToken: "x" } }),
    ) === "credential-shaped-member",
  );
  check(
    "...and one hidden on a prototype, which is where it would be hidden",
    refusalFor(
      Object.freeze(Object.assign(Object.create({ getToken: () => "x" }), bridgeLike())),
    ) === "credential-shaped-member",
  );
  check(
    "an ordinary bridge is not tripped by the credential rule",
    refusalFor(frozenBridge()) === null,
  );

  // -- the scope is an argument, and it is honoured

  check(
    "a bridge in one scope is not visible from another",
    getDesktopBridge({ desktop: frozenBridge() }) !== null && getDesktopBridge({}) === null,
  );
  check(
    "the default scope is the global one",
    (() => {
      const bridge = frozenBridge();
      globalThis.desktop = bridge;
      try {
        return getDesktopBridge() === bridge;
      } finally {
        delete globalThis.desktop;
      }
    })(),
  );

  // -- the reference fake is a bridge
  //
  // The check that keeps this validator honest. `apps/mobile` mounts its
  // capture screen against `fakeDesktopBridge()`; if the validator refused it,
  // every desktop-mode test in that app would be testing the browser path and
  // reporting green.

  const fake = fakeDesktopBridge();
  check("the reference fake passes the validator", getDesktopBridge({ desktop: fake.bridge }) === fake.bridge);
  check("...and it is frozen, like the real one", Object.isFrozen(fake.bridge));

  // -- every subscription hands back a working unsubscribe
  //
  // The one place the new surface is deliberately not a copy of the old
  // `preload/index.ts`, whose `onState` returns nothing: a React tree mounts
  // and unmounts screens, and a handler that cannot be detached is a leak per
  // navigation and a stale closure writing into an unmounted component.

  const seen = [];
  const offs = [
    fake.bridge.onSegment((segment) => seen.push(["segment", segment])),
    fake.bridge.onLevel((level) => seen.push(["level", level])),
    fake.bridge.onCaptureState((update) => seen.push(["state", update])),
    fake.bridge.onDetection((view) => seen.push(["detection", view])),
    fake.bridge.onTrayCommand((command) => seen.push(["tray", command])),
    fake.bridge.connection.onChange((view) => seen.push(["connection", view])),
    fake.bridge.outbox.onChange((status) => seen.push(["outbox", status])),
  ];
  check("every subscription returned a function", offs.every((off) => typeof off === "function"));
  check("...and every one attached a handler", fake.listenerCount() === offs.length);

  fake.emitSegment({ id: "s-0", startMs: 0, endMs: 1, text: "hello", speaker: null, channel: "mic", confidence: null });
  fake.emitLevel({ mic: 0.5, systemAudio: 0 });
  fake.emitCaptureState({ state: "recording", capturing: true, fault: null });
  fake.emitDetection({ active: true, episode: "e1", suggestedTitle: null, sourceLabel: "Zoom", summary: "", evidence: [], degradedNotice: null, attendees: 2 });
  fake.emitTrayCommand("record");
  fake.emitConnection({ state: "connected", gateway: "https://gateway.invalid", encrypted: true, connecting: false, error: null });
  fake.emitOutbox({ pending: 2, parked: 0, lastError: null });
  check("...and every handler heard exactly one thing", seen.length === 7);

  for (const off of offs) off();
  check("unsubscribing detaches every handler", fake.listenerCount() === 0);
  fake.emitSegment({ id: "s-1", startMs: 0, endMs: 1, text: "after", speaker: null, channel: "mic", confidence: null });
  check("...and nothing is delivered afterwards", seen.length === 7);
  check(
    "unsubscribing twice is not an error",
    (() => {
      const again = fake.bridge.onSegment(() => {});
      again();
      again();
      return fake.listenerCount() === 0;
    })(),
  );
}

/** The async half of the fake's behaviour, which a synchronous check cannot see. */
export async function runBridgeAsyncChecks(check) {
  const shell = fakeDesktopBridge({ capabilities: { mic: true } });
  const started = await shell.bridge.startCapture({
    sessionId: "mtg_x",
    mic: true,
    systemAudio: true,
  });
  check("the microphone was granted, because this shell has one", started.mic === true);
  check(
    "system audio was refused, because this shell has none — the request is not echoed back",
    started.systemAudio === false,
  );

  const refusing = fakeDesktopBridge({ refuseStart: "Screen Recording permission is off" });
  let refused = null;
  try {
    await refusing.bridge.startCapture({ sessionId: "mtg_y", mic: true, systemAudio: false });
  } catch (error) {
    refused = error;
  }
  check("a shell that will not start says so by rejecting", refused !== null);

  const caps = await fakeDesktopBridge({ capabilities: { systemAudio: true } }).bridge.capabilities();
  check("a fake shell can be given a capability", caps.systemAudio === true);
  check("...and the rest are still false", caps.detection === false && caps.mic === false);

  const view = await fakeDesktopBridge().bridge.connection.get();
  check("a fresh machine is disconnected", view.state === "disconnected");
  check("...and its view carries no credential", !("token" in view) && !("accessToken" in view));
}
