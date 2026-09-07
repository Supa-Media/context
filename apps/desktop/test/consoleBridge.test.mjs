/**
 * THE BRIDGE, BOTH ENDS OF IT, WITH NO ELECTRON ANYWHERE.
 *
 * `window.desktop` is the only route from a page this app did not write to this
 * app's microphone, its queue and its grant. `docs/decisions/desktop.md` asks
 * for three independent guards around that, and two of them are in this file:
 * the preload's `shouldExposeBridge` (checked in `shell.test.mjs`, driven here
 * through the real installer) and **the main process re-checking the sender on
 * every channel**, which exists precisely because the first one runs inside the
 * renderer and a compromised renderer is the threat model.
 *
 * Both halves are written as pure modules over injected hosts — a
 * `contextBridge`/`ipcRenderer` pair on one side, an `ipcMain` on the other —
 * so the whole surface is exercised here rather than by launching an app and
 * pointing it at a hostile server. That is the same choice `shell.test.mjs`
 * made and it is the reason either guard is checked at all.
 *
 * ## What is checked, and why each one is not obvious
 *
 *  - **The real bridge passes the package's validator.** `getDesktopBridge()`
 *    refuses a surface that is incomplete, unfrozen, or carrying a
 *    credential-shaped member, and until this file the shell had never been run
 *    against it — the preload answered three members and was refused, which was
 *    correct and meant nothing downstream was proven.
 *  - **Every subscription detaches.** A handler that cannot be removed is a
 *    leak per navigation in a React tree and a second copy of every segment on
 *    the next meeting. The count is asserted, not the intention.
 *  - **Nothing credential-shaped crosses, on any channel.** Both directions are
 *    walked recursively — every answer the main process returns and every
 *    payload the page is handed — because "there is no `getToken`" is a
 *    property of the *payloads* as well as of the method names.
 *  - **The page cannot pass a field through.** The preload rebuilds every
 *    payload from the keys the contract declares, so a main process that grew a
 *    field does not silently start shipping it to a remote origin.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite.
 *
 *   the sender check dropped from `handle` (any webContents answered)         4
 *   the sender check keeping identity but dropping the origin comparison      2
 *   ...keeping the origin comparison but dropping the webContents identity    3
 *   the sender check dropping the top-frame test                              1
 *   `unsubscribe` returning a no-op instead of removing the listener          3
 *   the preload passing the main process's object through unnormalised        2
 *   `installDesktopBridge` exposing regardless of `shouldExposeBridge`        4
 *   the exposed object not frozen                                             3
 *   `systemAudioCapability` ignoring the probe's `false`                      1
 *   ...ignoring `packaged`, so a dev build claims a loopback tap              1
 *   `meetingWriteFrom` trusting the payload rather than reading it            1
 *   ...accepting a `kind` outside the protocol's four routes                  1
 *
 * Rows two and three are the pair that had to be measured rather than assumed:
 * the identity check and the origin check are two different refusals of two
 * different attacks — a *different window* in this app, and *this window* on a
 * page it was navigated to — and a single check standing in for both is the
 * shape that looks complete and is not. Neither is zero, so neither is
 * decoration, and neither subsumes the other.
 *
 * The unfrozen row reports three rather than one because `getDesktopBridge`
 * refuses an unfrozen bridge outright: the validator check goes red and so do
 * the two that read the object through it. That is the right shape — the
 * package's refusal is doing the work — and it is written down so nobody reads
 * one number as three independent guards.
 */

import { readFileSync } from "node:fs";
import {
  getDesktopBridge,
  inspectDesktopBridge,
  BRIDGE_CHANNELS,
  BRIDGE_CHANNEL_NAMES,
} from "@context/desktop-bridge";
import { installDesktopBridge } from "../src/core/shell/bridge.ts";
import { darwinMajorFrom, systemAudioCapability } from "../src/core/shell/capabilities.ts";
import { createConsoleBridge, isBridgeSender } from "../src/main/consoleBridge.ts";
import { CHANNELS, COMMANDS } from "../src/main/ipc.ts";

const PINNED = "https://context.lc";

/* ------------------------------------------------------------------ *
 * A renderer's half of Electron: `contextBridge` and `ipcRenderer`.
 * ------------------------------------------------------------------ */

