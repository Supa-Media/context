/**
 * The application menu, and the one command in it that is this app's own.
 *
 * Moved from `main/index.ts` verbatim. `main()` hands the real *Check for
 * Updates...* handler over through `setCheckForUpdatesFromMenu` once the
 * updater exists; until then the menu says the updater has not started.
 */

import { Menu, app } from "electron";
import { showUpdateCheckMessage } from "./dialogs.ts";


/**
 * The application menu, because this is an application.
 *
 * There was none: `Menu.setApplicationMenu` was never called, and a menu-bar-only
 * build did not need one — an accessory app shows no menu bar, so there was
 * nothing to put in it. That stopped being true twice over. The console hosts a
 * *text editor*, and a window with no Edit menu has no Cmd-C, Cmd-V, Cmd-X,
 * Cmd-Z or Cmd-A, because on macOS those are menu key equivalents and nothing
 * else. And a window that Cmd-W cannot close, or that Cmd-Q cannot quit, is not
 * a Mac app.
 *
 * Every item is a `role`, which is deliberate: a role is macOS's own behaviour
 * with macOS's own accelerator and macOS's own localisation, and each one this
 * file spelled out by hand would be a keystroke somebody has to keep working.
 * The *View* menu carries reload, the three zoom commands and full screen — a
 * window pinned to one origin has one page to reload, Cmd-minus and Cmd-0 are
 * how a person on any Mac app makes text the size they want (Dev2, 2026-10-12:
 * the app read "way too scaled up" and there was no key to shrink it), and
 * `toggleDevTools` in a shipped build is a console on somebody's private notes.
 *
 * `close` and not `quit` on Cmd-W is the whole of "closing the window must not
 * end a meeting": `window-all-closed` below refuses to quit, the tray stays,
 * and a recording in progress runs on in this process with no window at all.
 */
let checkForUpdatesFromMenu = () => {
  console.log("[update] manual check requested before updater startup finished.");
  void showUpdateCheckMessage({ type: "not-started" });
};

/** Replace the menu command once `main()` has an updater to ask. */
export function setCheckForUpdatesFromMenu(handler: () => void): void {
  checkForUpdatesFromMenu = handler;
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: [
          { role: "about" },
          { label: "Check for Updates...", click: () => checkForUpdatesFromMenu() },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }],
      },
    ]),
  );
}
