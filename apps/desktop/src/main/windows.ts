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
 * There is no dock icon at all — `app.dock.hide()` in `index.ts`. This is a
 * menu-bar presence, and a dock icon would make it a second thing to manage.
 */

import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

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
