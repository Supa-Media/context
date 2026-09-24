/**
 * The windows a press can raise, and how the shell says why it did nothing.
 *
 * Moved from `main()` verbatim: the panel under the tray, the console window
 * (raised, or built again when it is gone), `explain()` and the live-window
 * read the approval flow asks. `explain()` is the tray's only voice on a
 * default launch, and its sentences come from the closed sets alone.
 */

import { Notification, dialog } from "electron";
import type { BrowserWindow } from "electron";
import { positionPanelUnderTray } from "./windows.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createSurfaces(ctx: MainContext): Pick<MainActions, "showPanel" | "showConsoleWindow" | "openConsoleWindow" | "explain" | "liveConsoleWindow"> {
  const { panel, tray } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const openConsoleWindowIfAsked: MainActions["openConsoleWindowIfAsked"] = () =>
    ctx.openConsoleWindowIfAsked();

  /**
   * Raise the panel under the menu-bar icon, and never with focus.
   *
   * `showInactive` throughout: this panel appears *during a meeting*, and a
   * window that takes focus while somebody is talking is a window they close
   * by quitting the app.
   */
  function showPanel(): void {
    if (panel === null || panel.isDestroyed()) return;
    positionPanelUnderTray(panel, tray.bounds());
    panel.showInactive();
  }

  /**
   * Bring the console window forward, which is what the tray points at now.
   *
   * `show()` rather than `showInactive()`: unlike the panel, this is not a
   * popover that appears *during* a meeting on its own — it opens because
   * somebody clicked the menu bar, and a window that answers a click by
   * appearing behind what they were doing reads as a window that did not open.
   *
   * A window that is *gone* is `openConsoleWindow`'s business, not this
   * function's: the panel is hidden when somebody dismisses it, while the
   * console window is destroyed, and which of "raise it" and "build it again"
   * a caller means is exactly what the two names carry.
   *
   * Answers whether there is a window now, so a caller can say why there is not
   * rather than doing nothing at all.
   */
  function showConsoleWindow(): boolean {
    if (ctx.consoleWindow === null || ctx.consoleWindow.isDestroyed()) return false;
    ctx.consoleWindow.show();
    ctx.consoleWindow.focus();
    return true;
  }

  /**
   * The window a menu-bar click asks for, built again if it is gone.
   *
   * Separate from `showConsoleWindow` because the two callers want different
   * things: `explain()` raises a window that already exists behind a sentence
   * and must not conjure one for a refusal, while the menu-bar click *is* the
   * request for the window and has nowhere else to go.
   */
  function openConsoleWindow(): boolean {
    if (ctx.consoleWindow === null || ctx.consoleWindow.isDestroyed()) openConsoleWindowIfAsked();
    return showConsoleWindow();
  }

  /**
   * Say why a press did nothing.
   *
   * The panel used to be the whole answer — it renders the state and the reason
   * with it — and on a default launch there is no panel. "The button did
   * nothing" is the worst outcome available here, and the console has no
   * channel for a sentence that is not attached to a capture, so the tray's
   * refusals are said in a message box with the window raised behind them.
   *
   * Every sentence comes from `CONSOLE_NOTICES` or `PLAN_NOTICES`; none is
   * assembled here, for the reason those sets exist.
   *
   * ## AND IT MUST NOT STOP THE APP, BECAUSE OF WHEN IT IS CALLED
   *
   * `dialog.showMessageBox(options)` with no window is **application-modal** on
   * macOS: `-[NSAlert runModal]` spins its own run loop and the main process
   * stops dead — `sample` on the live app while one of these was up put 1374 of
   * 1374 samples on `-[NSApplication runModalForWindow:]`. No drain, no
   * finalize, no IPC, until somebody clicks OK. This function fires on exactly
   * the capture-failed path, which is the worst possible moment to stop
   * draining a queue that is holding somebody's meeting.
   *
   * So: the parent window is passed, which makes it a **window sheet** —
   * document-modal, and the process keeps running behind it. Where there is no
   * window to attach one to, an alert is not available at all and the sentence
   * goes to a `Notification`, which never blocks. The tray-only launch is the
   * whole reason that branch exists, and it is also the launch with the most to
   * lose from a stopped main process: the menu bar is the entire app.
   */
  function explain(sentence: string): void {
    if (panel !== null) {
      showPanel();
      return;
    }
    const parent = showConsoleWindow() ? liveConsoleWindow() : null;
    if (parent !== null) {
      void dialog.showMessageBox(parent, {
        type: "info",
        title: "Context",
        message: sentence,
        buttons: ["OK"],
      });
      return;
    }
    console.error(`[shell] ${sentence}`);
    if (Notification.isSupported()) new Notification({ title: "Context", body: sentence }).show();
  }

  /** The console window, when this launch has a live one. `null` otherwise. */
  function liveConsoleWindow(): BrowserWindow | null {
    try {
      if (ctx.consoleWindow === null || ctx.consoleWindow.isDestroyed()) return null;
      return ctx.consoleWindow;
    } catch {
      // A window torn down between the two reads. No window is the honest
      // answer, and it puts the approval back in the system browser.
      return null;
    }
  }

  return { showPanel, showConsoleWindow, openConsoleWindow, explain, liveConsoleWindow };
}