function fakeRenderer(options = {}) {
  const listeners = new Map();
  const invoked = [];
  const sync = [];
  const world = {};

  const ipc = {
    sendSync(channel) {
      sync.push(channel);
      if (channel === BRIDGE_CHANNELS.origin) return options.pinned ?? PINNED;
      if (channel === BRIDGE_CHANNELS.shell) {
        // `in` rather than `??`, so a test can say "the main process answered
        // `null`" — which is a different fact from "the test did not say".
        return "shell" in options ? options.shell : { app: "Context", version: "0.1.0", platform: "macos" };
      }
      return null;
    },
    async invoke(channel, ...args) {
      invoked.push({ channel, args });
      if (options.rejectInvoke === true) throw new Error("Error invoking remote method 'x': boom");
      const answer = options.replies?.[channel];
      return typeof answer === "function" ? answer(...args) : answer;
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };

  const host = {
    exposeInMainWorld(key, value) {
      world[key] = value;
    },
  };

  return {
    ipc,
    host,
    world,
    invoked,
    sync,
    /** Every listener currently attached, across every channel. */
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
    emit(channel, payload) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, payload);
    },
  };
}

/** Install the bridge the way the real preload does, and hand back the object. */
function installed(options = {}) {
  const renderer = fakeRenderer(options);
  const exposed = installDesktopBridge(renderer.host, renderer.ipc, {
    origin: options.origin ?? PINNED,
    isTopFrame: options.isTopFrame ?? true,
  });
  return { ...renderer, exposed, bridge: renderer.world.desktop };
}

/* ------------------------------------------------------------------ *
 * The main process's half: `ipcMain`, and the senders that reach it.
 * ------------------------------------------------------------------ */

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeAllListeners(channel) {
      listeners.delete(channel);
    },
  };
}

/** An `IpcMainInvokeEvent`, as much of one as the guard reads. */
function sender({ id = 7, url = `${PINNED}/console`, top = true } = {}) {
  const frame = { url, parent: top ? null : { url } };
  return { sender: { id }, senderFrame: frame };
}

/** A window whose `webContents.id` the guard pins to. */
function fakeWindow(id = 7) {
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { id, send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

const CONNECTED = Object.freeze({
  state: "connected",
  gateway: "https://gateway.invalid",
  encrypted: true,
  connecting: false,
  error: null,
});
const QUEUE = Object.freeze({ pending: 2, parked: 0, lastError: null });

function mainBridge(overrides = {}) {
  const calls = [];
  const written = [];
  const window = overrides.window ?? fakeWindow();
  const ipc = fakeIpcMain();
  const bridge = createConsoleBridge({
    ipc,
    pinned: PINNED,
    window: () => window,
    shell: () => ({ app: "Context", version: "0.1.0", platform: "macos" }),
    capabilities: () => {
      calls.push("capabilities");
      return { systemAudio: false, mic: true, detection: true, tray: true, outbox: true, connection: true };
    },
    startCapture: async (request) => {
      calls.push("startCapture");
      return {
        sessionId: request.sessionId,
        mic: true,
        systemAudio: false,
        startedAtMs: 1_000,
        transcribesAt: "cloud",
        notice: null,
      };
    },
    pauseCapture: async () => void calls.push("pauseCapture"),
    resumeCapture: async () => void calls.push("resumeCapture"),
    stopCapture: async () => {
      calls.push("stopCapture");
      return { sessionId: "m_1", endedAtMs: 2_000, durationMs: 1_000, segments: 3, pending: 1 };
    },
    connection: () => {
      calls.push("connection");
      return { ...CONNECTED };
    },
    connect: () => void calls.push("connect"),
    disconnect: () => void calls.push("disconnect"),
    outbox: () => {
      calls.push("outbox");
      return { ...QUEUE };
    },
    drain: () => void calls.push("drain"),
    writeMeeting: async (write) => {
      calls.push("writeMeeting");
      written.push(write);
      return { sessionId: write.sessionId, queued: true, notePath: null, rejected: null };
    },
    ...overrides.deps,
  });
  return { bridge, ipc, window, calls, written };
}

/** Every channel the main process answers with `handle`. */
const HANDLED = [
  BRIDGE_CHANNELS.capabilities,
  BRIDGE_CHANNELS.startCapture,
  BRIDGE_CHANNELS.pauseCapture,
  BRIDGE_CHANNELS.resumeCapture,
  BRIDGE_CHANNELS.stopCapture,
  BRIDGE_CHANNELS.connectionGet,
  BRIDGE_CHANNELS.connectionConnect,
  BRIDGE_CHANNELS.connectionDisconnect,
  BRIDGE_CHANNELS.outboxStatus,
  BRIDGE_CHANNELS.outboxDrain,
  BRIDGE_CHANNELS.meetingsWrite,
];

/** A well-formed write, so a check can vary exactly one field of it. */
const WRITE = Object.freeze({
  sessionId: "mtg_abcdefghjkmnpqrstvwx",
  kind: "finalize",
  context: null,
  body: { folder: "5-meetings" },
});

/* ------------------------------------------------------------------ *
 * Walking a payload for anything credential-shaped.
 * ------------------------------------------------------------------ */

const FORBIDDEN = /token|secret|credential|password|authorization|cookie|bearer/i;

/** Every key and every string in a value, however deeply nested. */
function contamination(value, path = "$", seen = new Set()) {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && FORBIDDEN.test(value) ? [`${path} = ${value}`] : [];
  }
  if (seen.has(value)) return [];
  seen.add(value);
  const found = [];
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN.test(key)) found.push(`${path}.${key}`);
    found.push(...contamination(nested, `${path}.${key}`, seen));
  }
  return found;
}

