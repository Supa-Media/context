/**
 * The message boxes this app may open, and how each avoids stopping the process.
 *
 * Moved from `main/index.ts` verbatim. `askSomething` is the one place a
 * question is asked; the manual update check's result and its refusal are the
 * two dialogs the application menu leads to.
 */

import { BrowserWindow, Notification, dialog } from "electron";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { ManualUpdateCheckOutcome } from "./updater.ts";
import { INSTALL_REFUSED_PROMPT, updateCheckPrompt } from "../core/update/prompt.ts";

/**
 * Ask a question in a **window sheet**, and only fall back to an alert.
 *
 * `dialog.showMessageBox(options)` without a `browserWindow` is
 * application-modal on macOS: `-[NSAlert runModal]` spins its own run loop and
 * the main process stops — measured on the live app, 1374 of 1374 samples on
 * `-[NSApplication runModalForWindow:]`. Nothing drains, nothing finalizes, no
 * IPC is answered, for as long as the box is up. Passing the parent makes it
 * document-modal instead: it hangs off the window's title bar and the process
 * keeps running behind it.
 *
 * A question needs an answer, so unlike `explain()` this cannot degrade to a
 * notification — a tray-only launch with no window still gets the alert. That
 * is the one remaining blocking box in this file, it is on the connect path
 * rather than the capture path, and it is waiting on a person either way.
 */
export function askSomething(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  return parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options);
}

export function showNativeNotification(body: string): void {
  if (Notification.isSupported()) new Notification({ title: "Context", body }).show();
}

/**
 * Show the outcome of a manual check, and let the person act on it.
 *
 * The dialog used to be one *OK* button whatever it said — including on
 * *"Update ready. Version 0.1.44 is ready to install."*, which named an action
 * and then offered no way to take it; the only route was a *Restart to update*
 * item in the menu bar the dialog never mentioned. `updateCheckPrompt()` now
 * decides the buttons, and `installButton` is the one index this function will
 * turn into an install.
 *
 * `install` is `DesktopUpdater.install()`, which asks `mayInstall()` and
 * re-reads `controller.recording` at the moment of the click — so a meeting
 * that started while this box was open refuses the press rather than tearing
 * itself down, and says so.
 */
export async function showUpdateCheckMessage(
  outcome: ManualUpdateCheckOutcome,
  install: () => boolean = () => false,
): Promise<void> {
  const prompt = updateCheckPrompt(outcome);
  const { installButton, ...options } = prompt;
  const parent = liveFocusedWindow();
  const answer = await askSomething(parent, { ...options, title: "Check for Updates" });
  if (installButton === null || answer.response !== installButton) return;
  if (!install()) sayInstallRefused();
}

/**
 * *Restart Now* pressed into a refusal, because a meeting started while the box
 * was open.
 *
 * A **notification** and not a second alert when there is no window to hang a
 * sheet off: `askSomething`'s header measured what a parentless
 * `showMessageBox` does — `-[NSAlert runModal]` spins its own run loop and this
 * process stops, draining nothing — and the one moment that must never happen
 * is the one this branch is reached in, with a recording running.
 */
export function sayInstallRefused(): void {
  const { message, detail } = INSTALL_REFUSED_PROMPT;
  const parent = liveFocusedWindow();
  if (parent === null) {
    showNativeNotification(`${message} ${detail}`);
    return;
  }
  void askSomething(parent, {
    type: INSTALL_REFUSED_PROMPT.type,
    title: "Check for Updates",
    message,
    detail,
    buttons: INSTALL_REFUSED_PROMPT.buttons,
  });
}

export function liveFocusedWindow(): BrowserWindow | null {
  const parent = BrowserWindow.getFocusedWindow();
  return parent === null || parent.isDestroyed() ? null : parent;
}
