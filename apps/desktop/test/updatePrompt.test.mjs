/**
 * The "Check for Updates…" dialog, and the button that was missing from it.
 *
 * The report this file is the guard for, verbatim: *"check for updates on
 * desktop just says ready to install, but nothing else, no way to actually
 * install it"* — a modal saying **"Update ready. Version 0.1.44 is ready to
 * install."** over a single *OK*. The update was downloaded and installable;
 * the verb lived in a menu-bar item the dialog never mentioned.
 *
 * So the load-bearing check here is the dull-sounding one: the ready prompt has
 * an `installButton`. Everything else guards the two ways of "fixing" it that
 * would be worse than the bug — offering the install while a meeting is
 * recording, where `mayInstall()` refuses it and the button lies, and letting a
 * *Later* or a closed sheet be read as consent to quit.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; each was watched go red.
 *
 *   `installButton: null` on the ready prompt (the original bug)              3
 *   the deferred prompt given the two-button ready shape                      1
 *   `defaultId`/`cancelId` swapped on the ready prompt                        2
 *   `index.ts` calling `install()` without comparing `answer.response`        1
 *   `index.ts` dropping the `install()` refusal branch                        1
 */

import { readFileSync } from "node:fs";
import { INSTALL_REFUSED_PROMPT, updateCheckPrompt } from "../src/core/update/prompt.ts";

const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

export function runUpdatePromptChecks(check) {
  const ready = updateCheckPrompt({ type: "downloaded", version: "0.1.44", deferred: false });

  // --- the bug ---------------------------------------------------------------

  check(
    "A DOWNLOADED UPDATE OFFERS A BUTTON THAT INSTALLS IT — the reported bug",
    ready.installButton !== null && ready.buttons[ready.installButton] === "Restart Now",
  );
  check(
    "...and a way out that is not it",
    ready.buttons.length === 2 && ready.cancelId !== ready.installButton,
  );
  check(
    "...with the install as the default button, because that is why the person opened the box",
    ready.defaultId === ready.installButton && ready.cancelId === 1,
  );
  check("...and it still names the version", ready.detail.includes("0.1.44"));
  check(
    "a downloaded update whose version is unknown still offers the install",
    updateCheckPrompt({ type: "downloaded", version: null, deferred: false }).installButton === 0,
  );

  // --- the meeting still wins -------------------------------------------------

  const deferred = updateCheckPrompt({ type: "downloaded", version: "0.1.44", deferred: true });
  check(
    "AN UPDATE DEFERRED BY A RECORDING OFFERS NO INSTALL BUTTON — `mayInstall()` would refuse it",
    deferred.installButton === null && deferred.buttons.length === 1,
  );
  check(
    "...and says what happens instead",
    deferred.detail.includes("recording") && deferred.detail.includes("restart Context to install"),
  );
  check(
    "a refused install is explained rather than swallowed",
    INSTALL_REFUSED_PROMPT.installButton === null &&
      INSTALL_REFUSED_PROMPT.message.includes("recording") &&
      INSTALL_REFUSED_PROMPT.detail.includes("downloaded"),
  );

  // --- every other outcome is news, not a verb ---------------------------------

  for (const outcome of [
    { type: "not-started" },
    { type: "unarmed" },
    { type: "checking" },
    { type: "no-update" },
    { type: "error" },
  ]) {
    const prompt = updateCheckPrompt(outcome);
    check(
      `the "${outcome.type}" prompt has nothing to press but OK`,
      prompt.installButton === null &&
        prompt.buttons.length === 1 &&
        prompt.defaultId === 0 &&
        prompt.cancelId === 0,
    );
  }
  check(
    "a failed check is a warning, not cheerful news",
    updateCheckPrompt({ type: "error" }).type === "warning",
  );
  check(
    "no prompt leaks a release URL or a credential-looking string",
    [
      updateCheckPrompt({ type: "error" }),
      updateCheckPrompt({ type: "unarmed" }),
      ready,
      INSTALL_REFUSED_PROMPT,
    ].every((prompt) => !/https?:\/\/|token|Bearer/i.test(`${prompt.message} ${prompt.detail}`)),
  );

  // --- the wiring, read as text (`main/index.ts` needs Electron to execute) -----

  check(
    "THE DIALOG INSTALLS ONLY WHEN THE INSTALL BUTTON WAS THE ONE PRESSED",
    /if \(installButton === null \|\| answer\.response !== installButton\) return;/.test(source),
  );
  check(
    "...through `updater.install()`, which re-asks `mayInstall()` at the click",
    /const installNow = \(\) => \{[\s\S]*?updater\.install\(\)/.test(source) &&
      /showUpdateCheckMessage\(outcome, installNow\)/.test(source),
  );
  check(
    "...and a refusal is said out loud rather than doing nothing",
    /if \(!install\(\)\) sayInstallRefused\(\);/.test(source),
  );
  check(
    "A REFUSAL WITH NO WINDOW IS A NOTIFICATION, NEVER AN APPLICATION-MODAL ALERT MID-RECORDING",
    /function sayInstallRefused\(\): void \{[\s\S]*?if \(parent === null\) \{\s*showNativeNotification\(/.test(
      source,
    ),
  );
}