export async function runConsoleBridgeChecks(check) {
  /* --- the preload exposes the contract, or nothing at all --------------- */

  {
    const shell = installed();
    check("the pinned origin in the top frame gets a bridge", shell.exposed === true);
    check("...on `window.desktop`, and nowhere else", Object.keys(shell.world).join() === "desktop");
    check("...frozen, as `getDesktopBridge` requires", Object.isFrozen(shell.bridge));
    check(
      "THE REAL BRIDGE PASSES THE PACKAGE'S VALIDATOR",
      getDesktopBridge({ desktop: shell.bridge }) === shell.bridge,
    );
    check(
      "...with no refusal recorded against it",
      inspectDesktopBridge({ desktop: shell.bridge }).refusal === null,
    );
    check("its sub-objects are frozen too", Object.isFrozen(shell.bridge.connection) && Object.isFrozen(shell.bridge.outbox));
  }

  check(
    "A FOREIGN ORIGIN GETS NOTHING EXPOSED AT ALL",
    installed({ origin: "https://attacker.invalid" }).exposed === false,
  );
  check(
    "a subframe on the pinned origin gets nothing exposed",
    installed({ isTopFrame: false }).exposed === false,
  );
  check(
    "a pin the main process would not answer exposes nothing",
    installed({ pinned: "" }).exposed === false,
  );
  check(
    "nothing is put on the world when the bridge is refused",
    Object.keys(installed({ origin: "https://attacker.invalid" }).world).length === 0,
  );

  /* --- the shell descriptor --------------------------------------------- */

  {
    const shell = installed();
    check("the shell is named from the main process, synchronously", shell.bridge.shell?.app === "Context");
    check("...and reports the platform the contract knows", shell.bridge.shell?.platform === "macos");
  }
  check(
    "a shell descriptor the main process would not give reads as `null`",
    installed({ shell: null }).bridge.shell === null,
  );
  check(
    "a platform this contract does not know is refused rather than passed through",
    installed({ shell: { app: "Context", version: "1", platform: "haiku" } }).bridge.shell === null,
  );

  /* --- every channel's request and response ------------------------------ */

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.capabilities]: { ok: true, value: { mic: true, systemAudio: "yes" } },
        [BRIDGE_CHANNELS.startCapture]: (request) => ({
          ok: true,
          value: {
            sessionId: request.sessionId,
            mic: true,
            systemAudio: false,
            startedAtMs: 5,
            transcribesAt: "cloud",
            notice: "only your microphone",
          },
        }),
        [BRIDGE_CHANNELS.stopCapture]: {
          ok: true,
          value: { sessionId: "m_1", endedAtMs: 9, durationMs: 4, segments: 2, pending: 1 },
        },
        [BRIDGE_CHANNELS.connectionGet]: { ok: true, value: { ...CONNECTED } },
        [BRIDGE_CHANNELS.outboxStatus]: { ok: true, value: { ...QUEUE } },
        [BRIDGE_CHANNELS.pauseCapture]: { ok: true, value: null },
        [BRIDGE_CHANNELS.resumeCapture]: { ok: true, value: null },
        [BRIDGE_CHANNELS.connectionConnect]: { ok: true, value: null },
        [BRIDGE_CHANNELS.connectionDisconnect]: { ok: true, value: null },
        [BRIDGE_CHANNELS.outboxDrain]: { ok: true, value: null },
      },
    });

    const capabilities = await shell.bridge.capabilities();
    check(
      "`capabilities()` asks the channel the package names",
      shell.invoked.some((call) => call.channel === BRIDGE_CHANNELS.capabilities),
    );
    check("...and only `true` is true, however the shell answered", capabilities.systemAudio === false && capabilities.mic === true);
    check("...with every capability the contract declares present", Object.keys(capabilities).length === 6);

    const started = await shell.bridge.startCapture({ sessionId: "m_9", mic: true, systemAudio: true });
    const startCall = shell.invoked.find((call) => call.channel === BRIDGE_CHANNELS.startCapture);
    check("`startCapture` sends the request the page made", startCall?.args[0]?.sessionId === "m_9");
    check("...as three declared fields and nothing else", Object.keys(startCall.args[0]).length === 3);
    check("...and answers with what was actually opened", started.mic === true && started.systemAudio === false);
    check("...carrying the shell's own sentence about what it is not doing", started.notice === "only your microphone");

    await shell.bridge.pauseCapture();
    await shell.bridge.resumeCapture();
    const summary = await shell.bridge.stopCapture();
    check("`stopCapture` answers a summary with counts and no audio in it", summary.segments === 2 && summary.durationMs === 4);
    check(
      "pause and resume reach their own channels",
      shell.invoked.some((c) => c.channel === BRIDGE_CHANNELS.pauseCapture) &&
        shell.invoked.some((c) => c.channel === BRIDGE_CHANNELS.resumeCapture),
    );

    const view = await shell.bridge.connection.get();
    check("`connection.get()` answers state, a base URL and two booleans", view.state === "connected" && view.gateway === "https://gateway.invalid");
    check("...and exactly the five fields the contract declares", Object.keys(view).length === 5);

    const status = await shell.bridge.outbox.status();
    check("`outbox.status()` answers counts", status.pending === 2 && status.parked === 0);

    shell.bridge.connection.connect();
    shell.bridge.connection.disconnect();
    shell.bridge.outbox.drain();
    await Promise.resolve();
    for (const channel of [
      BRIDGE_CHANNELS.connectionConnect,
      BRIDGE_CHANNELS.connectionDisconnect,
      BRIDGE_CHANNELS.outboxDrain,
    ]) {
      check(
        `the fire-and-forget verb reaches ${channel}`,
        shell.invoked.some((call) => call.channel === channel),
      );
    }
  }

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.meetingsWrite]: (write) => ({
          ok: true,
          value: {
            sessionId: write.sessionId,
            queued: false,
            notePath: "5-meetings/standup.md",
            rejected: null,
            accessToken: "sk-live-should-never-arrive",
          },
        }),
      },
    });
    const ack = await shell.bridge.meetings.write({
      sessionId: "mtg_1",
      kind: "finalize",
      context: "acme",
      body: { folder: "5-meetings" },
      cookie: "should not be forwarded",
    });
    const call = shell.invoked.find((one) => one.channel === BRIDGE_CHANNELS.meetingsWrite);
    check("`meetings.write` sends the four declared fields and nothing else", Object.keys(call.args[0]).sort().join() === "body,context,kind,sessionId");
    check("...carrying the protocol's own body untouched", call.args[0].body.folder === "5-meetings");
    check("...and the note path comes back", ack.notePath === "5-meetings/standup.md");
    check("A FIELD THE MAIN PROCESS ADDED IS NOT HANDED TO THE PAGE", contamination(ack).length === 0);
  }
  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.meetingsWrite]: {
          ok: true,
          value: {
            sessionId: "mtg_1",
            queued: false,
            notePath: null,
            rejected: { code: "meeting_forbidden", message: "your context would not take it" },
          },
        },
      },
    });
    const ack = await shell.bridge.meetings.write({ sessionId: "mtg_1", kind: "finalize", context: null, body: {} });
    check(
      "a parked meeting comes back as a refusal a person can read",
      ack.rejected?.code === "meeting_forbidden" && ack.queued === false,
    );
  }
  {
    const shell = installed();
    check(
      "the version-2 member is on the surface the shell exposes",
      typeof shell.bridge.meetings?.write === "function" && Object.isFrozen(shell.bridge.meetings),
    );
  }

  /* --- a refusal is a sentence, never Electron's own wrapper -------------- */

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.startCapture]: { ok: false, message: "This machine is not connected to a context yet." },
      },
    });
    let message = "";
    try {
      await shell.bridge.startCapture({ sessionId: "m_1", mic: true, systemAudio: false });
    } catch (error) {
      message = error.message;
    }
    check("A REFUSED CAPTURE THROWS THE SHELL'S OWN SENTENCE", message === "This machine is not connected to a context yet.");
  }

  {
    const shell = installed({ rejectInvoke: true });
    let message = "";
    try {
      await shell.bridge.startCapture({ sessionId: "m_1", mic: true, systemAudio: false });
    } catch (error) {
      message = error.message;
    }
    check("a channel nobody answers becomes a sentence, not `Error invoking remote method`", !message.includes("remote method") && message.length > 0);
    check("...and `capabilities()` answers everything false rather than rejecting", (await shell.bridge.capabilities()).mic === false);
  }

  /* --- every subscription detaches --------------------------------------- */

  {
    const shell = installed();
    const seen = [];
    const offs = [
      shell.bridge.onSegment((segment) => seen.push(segment)),
      shell.bridge.onLevel(() => seen.push("level")),
      shell.bridge.onCaptureState(() => seen.push("state")),
      shell.bridge.onDetection(() => seen.push("detection")),
      shell.bridge.onTrayCommand(() => seen.push("tray")),
      shell.bridge.connection.onChange(() => seen.push("connection")),
      shell.bridge.outbox.onChange(() => seen.push("outbox")),
    ];
    check("seven subscriptions attach seven listeners", shell.listenerCount() === 7);
    check("every one of them hands back a function", offs.every((off) => typeof off === "function"));

    shell.emit(BRIDGE_CHANNELS.segment, {
      id: "seg-1",
      startMs: 0,
      endMs: 10,
      text: "hello",
      speaker: null,
      channel: "mic",
      confidence: null,
    });
    check("a pushed segment reaches the handler", seen[0]?.text === "hello");

    for (const off of offs) off();
    check("UNSUBSCRIBING REMOVES THE IPC LISTENER — the count returns to zero", shell.listenerCount() === 0);

    const before = seen.length;
    shell.emit(BRIDGE_CHANNELS.segment, { id: "seg-2", startMs: 0, endMs: 1, text: "after", speaker: null, channel: "mic", confidence: null });
    check("...and nothing arrives after it", seen.length === before);
  }

  {
    const shell = installed();
    const off = shell.bridge.onSegment(() => {});
    off();
    off();
    check("unsubscribing twice is harmless", shell.listenerCount() === 0);
  }

  /* --- the preload rebuilds every payload -------------------------------- */

  {
    const shell = installed();
    const seen = [];
    shell.bridge.onSegment((segment) => seen.push(segment));
    shell.emit(BRIDGE_CHANNELS.segment, {
      id: "seg-1",
      startMs: 0,
      endMs: 10,
      text: "hello",
      speaker: null,
      channel: "mic",
      confidence: null,
      accessToken: "sk-live-should-never-arrive",
    });
    check(
      "A FIELD THE CONTRACT DOES NOT DECLARE NEVER REACHES THE PAGE",
      seen.length === 1 && contamination(seen[0]).length === 0,
    );
    check("...and the declared fields all arrived", seen[0].id === "seg-1" && seen[0].channel === "mic");

    const badChannel = [];
    shell.bridge.onSegment((segment) => badChannel.push(segment));
    shell.emit(BRIDGE_CHANNELS.segment, { id: "x", startMs: 0, endMs: 1, text: "t", speaker: null, channel: "elsewhere", confidence: null });
    check("a channel the contract does not know is normalised rather than passed on", badChannel[0]?.channel === "mixed");

    const trays = [];
    shell.bridge.onTrayCommand((command) => trays.push(command));
    shell.emit(BRIDGE_CHANNELS.trayCommand, "record");
    shell.emit(BRIDGE_CHANNELS.trayCommand, "launch-a-shell");
    check("a tray command outside the contract's list is dropped", trays.length === 1 && trays[0] === "record");
  }

  /* --- the main process re-checks the sender ----------------------------- */

  {
    const { ipc } = mainBridge();
    check(
      "every channel the contract names is handled or listened for",
      BRIDGE_CHANNEL_NAMES.filter(
        (name) => !ipc.handlers.has(name) && !ipc.listeners.has(name) && !name.startsWith("context:on-"),
      ).length === 0,
    );
    check("the ten asked-for channels are `handle`, not `on`", HANDLED.every((name) => ipc.handlers.has(name)));
    check(
      "the two synchronous ones are `on`",
      ipc.listeners.has(BRIDGE_CHANNELS.origin) && ipc.listeners.has(BRIDGE_CHANNELS.shell),
    );
  }

  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(sender({ id: 99 }), { sessionId: "m_1", mic: true, systemAudio: false });
      } catch {
        refusals += 1;
      }
    }
    check("A FOREIGN WEBCONTENTS IS REFUSED ON EVERY CHANNEL", refusals === HANDLED.length);
    check("...and nothing behind the bridge was asked to do anything", calls.length === 0);
  }

  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(sender({ url: "https://attacker.invalid/console" }), {
          sessionId: "m_1",
          mic: true,
          systemAudio: false,
        });
      } catch {
        refusals += 1;
      }
    }
    check(
      "THE CONSOLE WINDOW ON A PAGE WE DID NOT PIN IS REFUSED TOO",
      refusals === HANDLED.length && calls.length === 0,
    );
  }

  {
    const { ipc, calls } = mainBridge();
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender({ top: false }), {
        sessionId: "m_1",
        mic: true,
        systemAudio: false,
      });
    } catch {
      refused = true;
    }
    check("a subframe of the console window is refused", refused && calls.length === 0);
  }

  /*
    The guard on its own, for the shapes a fake `ipcMain` cannot stage.

    Every one of these is an event Electron really can hand a handler — a frame
    that has gone away mid-call, a url that is not a URL, a sender with no id —
    and every one of them has to be a refusal rather than a throw inside the
    guard, because a throw there is an unhandled rejection at the moment
    somebody presses Record.
  */
  check(
    "a sender with no frame at all is refused",
    isBridgeSender({ sender: { id: 7 } }, { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "a frame whose url is not a URL is refused rather than throwing",
    isBridgeSender(sender({ url: "not a url" }), { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "an `about:blank` frame is refused — its origin is the string `null`",
    isBridgeSender(sender({ url: "about:blank" }), { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "a suffixed lookalike origin is refused",
    isBridgeSender(sender({ url: "https://context.lc.attacker.invalid/console" }), {
      webContentsId: 7,
      pinned: PINNED,
    }) === false,
  );
  check(
    "no console window means no sender is the console window",
    isBridgeSender(sender(), { webContentsId: null, pinned: PINNED }) === false,
  );
  check(
    "an unset pin answers nobody, rather than matching an unset origin",
    isBridgeSender(sender(), { webContentsId: 7, pinned: "" }) === false,
  );
  check(
    "the console window's own top frame at the pinned origin is answered",
    isBridgeSender(sender(), { webContentsId: 7, pinned: PINNED }) === true,
  );

  {
    const { ipc } = mainBridge();
    const event = sender({ id: 99 });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("a foreign webContents is not even told the pin", event.returnValue === null);
  }

  {
    const { ipc } = mainBridge();
    const event = sender();
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("the console window is told the origin it is pinned to", event.returnValue === PINNED);
    const shellEvent = sender();
    ipc.listeners.get(BRIDGE_CHANNELS.shell)(shellEvent);
    check("...and what to call this shell", shellEvent.returnValue.app === "Context");
  }

  /* --- and answers the console window ------------------------------------ */

  {
    const { ipc, calls } = mainBridge();
    const answers = [];
    for (const channel of HANDLED) {
      const payload =
        channel === BRIDGE_CHANNELS.meetingsWrite
          ? { ...WRITE }
          : { sessionId: "m_1", mic: true, systemAudio: true };
      answers.push(await ipc.handlers.get(channel)(sender(), payload));
    }
    check("the pinned console window is answered on every channel", answers.every((answer) => answer?.ok === true));
    check("...and every verb behind it ran", calls.length === HANDLED.length);
    check(
      "NO ANSWER THE MAIN PROCESS RETURNS CARRIES ANYTHING CREDENTIAL-SHAPED",
      answers.flatMap((answer) => contamination(answer)).length === 0,
    );
  }

  {
    const { ipc } = mainBridge({
      deps: {
        startCapture: async () => {
          throw new Error("This machine is not connected to a context yet.");
        },
      },
    });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      sessionId: "m_1",
      mic: true,
      systemAudio: false,
    });
    check(
      "a verb that refused answers a sentence rather than throwing across the boundary",
      answer.ok === false && answer.message === "This machine is not connected to a context yet.",
    );
  }

  {
    const { ipc } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      sessionId: "  m_1  ",
      mic: "yes",
      systemAudio: 1,
    });
    check(
      "a request from the page is read rather than trusted — only `true` opens an input",
      answer.ok === true && answer.value.sessionId === "m_1",
    );
  }

  {
    const { ipc } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), { sessionId: "", mic: true, systemAudio: false });
    check("a capture with no meeting to file it under is refused", answer.ok === false);
  }

  /* --- the meeting is written by the machine's own grant ------------------ */

  /*
    THE VERSION-2 ADDITION, AND THE ONE THING IT MUST NOT BECOME.

    `meetings.write` is the page handing a write to this machine's queue, and
    its body is the meetings protocol's own JSON — which this file deliberately
    does not read. What stops that being a generic `invoke` is that the body
    never chooses an address: the route comes from `kind`, which is one of four
    words, and the context from `context`, which the queue checks against the
    gateway's own slug pattern. A payload that fails either is refused here
    rather than queued and discovered at drain time.
  */
  {
    const { ipc, written } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE });
    check("a well-formed write reaches the queue", answer.ok === true && written.length === 1);
    check("...as the four fields the contract declares", Object.keys(written[0]).sort().join() === "body,context,kind,sessionId");
    check("...and the ack says the shell is holding it", answer.value.queued === true);
  }
  {
    const { ipc, written } = mainBridge();
    const answers = [];
    for (const bad of [
      { ...WRITE, sessionId: "" },
      { ...WRITE, sessionId: "   " },
      { ...WRITE, kind: "enhance" },
      { ...WRITE, kind: undefined },
      { ...WRITE, body: "folder=5-meetings" },
      { ...WRITE, body: [1, 2, 3] },
      { ...WRITE, body: null },
      "not an object at all",
    ]) {
      answers.push(await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), bad));
    }
    check(
      "A WRITE THE CONTRACT DOES NOT DESCRIBE IS REFUSED, NOT QUEUED",
      answers.every((answer) => answer.ok === false) && written.length === 0,
    );
    check(
      "...with a sentence rather than a channel name",
      answers.every((answer) => !answer.message.includes("context:")),
    );
  }
  {
    const { ipc, written } = mainBridge();
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), {
      ...WRITE,
      context: "acme",
      extra: "a field nobody agreed to",
    });
    check("a context the page named is carried as a name", written[0]?.context === "acme");
    check(
      "...and a field the contract does not declare is not passed on to the queue",
      written[0] !== undefined && !("extra" in written[0]),
    );
  }
  {
    const { ipc } = mainBridge({
      deps: {
        writeMeeting: async (write) => ({
          sessionId: write.sessionId,
          queued: false,
          notePath: "5-meetings/standup.md",
          rejected: null,
        }),
      },
    });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE });
    check(
      "a finalize that reached the bucket answers with the path the gateway chose",
      answer.value.notePath === "5-meetings/standup.md",
    );
    check("...and nothing credential-shaped came back with it", contamination(answer).length === 0);
  }

  /* --- pushing to the console window ------------------------------------- */

  {
    const { bridge, window } = mainBridge();
    bridge.push({
      captureState: { state: "recording", capturing: true, fault: null },
      connection: { ...CONNECTED },
      outbox: { ...QUEUE },
      detection: null,
    });
    const channels = window.sent.map((entry) => entry.channel);
    check("a push reaches the console window on the contract's channels", channels.includes(BRIDGE_CHANNELS.captureState) && channels.includes(BRIDGE_CHANNELS.connectionChange));
    check(
      "NOTHING PUSHED TO A REMOTE ORIGIN IS CREDENTIAL-SHAPED",
      window.sent.flatMap((entry) => contamination(entry.payload)).length === 0,
    );

    bridge.emitSegment({ id: "s", startMs: 0, endMs: 1, text: "hi", speaker: null, channel: "mic", confidence: null });
    bridge.emitTrayCommand("record");
    check("segments and tray commands reach it too", window.sent.some((e) => e.channel === BRIDGE_CHANNELS.segment) && window.sent.some((e) => e.channel === BRIDGE_CHANNELS.trayCommand));
  }

  {
    const window = fakeWindow();
    window.destroyed = true;
    const { bridge } = mainBridge({ window });
    bridge.push({ captureState: { state: "idle", capturing: false, fault: null }, connection: { ...CONNECTED }, outbox: { ...QUEUE }, detection: null });
    check("a destroyed window is not sent to", window.sent.length === 0);
  }

  {
    const { bridge, ipc } = mainBridge();
    bridge.dispose();
    check("disposing removes every handler", ipc.handlers.size === 0 && ipc.listeners.size === 0);
  }

  /* --- the channel names do not collide with the old renderer's ---------- */

  {
    const old = new Set([...Object.values(COMMANDS), ...Object.values(CHANNELS)]);
    check(
      "no bridge channel shares a name with a channel the panel and notepad use",
      BRIDGE_CHANNEL_NAMES.every((name) => !old.has(name)),
    );
  }

  /*
    The bridge's capture verbs DO share three names with the hidden capture
    window's private channels, and that is safe for exactly one reason: the
    directions never meet. `main/capture.ts` only ever `webContents.send`s
    `context:capture-{start,stop,pause,resume}` at one window it owns, and the
    bridge only ever `ipcMain.handle`s them — two registries, and `send` is
    addressed to a `webContents` rather than broadcast.

    Written as a check rather than a comment because the day somebody adds an
    `ipcMain.on` or an `ipcMain.handle` to that file, the console's Pause starts
    being answered by a window holding a live microphone, and nothing else in
    this suite would notice.
  */
  {
    const source = readFileSync(new URL("../src/main/capture.ts", import.meta.url), "utf8");
    check(
      "THE HIDDEN CAPTURE WINDOW'S CHANNELS ARE SEND-ONLY, so sharing three names with the bridge cannot collide",
      !/ipcMain\.handle\s*\(/.test(source) &&
        !/ipcMain\.(on|once)\s*\(\s*CAPTURE_(START|STOP|PAUSE|RESUME)\b/.test(source),
    );
    check(
      "...and the bridge answers those three with `handle`, which is a different registry",
      HANDLED.every((name) => mainBridge().ipc.handlers.has(name)),
    );
  }

  /* --- what this build can actually do ----------------------------------- */

  check(
    "system audio is refused outright on anything but macOS",
    systemAudioCapability({ platform: "win32", packaged: true, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "AN UNPACKAGED BUILD CLAIMS NO LOOPBACK TAP — macOS will not give one to a build it has not verified",
    systemAudioCapability({ platform: "darwin", packaged: false, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "macOS older than 13 claims none either",
    systemAudioCapability({ platform: "darwin", packaged: true, darwinMajor: 21, probed: null }) === false,
  );
  check(
    "a packaged build on macOS 13 or later claims one until something asks",
    systemAudioCapability({ platform: "darwin", packaged: true, darwinMajor: 22, probed: null }) === true,
  );
  check(
    "THE PROBE OVERRULES THE GUESS — a build that was refused a tap reports none",
    systemAudioCapability({ platform: "darwin", packaged: true, darwinMajor: 24, probed: false }) === false,
  );
  check(
    "...and a build that was given one reports it, packaged or not",
    systemAudioCapability({ platform: "darwin", packaged: false, darwinMajor: 24, probed: true }) === true,
  );
  check("the Darwin major is read off `os.release()`", darwinMajorFrom("23.6.0") === 23);
  check("...and a release string this build cannot read is `0`, which is below every floor", darwinMajorFrom("") === 0);
}
