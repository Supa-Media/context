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
 *   the sender check dropped from `handle` (any webContents answered)         9
 *   the sender check keeping identity but dropping the origin comparison      4
 *   ...keeping the origin comparison but dropping the webContents identity    4
 *   the sender check dropping the top-frame test                              2
 *   `unsubscribe` returning a no-op instead of removing the listener          3
 *   the preload passing the main process's object through unnormalised        2
 *   `installDesktopBridge` exposing regardless of `shouldExposeBridge`        4
 *   the exposed object not frozen                                             3
 *   `systemAudioCapability` ignoring the probe's `false`                      1
 *   ...ignoring `packaged`, so a dev build claims a loopback tap              1
 *   ...ignoring `signed`, so an unsigned packaged build claims one            1
 *   the guard reading Electron's live getters unprotected again               1
 *   a synchronous channel letting its own answer throw                        1
 *   the bridge taking a hidden-capture-window channel name back               1
 *   the closed console window leaving its handlers registered                 1
 *   `meetingWriteFrom` trusting the payload rather than reading it            1
 *   ...accepting a `kind` outside the protocol's four routes                  1
 *   the preload defaulting an unknown `kind` to `session`                     2
 *   an empty `context` read as this machine's own, in the main process        1
 *   ...and in the preload                                                     1
 *   the bridge capturing the pin once instead of reading it per call         3
 *   the sender check reading `app://console` as an opaque origin             1
 *   the sender check accepting an opaque origin while the mirror is pinned  1
 *
 * Four of these were measured before `#281` added three mirror checks and are
 * re-measured here on the head that carries them: the whole-guard row was 6,
 * the origin row 2 and the top-frame row 1. **A number in a table is a claim
 * about a tree, and somebody else's merge is enough to falsify it.**
 *
 * The identity row is 4 rather than 3 since the hidden capture window was
 * added as an attacker in its own right: it is the second window in this
 * process, it holds a live microphone, and "one of ours" is not a reason to
 * answer it.
 *
 * The last three rows are one rule with two boundaries: `kind` is a route and
 * `context` is a bucket, and a value either boundary *repairs* is a value the
 * guard that owns the queue never gets to refuse. A default of `session` posts
 * a body to a collection nobody named; reading `""` as "no context" files a
 * meeting in whatever context the credential defaults to.
 *
 * Rows two and three are the pair that had to be measured rather than assumed:
 * the identity check and the origin check are two different refusals of two
 * different attacks — a *different window* in this app, and *this window* on a
 * page it was navigated to — and a single check standing in for both is the
 * shape that looks complete and is not. Neither is zero, so neither is
 * decoration, and neither subsumes the other.
 *
 * The three `app://console` rows are about the offline mirror moving the pin. A bridge that
 * read `deps.pinned()` once would keep trusting the live origin after the shell
 * had fallen back to `app://console` — and answer the page it is itself serving
 * with nothing. The second row is subtler and cost an afternoon: **Node's `URL`
 * answers `"null"` for `app://console/...`**, because nothing told it the scheme
 * is standard, while Chromium — which `registerSchemesAsPrivileged` did tell —
 * reports `location.origin` as `app://console`. Written as `new URL(...).origin`
 * the sender check reads the mirrored console as an opaque origin and refuses
 * it; `originOfUrl` is the one place that difference is reconciled. The third
 * is the other side of that reconciliation: `app://console` is a real origin
 * here, `"null"` is not one, and a `data:` or `about:blank` document reporting
 * the second must not be answered while the first is what is pinned.
 *
 * The unfrozen row reports three rather than one because `getDesktopBridge`
 * refuses an unfrozen bridge outright: the validator check goes red and so do
 * the two that read the object through it. That is the right shape — the
 * package's refusal is doing the work — and it is written down so nobody reads
 * one number as three independent guards.
 */

import { readdirSync, readFileSync } from "node:fs";
import {
  getDesktopBridge,
  inspectDesktopBridge,
  BRIDGE_CHANNELS,
  BRIDGE_CHANNEL_NAMES,
} from "@context/desktop-bridge";
import { installDesktopBridge } from "../src/core/shell/bridge.ts";
import { darwinMajorFrom, systemAudioCapability } from "../src/core/shell/capabilities.ts";
import { createConsoleBridge, isBridgeSender } from "../src/main/consoleBridge.ts";
import { MIRROR_ORIGIN } from "../src/core/shell/mirror.ts";
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

/**
 * The hidden capture window, asking.
 *
 * A second `BrowserWindow` in this same app, loaded from `file:` — and the one
 * that holds a live microphone. It is a *different* attacker from a hostile
 * page: nothing about it is remote, its origin is not the pinned one and never
 * will be, and if identity were not checked it would be able to drive the
 * queue, the grant and the recorder it is the tape head for.
 */
function captureWindowSender({ id = 42 } = {}) {
  return sender({ id, url: "file:///Applications/Context.app/renderer/capture.html" });
}

/**
 * An event whose live Electron getters throw, which is what a frame that went
 * away mid-call really hands a handler.
 */
