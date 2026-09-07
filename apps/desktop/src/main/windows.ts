/**
 * The two windows, and the one that is not a window.
 *
 * **The panel** is the menu-bar popover from `DesktopDetect`: frameless, always
 * on top, no dock entry, positioned under the tray icon. It appears when a
 * meeting is detected and when the person clicks the icon, and it goes away on
 * blur — a popover that has to be dismissed is a popover people close by
 * quitting the app.
 *
 * **The notepad** is an ordinary window from `DesktopNotepad`, because it is
 * somewhere a person types for an hour. It is deliberately *not* focused when
 * it opens during a call: the transcript rail updates beside whatever they are
 * doing, and an app that steals focus mid-sentence in a meeting is an app they
 * turn off. `showInactive()` rather than `show()` is that whole rule.
 *
 * **The console window** is the third, and it is the one that is meant to
 * replace the other two: it hosts `apps/mobile`'s web build rather than HTML
 * written here, so a screen ships with the web deploy and reaches a browser, a
 * phone and this Mac at once. It is behind `CONTEXT_DESKTOP_UI=console` until
 * the bridge underneath it exists — `docs/decisions/desktop.md` has the order.
 *
 * **There is a Dock icon**, and this paragraph used to say the opposite: *"no
 * dock icon at all — `app.dock.hide()` in `index.ts`. This is a menu-bar
 * presence, and a dock icon would make it a second thing to manage."* That was
 * true of an app with no window. The console window made it false, and the
 * first signed build proved it: an app with a window, no Dock tile and no app
 * switcher entry is one the person who installed it cannot find. What was
 * reasoned about as "a second thing to manage" is, to somebody who owns a Mac,
 * the only way they open anything. The menu-bar item stays exactly as it was —
 * recording still needs no window — and `docs/decisions/desktop.md`, "The app
 * is in the Dock", records the reversal and whose reason it is.
 */

import { BrowserWindow, screen, shell } from "electron";
import { join } from "node:path";
import { mayNavigateConsoleWindow } from "../core/shell/approval.ts";

export interface WindowSet {
  panel: BrowserWindow;
  notepad: BrowserWindow;
}

/**
 * Set once, when the app is genuinely quitting.
 *
 * The notepad refuses to close so that a person who dismisses the window
 * mid-meeting keeps their typed notes and their recording. That refusal has to
 * stop applying when the app itself is going away, or `app.quit()` is a window
 * that will not close and an app that will not exit.
 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 470;

export function createPanel(rendererDir: string): BrowserWindow {
  const panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // The mockup's panel is a rounded dark card floating over the desktop.
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(rendererDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void panel.loadFile(join(rendererDir, "panel.html"));
  panel.on("blur", () => panel.hide());
  return panel;
}

export function createNotepad(rendererDir: string): BrowserWindow {
  const notepad = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#050506",
    webPreferences: {
      preload: join(rendererDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void notepad.loadFile(join(rendererDir, "notepad.html"));
  // Closing the notepad does not end the meeting — the tray is still recording
  // and still says so. Hidden rather than destroyed so the typed notes survive.
  notepad.on("close", (event) => {
    if (!quitting && !notepad.isDestroyed()) {
      event.preventDefault();
      notepad.hide();
    }
  });
  return notepad;
}

/**
 * The console window: the Expo app, hosted.
 *
 * `docs/decisions/desktop.md` is the argument for why this exists and what
 * eventually replaces the panel and the notepad with it. Today it is behind
 * `CONTEXT_DESKTOP_UI=console` and proves one thing: this shell can host a
 * remote origin without giving that origin anything.
 *
 * Everything in `webPreferences` is a rule rather than a default. `sandbox` is
 * on, which the panel and the notepad never needed because they loaded a local
 * file; this window loads a page over the network and it is the difference
 * between "our own HTML" and "whatever was served". `additionalArguments` is
 * deliberately **not** how the origin reaches the preload — a sandboxed preload
 * asks the main process for it, so the pin has one source and it is this
 * process.
 *
 * Two navigation guards, because a note is full of other people's links:
 * `will-navigate` cancels anything off-origin, and `setWindowOpenHandler` sends
 * it to the person's real browser instead of opening a second window that would
 * inherit this preload. The one address that is neither the pin nor the mirror
 * and is still allowed — the loopback callback of a connect that is in flight —
 * arrives through `approvalCallback`, is `null` at every other moment, and is
 * decided by `core/shell/approval.ts` rather than here.
 */
function isWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export interface ConsoleWindowOptions {
  /**
   * The loopback callback this window may reach **right now**, or `null`.
   *
   * A getter, and never a value: the answer is `null` for the whole life of
   * this app except the seconds between pressing Connect and the grant coming
   * back, and a value read once at construction would be an allowance that
   * outlives the connect it was opened for. `core/shell/approval.ts` is the
   * whole of the rule; this is the wire it arrives on.
   */
  approvalCallback?: () => string | null;
}

export function createConsoleWindow(
  url: string,
  rendererDir: string,
  options: ConsoleWindowOptions = {},
): BrowserWindow {
  const origin = new URL(url).origin;
  const win = new BrowserWindow({
    width: 1_040,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    /*
      Named, because the title bar is not the only place a window title is read:
      it is the Window menu's entry and what the app switcher and Mission
      Control show. `hiddenInset` hides the bar's own text, and a page is free
      to set `document.title` over this — `title` here is what the window is
      called before the console has loaded, and on a launch where it never does.
    */
    title: "Context",
    titleBarStyle: "hiddenInset",
    // Painted before the page is, so a cold load shows the app's own ground
    // rather than Chromium's white. Matches `renderer/tokens.css`.
    backgroundColor: "#050506",
    webPreferences: {
      preload: join(rendererDir, "consolePreload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Its own jar, so the console's control-plane session is not sharing
      // cookies with anything else this app ever loads.
      partition: "persist:console",
    },
  });

  /*
    A link opens in the person's browser, and only if it is a link.

    `openExternal` hands the string to the OS, which will act on `file:` and on
    every scheme some other installed application registered. The page choosing
    what this app asks macOS to open is the whole hazard, so the scheme is
    allow-listed rather than filtered.
  */
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isWebUrl(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  /*
    Off-origin navigation is cancelled, and so is a target this process cannot
    parse — an unparseable URL is not a reason to let one through.

    **Two origins are allowed and they are both this shell's own**: the console
    it was pinned to, and `app://console`, which is served from this machine's
    disk by `consoleMirror.ts` when the network is gone. The second is what
    makes the offline page's Retry an ordinary link — it navigates back to the
    live URL, and the mirrored console can reload itself without the shell
    having to give it an IPC channel for it. What the page gets in either place
    is still decided by the pin, which is one origin at a time.

    The decision is `isAllowedConsoleNavigation` and not `new URL(target).origin`
    here, for the reason `originOfUrl` is written down three times over: the
    main process's `URL` reads `app://console/...` as an opaque origin, so the
    obvious comparison cancels every navigation *inside* the offline console.
  */
  win.webContents.on("will-navigate", (event, target) => {
    /*
      The third target, and it is open for seconds rather than for the life of
      the window: `http://127.0.0.1:<port>/…`, the loopback address the connect
      currently in flight is listening on. The approve screen ends by
      navigating there, so a window that refuses it is a window in which this
      machine can never be approved — and an allowance that is not scoped to
      one in-flight connect is a standing invitation for a page to walk to a
      socket on this machine. `mayNavigateConsoleWindow` is both halves in one
      decision, checked in `test/approval.test.mjs`.

      A getter that throws is the same answer as no connect in flight, because
      a guard is not the place to find out how a caller failed.
    */
    let callback: string | null = null;
    try {
      callback = options.approvalCallback?.() ?? null;
    } catch {
      callback = null;
    }
    if (!mayNavigateConsoleWindow(target, origin, callback)) event.preventDefault();
  });
  /*
    The console is never granted a media permission.

    The microphone in this app belongs to the hidden capture window, opened by
    the main process after `core/consent/gate.ts` has said yes. So even a fully
    compromised page cannot open one directly — the most it can do is ask the
    bridge, and the bridge asks the gate.
  */
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );

  void win.loadURL(url);
  return win;
}

/** Put the panel under the tray icon, clamped to the display it is on. */
export function positionPanelUnderTray(panel: BrowserWindow, trayBounds: Electron.Rectangle): void {
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const x = Math.round(
    Math.min(
      Math.max(display.workArea.x + 8, trayBounds.x + trayBounds.width / 2 - PANEL_WIDTH / 2),
      display.workArea.x + display.workArea.width - PANEL_WIDTH - 8,
    ),
  );
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  panel.setPosition(x, y, false);
}

/** Show the notepad without taking focus. See the header. */
export function revealNotepadQuietly(notepad: BrowserWindow): void {
  if (notepad.isVisible()) return;
  notepad.showInactive();
}
