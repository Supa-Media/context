/**
 * What the "Check for Updates…" dialog says, and which button installs.
 *
 * The bug this file exists for: a person chose *Check for Updates…*, was told
 * **"Update ready. Version 0.1.44 is ready to install."**, and was given one
 * button — *OK*. The update really was downloaded and really was installable;
 * the only route to applying it was a *Restart to update* item in the menu bar,
 * which the dialog never mentions. A modal that reports a ready action and
 * offers no way to take it is a dead end, so the dialog now carries the verb:
 * the ready case is a two-button prompt whose default button installs.
 *
 * It is a pure function of the outcome, here rather than in `main/index.ts`,
 * for the same reason `policy.ts` is: `updatePrompt.test.mjs` can then assert
 * *"the ready prompt has an install button and the deferred one does not"*
 * without Electron, a signed build, or a real release. `main/index.ts` renders
 * what this returns and calls `install()` when `installButton` is the index
 * that came back — it decides nothing else.
 *
 * **`installButton` is a route, never a permission.** `mayInstall()` is still
 * the only thing that decides whether `quitAndInstall()` runs, and it re-reads
 * `capturing` at the click. A person who starts recording while this dialog is
 * open presses *Restart Now* into a refusal — `INSTALL_REFUSED_PROMPT` is what
 * they are told, and the meeting survives.
 */

/** The result of a manual check, as `DesktopUpdater.checkNow()` reports it. */
export type ManualUpdateCheckOutcome =
  | { type: "not-started" }
  | { type: "unarmed" }
  | { type: "checking" }
  | { type: "no-update" }
  | { type: "downloaded"; version: string | null; deferred: boolean }
  | { type: "error" };

/** A `dialog.showMessageBox` call, minus the parent window. */
export interface UpdatePrompt {
  type: "info" | "warning";
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** Index of the button that installs, or `null` when the prompt has none. */
  installButton: number | null;
}

/** Every prompt that is only news gets this shape: one button, nothing to press wrong. */
function acknowledge(
  type: "info" | "warning",
  message: string,
  detail: string,
): UpdatePrompt {
  return { type, message, detail, buttons: ["OK"], defaultId: 0, cancelId: 0, installButton: null };
}

export function updateCheckPrompt(outcome: ManualUpdateCheckOutcome): UpdatePrompt {
  switch (outcome.type) {
    case "not-started":
      return acknowledge("info", "Context is still starting up.", "Try checking again in a moment.");
    case "unarmed":
      return acknowledge(
        "info",
        "Updates are only available in signed packaged builds.",
        "This local or unsigned build cannot verify release updates.",
      );
    case "checking":
      return acknowledge(
        "info",
        "Context is already checking for updates.",
        "The current check will finish in the background.",
      );
    case "no-update":
      return acknowledge("info", "Context is up to date.", "No newer desktop release is available right now.");
    case "downloaded":
      /*
        A meeting is recording, so there is no install to offer: `mayInstall()`
        would refuse it, and a button that cannot work is worse than no button.
        The sentence says what will happen instead, and the deferred update is
        applied on the next quit or from the menu bar once the meeting ends.
      */
      return outcome.deferred
        ? acknowledge(
            "info",
            "Update ready.",
            "Finish the current recording, then restart Context to install it.",
          )
        : {
            type: "info",
            message: "Update ready.",
            detail:
              outcome.version === null
                ? "Restart Context to install it. Any meeting in progress is never interrupted."
                : `Version ${outcome.version} is ready to install. Restarting takes a few seconds, and any meeting in progress is never interrupted.`,
            buttons: ["Restart Now", "Later"],
            defaultId: 0,
            cancelId: 1,
            installButton: 0,
          };
    case "error":
      return acknowledge(
        "warning",
        "Context could not check for updates.",
        "Try again in a bit. The app did not expose release URLs or credentials in this message.",
      );
  }
}

/**
 * *Restart Now* pressed, and `mayInstall()` said no.
 *
 * The only way to reach it is to start recording between the dialog opening and
 * the button being pressed — rare, and the one case where the person deserves a
 * sentence rather than a button that silently did nothing.
 */
export const INSTALL_REFUSED_PROMPT: UpdatePrompt = acknowledge(
  "info",
  "Context is recording a meeting.",
  "The update is downloaded and will install when the recording has ended and you restart.",
);