function disposedSender({ id = 7 } = {}) {
  return {
    sender: { id },
    get senderFrame() {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    },
  };
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
  /** Every answer the page gave about a parked machine approval. */
  const answered = [];
  /** Every `startCapture` request as the reader built it. */
  const requested = [];
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
    ...overrides.deps,
  });
  // `movePin` is how a check stages the shell falling back to the offline
  // mirror: `consoleMirror.ts` derives the pin from the URL the window has
  // committed to, and the bridge reads it on every call.
  return {
    bridge,
    ipc,
    window,
    calls,
    written,
    answered,
    requested,
    movePin: (next) => {
      pinned = next;
    },
  };
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
  BRIDGE_CHANNELS.connectionPendingApproval,
  BRIDGE_CHANNELS.connectionResolveApproval,
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
  /*
    THE CENSUS: every `ipcMain` in this app, and how many are gated.
    ---------------------------------------------------------------------------

    A guard checks the channels it is on. Nothing checked whether a NEW channel
    had appeared beside them — and this app grew its IPC surface three times in
    a day.

    EVERY EARLIER SHAPE OF IT WAS A LOWER BOUND WEARING AN EQUALS SIGN, and
    the count of shapes is deliberately not written down here: three separate
    numbers for it were live in this file and in `docs/decisions/desktop.md` at
    once, which is the same staleness this census exists to catch, in the prose
    describing the census.

    The first read three files and one syntax. Measured, three forms grew the
    surface at 784 PASS / 0 FAIL: a registration in a file it did not read,
    `ipcMain` split across lines before `.on`, and `ipcMain.on.bind(ipcMain)`.

    The second accounted for every mention of the identifier, but classified
    "followed by `,` or `}`" as an import specifier — so `register(ipcMain, ch)`,
    `{ ipc: ipcMain }` and `Reflect.get(ipcMain, "on")` were all read as imports
    and passed at 905 / 0. `index.ts` already contains such a mention. It also
    stripped comments with a regex that a `//` inside a string literal fooled
    into eating the registration on the same line — a stripper whose failure
    direction is "delete the evidence" rather than "flag it".

    So: strings are removed before comments (a lexer, not a regex, because the
    two mislead each other), imports are removed as whole clauses rather than
    guessed at from punctuation, and every `ipcMain` that survives must be a
    form named here — a registration, a teardown, or the single hand-off to
    `createConsoleBridge`, which is itself counted so it cannot become two.
    Everything else reddens, including forms nobody predicted. MEASURED at
    baseline 906: a plain new `ipcMain.on` reddens 2, a registration in a new
    subdirectory with a new extension 2, a `//`-inside-a-string hiding place 2,
    and each of `.bind`, an argument, an object property and `Reflect.get`
    reddens 1 — with the offending mention named in the failure, because a
    census that says only "the number moved" leaves somebody grepping.

    An `import { ipcMain as … }` rename reddens, by name. An earlier version of
    this comment said it reddened nothing and called that legitimate — the hole
    described as the feature, which the block below already says in its own
    words while this sentence went on contradicting it.

    Recursive, and over every extension the bundler will load, because "under
    `src/main`" is what the sentence says and a non-recursive `.ts`-only scan is
    not that.

    What it is honest about: the fifteen `ipcMain` registrations are ungated,
    and they are safe because every window whose preload can send them loads
    this app's own HTML — not because their preload cannot send.
    `preload/index.ts` exposes twelve send verbs, `record` and `connect` among
    them.
  */
  {
    /*
      TWO SCOPES, BECAUSE THE TWO CHECKS CAN DO DIFFERENT THINGS.

      The raw count walks all of `src/` and the bundled packages with it: a
      registration in `src/core/` was measured invisible simply because the
      directory was not walked, and so was one in `packages/desktop-bridge/src/`,
      which esbuild pulls into this same bundle. A main-process module landing
      one level out is an accident rather than an attack. Counting bytes works
      anywhere, so there is no reason to stop at a boundary nobody maintains.

      The lexed classification stays on `src/main`, where it was written and
      where every mention is a registration, a teardown, an import or the
      hand-off. Pointed at `src/core` it reports `contract.ts` as ending mid
      block-comment — a lexer bug, on a file with no `ipcMain` in it at all, and
      the fourth time this lexer has been wrong about something. It is the
      diagnostic; the count is the guard.
    */
    const srcDir = new URL("../src/", import.meta.url);
    const mainDir = new URL("../src/main/", import.meta.url);
    /*
      THE WALK IS THE BUNDLE, NOT THE DIRECTORY, and it took a review to say so.
      `packages/desktop-bridge` and `packages/meetings` are imported by
      `main/consoleBridge.ts` and `main/index.ts`, so esbuild pulls them into the
      main-process bundle and a registration written in one is a registration in
      the main process. Pointed at `src/` alone this census could not see them —
      the same accident as "a main-process module one directory out of
      `src/main`", which is what widening to `src/` was for, one level further
      out. `contract.ts` already mentions the identifier in prose, which is why
      the total below is 28 rather than 27.
    */
    const bundled = [
      new URL("../../../packages/desktop-bridge/src/", import.meta.url),
      new URL("../../../packages/meetings/src/", import.meta.url),
    ];

    /*
      Strings out first, then comments. A regex that strips comments before
      strings reads the `//` in a URL literal as a comment and deletes the rest
      of the line; a regex that strips strings first reads the `"` in a comment
      as a string. Only tracking both at once gets either right.
    */
    const code = (text) => {
      let out = "";
      let mode = "code";
      /*
        The last character that decides whether a `/` opens a REGEX or divides.
        Without this state a legitimate `const quoted = /["]/;` opens string
        mode on its own bracket and swallows the next registration whole —
        MEASURED at 906 PASS / 0 FAIL, which is the "delete the evidence"
        failure direction this lexer replaced a regex to avoid. A lexer without
        a regex state is a regex with extra steps.
      */
      let significant = "";
      for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        const next = text[i + 1];
        if (mode === "code") {
          if (c === "/" && next === "/") { mode = "line"; i += 1; continue; }
          if (c === "/" && next === "*") { mode = "block"; i += 1; continue; }
          /*
            A `/` after a value divides; after an operator or a bracket it opens
            a regex. **Neither direction is conservative**, and an earlier
            comment here claimed dividing was. It is not: mistaking a regex for
            a division leaves the regex body lexed as code, where a quote inside
            it opens a phantom string that swallows whatever comes next — which
            is exactly how `return /^[a-z']+$/i` hid a registration. Both
            mistakes hide code, in opposite files. That is why the count above
            does not lex, and why this remains a diagnostic rather than a guard.
          */
          if (c === "/" && significant !== "" && !/[A-Za-z0-9_$)\]]/.test(significant)) {
            mode = "regex";
            out += " ";
            continue;
          }
          if (c === '"' || c === "'" || c === "`") { mode = c; out += " "; continue; }
          out += c;
          if (!/\s/.test(c)) significant = c;
        } else if (mode === "line") {
          if (c === "\n") { mode = "code"; out += c; }
        } else if (mode === "block") {
          if (c === "*" && next === "/") { mode = "code"; i += 1; }
        } else if (mode === "regex") {
          if (c === "\\") { i += 1; continue; }
          if (c === "[") { mode = "class"; continue; }
          if (c === "/") { mode = "code"; significant = "x"; }
        } else if (mode === "class") {
          // A `/` inside a character class does not end the literal.
          if (c === "\\") { i += 1; continue; }
          if (c === "]") mode = "regex";
        } else {
          // inside a string: a backslash escapes the next character
          if (c === "\\") { i += 1; continue; }
          if (c === mode) { mode = "code"; significant = "x"; }
        }
      }
      return { text: out, ended: mode };
    };

    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(new URL(`${entry.name}/`, dir))
          : [new URL(entry.name, dir)],
      );

    let registrations = 0;
    let handoffs = 0;
    const unrecognised = [];
    for (const file of walk(mainDir)) {
      // Every extension the bundler will load, not just the ones in the tree today.
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file.pathname)) continue;
      // Import clauses whole, so `ipcMain` inside one is never guessed at from
      // the punctuation that happens to follow it.
      const raw = readFileSync(file, "utf8");
      /*
        A RENAMED IMPORT IS AN UNRECOGNISED FORM, not an ignored one.

        Deleting the import clause and then scanning for the identifier means a
        file that binds it under another name has no mentions left to find:
        `import { ipcMain as electronIpc }` followed by `electronIpc.on(...)`
        registered a channel at 906 PASS / 0 FAIL. The clause is where the
        aliasing happens, so the clause is where it has to be caught — and this
        branch's own comment used to call that silence "a legitimate rename
        reddens nothing", which was describing the hole as the feature.

        Refused rather than followed, because nothing in this app renames it and
        a census that tracks arbitrary local bindings is a parser. If somebody
        needs the rename, they change this check and say why.
      */
      for (const clause of raw.matchAll(/\bimport\s([^;]*?)\sfrom\s*["'`][^"'`]*["'`]\s*;/g)) {
        if (/\bipcMain\s+as\s+\w+/.test(clause[1])) {
          unrecognised.push(`${file.pathname.split("/").pop()}: ipcMain imported under another name`);
        }
      }
      // Import clauses go BEFORE the lexer, while their module specifier is
      // still a quoted string — the lexer replaces it with a space, and a regex
      // written for the stripped form would match a shape that only exists
      // after its own input has been mangled.
      const lexed = code(raw.replace(/\bimport\s[^;]*?\sfrom\s*["'`][^"'`]*["'`]\s*;/g, " "));
      if (lexed.ended !== "code") {
        unrecognised.push(`${file.pathname.split("/").pop()}: lexer ended in ${lexed.ended}`);
      }
      const text = lexed.text;
      for (const match of text.matchAll(/\bipcMain\b/g)) {
        const before = text.slice(Math.max(0, match.index - 12), match.index);
        const after = text.slice(match.index + "ipcMain".length, match.index + 40);
        if (/^\.removeAllListeners\(/.test(after)) continue;
        if (/^\.(?:on|once|handle)\(/.test(after)) { registrations += 1; continue; }
        // The one hand-off: `createConsoleBridge({ ipc: ipcMain, … })`.
        if (/\bipc:\s*$/.test(before) && /^\s*,/.test(after)) { handoffs += 1; continue; }
        unrecognised.push(`${file.pathname.split("/").pop()}: ipcMain${after.split("\n")[0]}`);
      }
    }

    const bridge = code(readFileSync(new URL("consoleBridge.ts", mainDir), "utf8")).text;
    const bridgeCalls = (bridge.match(/deps\.ipc\.(?:on|once|handle)\(/g) ?? []).length;
    const gatedAsync = (bridge.match(/\n {2}handle\(BRIDGE_CHANNELS\./g) ?? []).length;
    const gatedSync = (bridge.match(/\n {2}answerSync\(BRIDGE_CHANNELS\./g) ?? []).length;

    /*
      THE ONE ASSERTION THAT CANNOT BE FOOLED BY LEXING, because it does not lex.

      Every shape of this census so far has had holes, and two of them were in
      the lexer itself: a regex literal containing a quote swallowed the next
      registration, and the regex/division rule added to fix that opened the
      mirror-image hole. `return /^[a-z']+$/i` divides — the character before
      the slash is the `n` of `return` — so the apostrophe opens string mode, a
      later quote closes it, and an ungated registration in that file passed at
      916 PASS / 0 FAIL. Idiomatic TypeScript, not a contrivance.

      Telling a regex from a division needs a parser and this suite has no
      dependencies, so the load-bearing check stops trying. It counts every
      occurrence of the identifier in the raw bytes — comments and strings
      included — and requires the total. Nothing about how a file lexes can
      change that number.

      The cost is real and is the right way round: writing the identifier in a
      new comment reddens this, and the fix is to update the number on purpose.
      A guard that complains when the surface is DESCRIBED differently is
      cheaper than one that stays silent when the surface IS different.

      WHAT IT STILL CANNOT SEE, said plainly rather than claimed away. Every
      shape of this census so far has been described as exhaustive and none was,
      so this list is what a reviewer MEASURED rather than what its author
      believed:

        - **a registration that never spells the identifier.**
          `electron["ipc" + "Main"].on(...)` passes, and no text scan will ever
          catch it — the name is not in the bytes.
        - **an aliased receiver.** `const { ipc } = win.webContents;` followed by
          `ipc.handle(...)` spells neither `ipcMain` nor `.ipc.`, and was
          measured green. Telling that binding from any other `ipc` needs the
          import graph this suite does not have.

      Both need a real build step to close. What a review DID close, by
      measuring the hole first: `handleOnce` and `addListener` (the method name
      is no longer a list of three), and a registration in
      `packages/desktop-bridge` or `packages/meetings` (the walk is the bundle
      now, not this app's directory).

      So the claim is the smaller true one: **this guard is for the accident,
      not the adversary.** It catches a channel somebody adds without thinking
      about the gate, in every spelling anybody has actually written. It does
      not catch somebody hiding one on purpose. That is worth having and is not
      worth overstating.

      The classification below keeps its place as the diagnostic — it names
      which mention is unrecognised, which is what a person needs — but it is no
      longer what stands between a new ungated channel and a green run.
    */
    /*
      `webContents.ipc` AND `webFrameMain.ipc` ARE IPC TOO, and neither spells
      `ipcMain`. They are Electron's documented way to scope a channel to one
      window, so a registration through them is idiomatic rather than obscure —
      and it was invisible here until a review measured it.

      THE METHOD NAME IS NOT ENUMERATED, and the first version of this check
      enumerated it: `(?:on|once|handle)\(` is the three verbs somebody thought
      of, and `IpcMain` also declares `handleOnce`, `addListener`,
      `removeListener` and `off`. A review wrote `win.webContents.ipc.handleOnce(
      …)` into this tree and it passed green. So the name is now `[A-Za-z_$][\w$]*`
      — any member call on an `.ipc` receiver — which is a count of a surface
      rather than a list of the parts of it anybody remembered.
    */
    let mentions = 0;
    let scoped = 0;
    for (const file of [...walk(srcDir), ...bundled.flatMap(walk)]) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file.pathname)) continue;
      const raw = readFileSync(file, "utf8");
      mentions += (raw.match(/\bipcMain\b/g) ?? []).length;
      scoped += (raw.match(/\.ipc\.[A-Za-z_$][\w$]*\(/g) ?? []).length;
    }
    // 28 and not 25: widening to `src/` picks up two mentions in prose, in
    // `core/shell/bridge.ts` and `core/shell/console.ts`, and widening to the
    // bundled packages picks up a third in `desktop-bridge/src/contract.ts` —
    // all three comments about this very guard. That is exactly the false
    // positive this check accepts by design: the number moves when the surface
    // is DESCRIBED differently, which is cheaper than silence when it IS
    // different.
    check(
      `EVERY MENTION OF ipcMain IN THE MAIN BUNDLE IS ACCOUNTED FOR — ${mentions} of 28`,
      mentions === 28,
    );
    /*
      Named for what it counts, after a review found the old name false twice
      over. It said PER-WINDOW and there are no per-window registrations in this
      tree: the two it matched are `deps.ipc.handle(` and `deps.ipc.on(` in
      `consoleBridge.ts`, and `deps.ipc` is handed the **global** `ipcMain` at
      `main/index.ts`. They match by shape. It also said "any third is new
      surface", and the widened method name makes it five — the same two helpers
      plus the bridge's own teardown calls, which are not registrations at all.

      So the claim is the one this can actually carry: every `.ipc.` member call
      in the main bundle is inside `consoleBridge.ts`, where the gate is. One
      written anywhere else moves the number, whichever verb it uses.
    */
    check(
      `EVERY .ipc. CALL IN THE MAIN BUNDLE IS INSIDE THE GUARDED BRIDGE — ${scoped} of 5`,
      scoped === 5,
    );

    check(
      `EVERY \`ipcMain\` UNDER src/main IS A FORM THIS CENSUS RECOGNISES${unrecognised.length ? ` — ${unrecognised[0]}` : ""}`,
      unrecognised.length === 0,
    );
    check(
      "THE UNGATED SURFACE HAS NOT GROWN — twelve commands and three capture channels",
      registrations === 15,
    );
    check(
      "ipcMain is handed to exactly one thing, and that thing is the guarded bridge",
      handoffs === 1,
    );
    check(
      "the bridge reaches ipc through exactly its two guarded helpers, and nowhere else",
      bridgeCalls === 2,
    );
    check(
      "every channel the console bridge answers goes through one of them",
      gatedAsync === HANDLED.length && gatedSync === 2,
    );
    check(
      "...and the census adds up, so neither side can drift unnoticed",
      registrations + gatedAsync + gatedSync === 30,
    );
  }

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

    const started = await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: true });
    const startCall = shell.invoked.find((call) => call.channel === BRIDGE_CHANNELS.startCapture);
    check("`startCapture` sends the request the page made", startCall?.args[0]?.sessionId === "mtg_abcdefghjkmnpqrstvwx");
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
      await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
    } catch (error) {
      message = error.message;
    }
    check("A REFUSED CAPTURE THROWS THE SHELL'S OWN SENTENCE", message === "This machine is not connected to a context yet.");
  }

  {
    const shell = installed({ rejectInvoke: true });
    let message = "";
    try {
      await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
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

  /* --- the machine approval the page answers ------------------------------ */
  //
  // Version 3. The shell hands the page a parked authorization request and the
  // page answers it with the session it already holds — `core/shell/autoGrant.ts`
  // is the argument. What this file owns is the boundary: what the page is
  // handed is one field, and what it hands back is read against the contract
  // before it reaches the process that owns the credential.

  {
    const { ipc } = mainBridge({ pending: { requestId: "req_this_mac" } });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.connectionPendingApproval)(
      sender(),
      null,
    );
    check(
      "the page is handed the parked request, and one field of it",
      answer.ok === true && Object.keys(answer.value).join() === "requestId",
    );
    check("...and its value is the id the shell is waiting on", answer.value.requestId === "req_this_mac");
  }

  {
    const { ipc } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.connectionPendingApproval)(
      sender(),
      null,
    );
    check(
      "a shell with nothing in flight hands over nothing",
      answer.ok === true && answer.value === null,
    );
  }

  {
    const { ipc, answered } = mainBridge({ pending: { requestId: "req_this_mac" } });
    await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), {
      requestId: "req_this_mac",
      approved: true,
      // A third field, which must not reach the main process.
      code: "an-authorization-code",
    });
    check(
      "AN ANSWER REACHES THE SHELL AS TWO FIELDS AND NEVER THREE",
      answered.length === 1 &&
        Object.keys(answered[0]).sort().join() === "approved,requestId",
    );
    check("...carrying what the page said", answered[0].requestId === "req_this_mac" && answered[0].approved === true);
  }

  {
    const { ipc, answered } = mainBridge({ pending: { requestId: "req_this_mac" } });
    for (const payload of [null, {}, { approved: true }, { requestId: 42 }, { requestId: "x".repeat(300) }]) {
      await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), payload);
    }
    check(
      "A MALFORMED ANSWER IS DROPPED RATHER THAN FORWARDED",
      answered.length === 0,
    );
    // `approved` is read with `=== true`, like every other boolean crossing
    // this boundary: a truthy string is not an approval.
    await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), {
      requestId: "req_this_mac",
      approved: "yes",
    });
    check(
      "...and a truthy answer that is not `true` is a refusal",
      answered.length === 1 && answered[0].approved === false,
    );
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
        await ipc.handlers.get(channel)(sender({ id: 99 }), { sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
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
          sessionId: "mtg_abcdefghjkmnpqrstvwx",
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

  /* ------------------------------------------------------------------ *
   * The id the page mints is a ROUTE, not a name.
   * ------------------------------------------------------------------ */

  /*
    `ROUTES.transcribe/segments/notes/finalize` interpolate the session id into
    a path with no encoding, and `core/sync/client.ts` and `main/transcribe.ts`
    concatenate that into `${baseUrl}${route}` and send it with
    `authorization: Bearer <this machine's grant>`. `fetch` then normalises the
    URL — so whoever picks the id picks the endpoint. MEASURED with `new URL`:

        a/../../../inbox#        ->  POST /inbox
        a/../../../mcp#          ->  POST /mcp
        a/../../../oauth/token#  ->  POST /oauth/token
        a#frag                   ->  /meetings/sessions/a, dropping /finalize

    The gateway saved the bucket key — `matchMeetingRoute` runs `isMeetingId`
    before `sessionKey` interpolates anything, so `.meetings/sessions/<id>.json`
    is never built from a malformed id — and the outbox saved the disk, keying
    entries `${sessionId}:${kind}` inside one JSON structure rather than as
    filenames. Nothing saved the URL.

    So the id is validated where it enters, with the same predicate the gateway
    already applies to the same value. Both readers, because `startCapture` and
    `meetingsWrite` each take one from the page and the write path needs no
    recording at all.
  */
  const POISONED = [
    "a/../../../inbox#",
    "a/../../../mcp#",
    "a/../../../oauth/token#",
    "x?q=1",
    "a#frag",
    "../../x",
    "a/b",
  ];

  {
    const { ipc, calls } = mainBridge();
    const answers = [];
    for (const sessionId of POISONED) {
      answers.push(
        await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
          sessionId,
          mic: true,
          systemAudio: false,
        }),
      );
    }
    check(
      "AN ID THAT WOULD REDIRECT THE SHELL'S CREDENTIALLED REQUEST IS REFUSED",
      answers.every((answer) => answer?.ok === false),
    );
    check(
      "...and the capture never began, so nothing downstream ever held it",
      !calls.includes("startCapture"),
    );
  }

  {
    const { ipc, written } = mainBridge();
    const answers = [];
    for (const sessionId of POISONED) {
      answers.push(
        await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, sessionId }),
      );
    }
    check(
      "AND ON THE WRITE CHANNEL, which reaches the queue with no recording at all",
      answers.every((answer) => answer?.ok === false),
    );
    check("...and nothing was queued", written.length === 0);
  }

  {
    // The other direction, so the fix cannot be "refuse everything".
    const { ipc, calls, written } = mainBridge();
    const good = "mtg_abcdefghjkmnpqrstvwx";
    const started = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      sessionId: good,
      mic: true,
      systemAudio: false,
    });
    const wrote = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), {
      ...WRITE,
      sessionId: good,
    });
    check(
      "a well-formed id is still adopted on both channels",
      started?.ok === true &&
        started.value.sessionId === good &&
        wrote?.ok === true &&
        calls.includes("startCapture") &&
        written.length === 1,
    );
  }

  {
    const { ipc, calls } = mainBridge();
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender({ top: false }), {
        sessionId: "mtg_abcdefghjkmnpqrstvwx",
        mic: true,
        systemAudio: false,
      });
    } catch {
      refused = true;
    }
    check("a subframe of the console window is refused", refused && calls.length === 0);
  }

  /*
    The other window in this app, which is the one that matters most.

    `main/capture.ts` opens a hidden `BrowserWindow` holding a live microphone.
    It has its own narrow preload and no reason to touch any of this — but it is
    a webContents in the same process, so "is this an internal window" is not a
    question worth asking and "is this THE console window" is. Every handled
    channel, and both synchronous ones.
  */
  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(captureWindowSender(), {
          sessionId: "mtg_abcdefghjkmnpqrstvwx",
          mic: true,
          systemAudio: false,
        });
      } catch {
        refusals += 1;
      }
    }
    check(
      "THE HIDDEN CAPTURE WINDOW IS REFUSED ON EVERY CHANNEL — it holds a microphone, not a bridge",
      refusals === HANDLED.length && calls.length === 0,
    );

    const origin = captureWindowSender();
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(origin);
    const shell = captureWindowSender();
    ipc.listeners.get(BRIDGE_CHANNELS.shell)(shell);
    check(
      "...and told neither the pin nor the shell on the synchronous channels",
      origin.returnValue === null && shell.returnValue === null,
    );
  }

  {
    const { ipc } = mainBridge();
    const framed = sender({ top: false });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(framed);
    check("a subframe is not told the pin either", framed.returnValue === null);
  }

  /*
    A frame that went away while the call was in flight.

    Electron's `event.senderFrame` is a getter over a live object and it *throws*
    — "Render frame was disposed before WebFrameMain could be accessed" — for a
    frame that navigated, reloaded or closed. That is an ordinary event, not an
    attack, and it must land as a refusal: a throw out of the guard is a
    rejection carrying Electron's own text on `handle`, and on a synchronous
    channel it is a listener that never sets `returnValue` while the renderer
    blocks on `sendSync` at document start.
  */
  {
    // Called through a `try` so that a guard which *does* throw is reported as
    // one failed check rather than as a suite that stopped running.
    let guarded = null;
    try {
      guarded = isBridgeSender(disposedSender(), { webContentsId: 7, pinned: PINNED });
    } catch {
      guarded = "threw";
    }
    check("A FRAME THAT WENT AWAY MID-CALL IS REFUSED, NOT A THROW OUT OF THE GUARD", guarded === false);

    const { ipc, calls } = mainBridge();
    let answered = null;
    let threw = false;
    try {
      answered = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(disposedSender(), {
        sessionId: "mtg_abcdefghjkmnpqrstvwx",
        mic: true,
        systemAudio: false,
      });
    } catch {
      threw = true;
    }
    check(
      "...and `handle` refuses it as it refuses any other sender",
      threw && answered === null && calls.length === 0,
    );

    const event = disposedSender();
    let syncThrew = false;
    try {
      ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    } catch {
      syncThrew = true;
    }
    check(
      "...and the synchronous channel answers `null` rather than leaving `sendSync` waiting",
      !syncThrew && event.returnValue === null,
    );
  }

  /*
    The same rule for the *answer* and not only for the guard.

    `answerSync` calls into the shell to produce its value — `app.getName()` on
    a shell mid-quit is the real case — and a synchronous listener that throws
    is the one shape with a worse failure than a refusal: the renderer is
    blocked inside `sendSync` at document start, so the window never paints
    rather than merely losing its bridge. `null` is what the preload already
    reads as "no shell", and it fails closed there.
  */
  {
    const { ipc } = mainBridge({
      deps: {
        shell: () => {
          throw new Error("Object has been destroyed");
        },
      },
    });
    const event = sender();
    let threw = false;
    try {
      ipc.listeners.get(BRIDGE_CHANNELS.shell)(event);
    } catch {
      threw = true;
    }
    check(
      "A SHELL THAT CANNOT ANSWER SYNCHRONOUSLY ANSWERS `null` — never a blocked renderer",
      !threw && event.returnValue === null,
    );
  }

  check(
    "a sender id that is not a number is refused, however it compares",
    isBridgeSender({ sender: { id: "7" }, senderFrame: { url: `${PINNED}/console`, parent: null } }, {
      webContentsId: 7,
      pinned: PINNED,
    }) === false,
  );

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

    /*
      Deliberate, and written down so it is not mistaken for the origin check
      leaking: the console window is told the pin whatever page it is on,
      because it is calling to find out *what* the pin is and asking whether it
      matches would be circular. Both values are public — the origin is in the
      window's own URL bar — and the exposure decision is still the renderer's,
      against `location.origin`. Every channel that *does* something re-asks.
    */
    const wandered = sender({ url: "https://attacker.invalid/console" });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(wandered);
    check(
      "the console window off-origin is still told the pin — it is public, and the acting channels refuse it",
      wandered.returnValue === PINNED,
    );
  }

  /* --- the pin moves, and exactly one origin is trusted at a time -------- */

  {
    /*
      The shell falls back to the offline mirror, so `app://console` is what it
      is serving and the live origin is not. Both halves are checked, because a
      pin that merely *added* the mirror would leave a window that has gone
      offline still answering a frame claiming the origin it can no longer
      reach — which is the one shape a stale renderer takes.
    */
    const { ipc, movePin } = mainBridge();
    movePin(MIRROR_ORIGIN);
    const mirrored = sender({ url: `${MIRROR_ORIGIN}/console` });
    // Caught rather than awaited bare: a refusal here is a *throw*, and a check
    // that lets it out reports zero failures by taking the run down with it.
    let mirroredAnswer = null;
    try {
      mirroredAnswer = await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(mirrored, null);
    } catch {
      mirroredAnswer = null;
    }
    check(
      "THE MIRRORED CONSOLE IS ANSWERED, so an offline page can say what is queued",
      mirroredAnswer?.ok === true && mirroredAnswer.value.pending === QUEUE.pending,
    );

    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(sender(), null);
    } catch {
      refused = true;
    }
    check("...AND THE LIVE ORIGIN IS REFUSED WHILE THE MIRROR IS THE ONE BEING SERVED", refused);

    const event = sender({ url: `${MIRROR_ORIGIN}/console` });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("...and the pin the preload is told is the mirror's", event.returnValue === MIRROR_ORIGIN);

    /*
      An opaque origin reports `"null"`, and so does a second one — which is why
      the pin is never that string and why this guard refuses it by name. Worth
      a check on this side as well as in `shell.test.mjs`: this is the half that
      runs in the main process, where `app://console` being a real origin is the
      whole reason a pin can be a scheme no ordinary page can claim.
    */
    let opaqueRefused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(
        sender({ url: "data:text/html,<script>fetch('x')</script>" }),
        null,
      );
    } catch {
      opaqueRefused = true;
    }
    check(
      "AN OPAQUE ORIGIN IS REFUSED WHILE THE MIRROR IS PINNED — a data: page is not app://console",
      opaqueRefused,
    );
  }

  {
    // And the other way round: the live page is loaded, so a frame claiming the
    // mirror is somebody's idea rather than this shell's.
    const { ipc } = mainBridge();
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(
        sender({ url: `${MIRROR_ORIGIN}/console` }),
        null,
      );
    } catch {
      refused = true;
    }
    check("A FRAME CLAIMING THE MIRROR IS REFUSED WHILE THE LIVE CONSOLE IS LOADED", refused);
  }

  /* --- and answers the console window ------------------------------------ */

  {
    const { ipc, calls } = mainBridge();
    const answers = [];
    for (const channel of HANDLED) {
      const payload =
        channel === BRIDGE_CHANNELS.meetingsWrite
          ? { ...WRITE }
          : channel === BRIDGE_CHANNELS.connectionResolveApproval
            ? { requestId: "a-parked-request-id", approved: false }
            : { sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: true };
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
      sessionId: "mtg_abcdefghjkmnpqrstvwx",
      mic: true,
      systemAudio: false,
    });
    check(
      "a verb that refused answers a sentence rather than throwing across the boundary",
      answer.ok === false && answer.message === "This machine is not connected to a context yet.",
    );
  }

  {
    const { ipc, requested } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      // Whitespace still trims — the id is validated AFTER the trim, so a
      // well-formed id padded by a client is read rather than refused.
      sessionId: "  mtg_abcdefghjkmnpqrstvwx  ",
      mic: "yes",
      systemAudio: 1,
    });
    check(
      "a request from the page is read rather than trusted — only `true` opens an input",
      /*
        READ OFF THE REQUEST THE READER BUILT, not off the answer. This check
        asserted `answer.ok` and the session id only — and the stub behind it
        returns hard-coded `mic: true, systemAudio: false` whatever it is
        asked, so `mic: "yes"` and `systemAudio: 1` were inert. MEASURED:
        replacing `=== true` with `Boolean(...)` in both readers left the suite
        at 781 PASS, 0 FAIL. Half of this check's name was a claim about a line
        nothing exercised.
      */
      answer.ok === true &&
        answer.value.sessionId === "mtg_abcdefghjkmnpqrstvwx" &&
        requested.length === 1 &&
        requested[0].sessionId === "mtg_abcdefghjkmnpqrstvwx" &&
        requested[0].mic === false &&
        requested[0].systemAudio === false,
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

  /*
    ABSENT IS AN ADDRESS; UNREADABLE IS NOT. THEY MUST NOT COLLAPSE HERE.

    `routableContext` in the queue draws exactly that line: `null` means this
    machine's own context, which is where everything the tray records goes, and
    a name it cannot read is refused rather than dropped from the front of the
    URL. A boundary that turned `""` into `null` on the way in would decide that
    question before the queue ever saw it, and the answer it gives is the wrong
    one — a meeting filed in whatever context the credential defaults to.
  */
  {
    const { ipc, written } = mainBridge();
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: "" });
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: null });
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: undefined });
    check(
      "AN EMPTY CONTEXT IS NOT THIS MACHINE'S OWN — the queue is left to refuse it",
      written[0]?.context === "",
    );
    check(
      "...and an absent one is, which is what everything the tray records means",
      written[1]?.context === null && written[2]?.context === null,
    );
  }

  /*
    And the preload does not repair either of them on the way out.

    It runs in the renderer, so a value it "fixes" is a value the guard in the
    main process never gets to refuse. `kind` is a route and `context` is a
    bucket; a default for the first is a body posted to a collection nobody
    named, and a default for the second is the wrong-tenant write above.
  */
  {
    const shell = installed({ replies: { [BRIDGE_CHANNELS.meetingsWrite]: { ok: true, value: {} } } });
    await shell.bridge.meetings.write({ sessionId: "mtg_abcdefghjkmnpqrstvwx", kind: "enhance", context: "", body: {} });
    const sent = shell.invoked.find((one) => one.channel === BRIDGE_CHANNELS.meetingsWrite)?.args[0];
    check(
      "A KIND THE CONTRACT DOES NOT NAME IS NOT REWRITTEN INTO ONE THAT ROUTES",
      sent?.kind === "enhance",
    );
    check("...and an empty context crosses as itself", sent?.context === "");

    const { ipc, written } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), sent);
    check(
      "...so the process that owns the queue is the one that refuses it",
      answer.ok === false && written.length === 0,
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

  /*
    And the window closing is what calls it.

    `dispose()` being right is checked above; that it is *reached* is a line in
    `main/index.ts`, which imports Electron and cannot be run here. Left
    unchecked it is the leak the contract's own unsubscribe rule exists to
    prevent, one process over: ten handlers left registered against a window
    that is gone refuse everything and look answered, and `ipcMain.handle`
    throws outright if the channel is registered a second time.
  */
  {
    const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const closed = source.match(/consoleWindow\.on\("closed",[\s\S]{0,800}?\n {4}\}\);/)?.[0] ?? "";
    check(
      "THE CONSOLE WINDOW CLOSING UNREGISTERS THE BRIDGE — no channel outlives the window it answers",
      closed.includes("consoleBridge?.dispose()") && closed.includes("consoleBridge = null"),
    );
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
    THE BRIDGE AND THE HIDDEN CAPTURE WINDOW SHARE NO CHANNEL NAME AT ALL.

    They used to share four — `context:capture-{start,pause,resume,stop}` — and
    that was safe for a reason neither file said out loud: `handle`
    (renderer→main, reached by `invoke`) and `send` (main→renderer) are separate
    registries, so a name in both is answered by whichever direction asked. It
    is a true reason and a bad one to rely on, because the guard is a fact about
    Electron's dispatch rather than anything either author can see. The day
    somebody answers one of those names with `ipcMain.on` in the capture file,
    the console's Pause is answered by a window holding a live microphone.

    So `BRIDGE_CHANNELS` carries the `console-` prefix on its four capture verbs
    and the names are disjoint by construction. The check reads both capture
    sources — the main process's and the capture window's preload — for every
    `context:` string in them and asserts no bridge channel is among them, which
    is a check that keeps working whatever either side is renamed to.
  */
  {
    const captureSources = [
      readFileSync(new URL("../src/main/capture.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../src/preload/capture.ts", import.meta.url), "utf8"),
    ].join("\n");
    const captureChannels = new Set(captureSources.match(/context:[a-z-]+/g) ?? []);
    const shared = BRIDGE_CHANNEL_NAMES.filter((name) => captureChannels.has(name));
    check(
      "THE HIDDEN CAPTURE WINDOW SHARES NO CHANNEL NAME WITH THE BRIDGE — no dispatch rule is load-bearing",
      captureChannels.size >= 4 && shared.length === 0,
    );
    check(
      "...and the capture window's own channels stay send-only, which is a second reason rather than the only one",
      !/ipcMain\.handle\s*\(/.test(captureSources) &&
        !/ipcMain\.(on|once)\s*\(\s*(CAPTURE_(START|STOP|PAUSE|RESUME)\b|["'`]context:(console-)?capture-(start|stop|pause|resume))/.test(
          captureSources,
        ),
    );
    check(
      "...and the bridge answers its four with `handle`",
      HANDLED.every((name) => mainBridge().ipc.handlers.has(name)),
    );
  }

  /* --- what this build can actually do ----------------------------------- */

  check(
    "system audio is refused outright on anything but macOS",
    systemAudioCapability({ platform: "win32", packaged: true, signed: true, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "AN UNPACKAGED BUILD CLAIMS NO LOOPBACK TAP — macOS will not give one to a build it has not verified",
    systemAudioCapability({ platform: "darwin", packaged: false, signed: true, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "macOS older than 13 claims none either",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 21, probed: null }) === false,
  );
  check(
    "a packaged, signed build on macOS 13 or later claims one until something asks",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 22, probed: null }) === true,
  );
  check(
    "A PACKAGED BUT UNSIGNED BUILD CLAIMS NONE — a dmg built on a laptop is packaged and gets no tap",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: false, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "THE PROBE OVERRULES THE GUESS — a build that was refused a tap reports none",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 24, probed: false }) === false,
  );
  check(
    "...and a build that was given one reports it, packaged or not",
    systemAudioCapability({ platform: "darwin", packaged: false, signed: false, darwinMajor: 24, probed: true }) === true,
  );
  check("the Darwin major is read off `os.release()`", darwinMajorFrom("23.6.0") === 23);
  check("...and a release string this build cannot read is `0`, which is below every floor", darwinMajorFrom("") === 0);
}
