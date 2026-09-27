/**
 * Shared fixtures for the console bridge suite, split out of
 * `consoleBridge.test.mjs` so each behavioural slice can stay under the
 * file-size ceiling. Not a test module itself — it exports no `run*Checks`
 * and the runner does not discover it.
 *
 * See `preloadContract.test.mjs` for the rationale this file used to carry
 * at its own top (the census, the sabotage record, and what each slice
 * checks and why).
 */

import { BRIDGE_CHANNELS } from "@context/desktop-bridge";
import { installDesktopBridge } from "../../src/core/shell/bridge.ts";
import { createConsoleBridge } from "../../src/main/consoleBridge.ts";

export const PINNED = "https://context.lc";

/* ------------------------------------------------------------------ *
 * A renderer's half of Electron: `contextBridge` and `ipcRenderer`.
 * ------------------------------------------------------------------ */

export function fakeRenderer(options = {}) {
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
export function installed(options = {}) {
  const renderer = fakeRenderer(options);
  const exposed = installDesktopBridge(renderer.host, renderer.ipc, {
    origin: options.origin ?? PINNED,
    isTopFrame: options.isTopFrame ?? true,
  }, options.speller);
  return { ...renderer, exposed, bridge: renderer.world.desktop };
}

/* ------------------------------------------------------------------ *
 * The main process's half: `ipcMain`, and the senders that reach it.
 * ------------------------------------------------------------------ */

export function fakeIpcMain() {
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
export function sender({ id = 7, url = `${PINNED}/console`, top = true } = {}) {
  const frame = { url, parent: top ? null : { url } };
  return { sender: { id }, senderFrame: frame };
}

/**
 * The hidden capture window, asking.
 *
 * A second `BrowserWindow` in this same app, loaded from `file:` — and the one
 * that holds a live microphone. It is a *different* attacker from a hostile
 * page: nothing about it is remote, its origin is not the pinned one and never
 * will be, and if identity were not checked it would be able to drive the
 * queue, the grant and the recorder it is the tape head for.
 */
export function captureWindowSender({ id = 42 } = {}) {
  return sender({ id, url: "file:///Applications/Context.app/renderer/capture.html" });
}

/**
 * An event whose live Electron getters throw, which is what a frame that went
 * away mid-call really hands a handler.
 */
export function disposedSender({ id = 7 } = {}) {
  return {
    sender: { id },
    get senderFrame() {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    },
  };
}

/** A window whose `webContents.id` the guard pins to. */
export function fakeWindow(id = 7) {
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

export const CONNECTED = Object.freeze({
  state: "connected",
  gateway: "https://gateway.invalid",
  encrypted: true,
  connecting: false,
  error: null,
});
export const QUEUE = Object.freeze({ pending: 2, parked: 0, lastError: null });

export function mainBridge(overrides = {}) {
  const calls = [];
  const written = [];
  /** Every answer the page gave about a parked machine approval. */
  const answered = [];
  /** Every `startCapture` request as the reader built it. */
  const requested = [];
  /** Every `setImessageEnabled` value the page asked for. */
  const enabledCalls = [];
  /** Every local-agent request the bridge passed through, for the checks below. */
  const asked = [];
  const window = overrides.window ?? fakeWindow();
  const ipc = fakeIpcMain();
  // A getter, because the shell moves the pin to `app://console` when it falls
  // back to the offline mirror. `overrides.pinned` lets a check move it.
  let pinned = overrides.pinned ?? PINNED;
  const bridge = createConsoleBridge({
    ipc,
    pinned: () => pinned,
    window: () => window,
    shell: () => ({ app: "Context", version: "0.1.0", platform: "macos" }),
    capabilities: () => {
      calls.push("capabilities");
      return { systemAudio: false, mic: true, detection: true, tray: true, outbox: true, connection: true };
    },
    startCapture: async (request) => {
      calls.push("startCapture");
      requested.push(request);
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
    pendingApproval: () => {
      calls.push("pendingApproval");
      return overrides.pending ?? null;
    },
    resolveApproval: (result) => {
      calls.push("resolveApproval");
      answered.push(result);
    },
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
    imessage: () => {
      calls.push("imessage");
      return overrides.imessage ?? { enabled: false, permission: "unknown", lastSyncedAt: null, lastError: null };
    },
    setImessageEnabled: (enabled) => {
      calls.push(`setImessageEnabled:${enabled}`);
      enabledCalls.push(enabled);
    },
    requestImessageFullDiskAccess: async () => void calls.push("requestImessageFullDiskAccess"),
    localAgent: () => {
      calls.push("localAgent");
      return overrides.localAgent ?? { available: false, name: null };
    },
    askLocalAgent: async (request) => {
      calls.push("askLocalAgent");
      asked.push(request);
      return overrides.localAnswer ?? { ok: true, answer: "from the CLI", provider: "claude-code", steps: [] };
    },
    ...overrides.deps,
  });
  // `movePin` is how a check stages the shell falling back to the offline
  // mirror: `consoleMirror.ts` derives the pin from the URL the window has
  // committed to, and the bridge reads it on every call.
  return {
    bridge,
    ipc,
    asked,
    window,
    calls,
    written,
    answered,
    requested,
    enabledCalls,
    movePin: (next) => {
      pinned = next;
    },
  };
}

/** Every channel the main process answers with `handle`. */
export const HANDLED = [
  BRIDGE_CHANNELS.capabilities,
  BRIDGE_CHANNELS.startCapture,
  BRIDGE_CHANNELS.pauseCapture,
  BRIDGE_CHANNELS.resumeCapture,
  BRIDGE_CHANNELS.stopCapture,
  BRIDGE_CHANNELS.connectionGet,
  BRIDGE_CHANNELS.connectionConnect,
  BRIDGE_CHANNELS.connectionDisconnect,
  BRIDGE_CHANNELS.connectionPendingApproval,
  BRIDGE_CHANNELS.connectionResolveApproval,
  BRIDGE_CHANNELS.outboxStatus,
  BRIDGE_CHANNELS.outboxDrain,
  BRIDGE_CHANNELS.meetingsWrite,
  BRIDGE_CHANNELS.imessageStatus,
  BRIDGE_CHANNELS.imessageSetEnabled,
  BRIDGE_CHANNELS.imessageRequestFullDiskAccess,
  BRIDGE_CHANNELS.agentStatus,
  BRIDGE_CHANNELS.agentAsk,
];

/** A well-formed write, so a check can vary exactly one field of it. */
export const WRITE = Object.freeze({
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
export function contamination(value, path = "$", seen = new Set()) {
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
