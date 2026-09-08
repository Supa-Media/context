/**
 * The shell hosts a page it did not write, so the origin is a security control.
 *
 * `shouldExposeBridge` is the guard between a document and `window.desktop`,
 * and `window.desktop` is the only route from a page to this app's microphone.
 * Everything about it is a pure function precisely so it can be checked here
 * rather than by launching Electron and pointing it at a hostile server — which
 * is another way of saying it is checked at all.
 *
 * `consoleUrl` is the other half: what the shell is willing to load. A shell
 * that will host plaintext from a public host is a shell whose UI can be
 * replaced in transit, and that UI is the thing that asks to record.
 *
 * ## Sabotage record
 *
 *   `shouldExposeBridge` returning true instead of `origin === pinned`       5
 *   `shouldExposeBridge` dropping the `isTopFrame` check                     1
 *   `consoleUrl` accepting any `http:`                                       3
 *   `isLoopback` matching a hostname that *contains* `localhost`             2
 *   `desktopUiMode` defaulting to the renderer again                        4
 *   `desktopUiMode` losing the `renderer` escape hatch                      2
 *   `desktopUiMode` reading the value raw rather than trimmed and lowered   1
 *   `desktopUiMode` passing a misspelt mode through                         1
 *   `consoleUrl` choosing its fallback from `NODE_ENV` again                4
 *   `mayGrantConsolePermission` returning true for everything               4
 *   `mayGrantConsolePermission` returning false for everything              2
 *   `media` added to `CONSOLE_PERMISSIONS`                                  2
 *   `clipboard-read` added to `CONSOLE_PERMISSIONS`                         2
 *
 * Three of those are worth writing down rather than just counting.
 *
 * **The `NODE_ENV` row is the one this file got wrong for months.** These
 * checks used to be written as `consoleUrl({ NODE_ENV: "production" })`, which
 * made them a proof about a variable nothing sets — so the suite was green for
 * the production branch while every packaged build took the development one and
 * opened a window on a dead `localhost` port. A unit check that supplies the
 * input the wiring never supplies is not a check of the wiring; `--smoke`
 * reports the address a real launch resolved, and this file now takes the same
 * `packaged` flag the app does.
 *
 * **The subframe sabotage reports one, not two**, and the second subframe check
 * is the reason: a cross-origin iframe is still refused by the origin
 * comparison, so it does not witness `isTopFrame` at all. It is kept because it
 * pins the *combination* — the day somebody relaxes the origin rule for a
 * sibling origin, that check is what stops an iframe inheriting the relaxation
 * — but only the same-origin subframe check actually guards this line.
 *
 * **The two `desktopUiMode` rows are the two halves of step 4**, and both have
 * to be non-zero for the step to be what it claims: the default really is the
 * console now, *and* `CONTEXT_DESKTOP_UI=renderer` really does still put the old
 * windows back. A step that is only the first half is not revertible by an
 * environment variable, which is the property the migration order rests on.
 *
 * **The loopback sabotage is why the set is matched on the whole hostname.**
 * Written as `hostname.includes("localhost")` every other check stays green and
 * `https`-only quietly stops being true for `localhost.attacker.invalid` — the
 * same shape `docs/decisions/meetings.md` records for the transcription
 * Worker's address.
 */

import {
  BRIDGE_VERSION,
  CONSOLE_PERMISSIONS,
  DEFAULT_CONSOLE_URL,
  DEV_CONSOLE_URL,
  NO_CAPABILITIES,
  consoleOrigin,
  consoleUrl,
  desktopUiMode,
  mayGrantConsolePermission,
  shouldExposeBridge,
  unexpectedConsoleAddress,
} from "../src/core/shell/console.ts";

const PINNED = "https://context.lc";

/** The shape the real preload passes; every check varies one field of it. */
function exposure(overrides = {}) {
  return { pinned: PINNED, origin: PINNED, isTopFrame: true, ...overrides };
}

export function runShellChecks(check) {
  // --- the bridge is exposed to exactly one document ------------------------

  check("the pinned origin, in the top frame, gets the bridge", shouldExposeBridge(exposure()) === true);

  check(
    "A FOREIGN ORIGIN GETS NO BRIDGE",
    shouldExposeBridge(exposure({ origin: "https://attacker.invalid" })) === false,
  );
  check(
    "A SUFFIXED LOOKALIKE GETS NO BRIDGE",
    shouldExposeBridge(exposure({ origin: "https://context.lc.attacker.invalid" })) === false,
  );
  check(
    "a prefix of the pinned origin gets no bridge",
    shouldExposeBridge(exposure({ origin: "https://context.l" })) === false,
  );
  check(
    "the same host on another scheme gets no bridge",
    shouldExposeBridge(exposure({ origin: "http://context.lc" })) === false,
  );
  check(
    "the same host on another port gets no bridge",
    shouldExposeBridge(exposure({ origin: "https://context.lc:8443" })) === false,
  );
  check(
    "AN OPAQUE ORIGIN GETS NO BRIDGE — about:blank and data: both report null",
    shouldExposeBridge(exposure({ origin: "null" })) === false,
  );
  check(
    "an unset pin exposes nothing, rather than matching an unset origin",
    shouldExposeBridge({ pinned: "", origin: "", isTopFrame: true }) === false,
  );
  check(
    "a pin the main process failed to answer exposes nothing even to `null`",
    shouldExposeBridge({ pinned: "null", origin: "null", isTopFrame: true }) === false,
  );
  check(
    "A SUBFRAME GETS NO BRIDGE, EVEN ON THE PINNED ORIGIN",
    shouldExposeBridge(exposure({ isTopFrame: false })) === false,
  );
  check(
    "a cross-origin subframe gets no bridge either",
    shouldExposeBridge(exposure({ origin: "https://attacker.invalid", isTopFrame: false })) === false,
  );

  // --- which UI a launch hosts ----------------------------------------------

  check("THE DEFAULT UI IS THE HOSTED CONSOLE", desktopUiMode({}) === "console");
  check("...and an unset variable is the same as no variable", desktopUiMode({ CONTEXT_DESKTOP_UI: undefined }) === "console");
  check(
    "THE OLD RENDERER IS ONE ENVIRONMENT VARIABLE AWAY, which is what makes this revertible",
    desktopUiMode({ CONTEXT_DESKTOP_UI: "renderer" }) === "renderer",
  );
  check(
    "...however it was typed or padded",
    desktopUiMode({ CONTEXT_DESKTOP_UI: " Renderer " }) === "renderer",
  );
  check(
    "an explicit `console` is still the console",
    desktopUiMode({ CONTEXT_DESKTOP_UI: "console" }) === "console",
  );
  check(
    "A MISSPELT MODE IS THE DEFAULT, NOT A REFUSAL — a shell with no UI is the worse failure",
    desktopUiMode({ CONTEXT_DESKTOP_UI: "renderrer" }) === "console" &&
      desktopUiMode({ CONTEXT_DESKTOP_UI: "" }) === "console",
  );

  {
    // The three facts a default launch depends on, in one place: it hosts the
    // console, at an address it derived rather than one typed twice, and that
    // address is the origin — and the only origin — the bridge is exposed to.
    const env = {};
    const url = desktopUiMode(env) === "console" ? consoleUrl(env, true) : null;
    const origin = url === null ? "" : consoleOrigin(url);
    check(
      "A DEFAULT LAUNCH OPENS THE CONSOLE, AND THE BRIDGE IS PINNED TO WHAT IT OPENED",
      origin === "https://context.lc" &&
        shouldExposeBridge({ pinned: origin, origin, isTopFrame: true }) === true &&
        shouldExposeBridge({ pinned: origin, origin: "https://attacker.invalid", isTopFrame: true }) ===
          false,
    );
  }

  // --- what the shell is willing to load ------------------------------------

  /*
    THE INSTALLED APP IS THE CASE THAT WAS NEVER CHECKED.

    These four used to be spelled `{ NODE_ENV: "production" }` and
    `{ NODE_ENV: "development" }`, which made them a check of a variable
    **nothing sets**: not `scripts/build.mjs`, not `electron-builder.yml`, not
    `deploy-desktop.yml`, not Electron, and not the launchd environment an app
    launched from the Dock inherits. So the suite proved the production branch
    worked while every packaged build took the development one, pointed at
    `http://localhost:8081`, and opened an empty window on the owner's Mac.

    `packaged` is `app.isPackaged`, which is true of exactly the builds this got
    wrong. The unit checks are necessary and are not sufficient — it is the
    *wiring* that broke, and `test/launch.smoke.mjs` is what reads the address a
    real launch resolved.
  */
  check(
    "A PACKAGED BUILD LOADS THE HOSTED CONSOLE, NOT A DEAD LOCALHOST",
    consoleUrl({}, true) === `${DEFAULT_CONSOLE_URL}`,
  );
  check(
    "with nothing set, a development launch loads the dev server",
    consoleUrl({}, false).startsWith(DEV_CONSOLE_URL),
  );
  check(
    "A SELF-HOSTER'S OWN ORIGIN BEATS BOTH DEFAULTS",
    consoleUrl({ CONTEXT_DESKTOP_UI_URL: "https://context.example/console" }, false) ===
      "https://context.example/console" &&
      consoleUrl({ CONTEXT_DESKTOP_UI_URL: "https://context.example/console" }, true) ===
        "https://context.example/console",
  );
  check(
    "an empty variable is the same as an unset one",
    consoleUrl({ CONTEXT_DESKTOP_UI_URL: "   " }, true) === DEFAULT_CONSOLE_URL,
  );

  check("http on loopback is allowed, because `expo start` is one", (() => {
    try {
      return consoleUrl({ CONTEXT_DESKTOP_UI_URL: "http://127.0.0.1:8081" }, false).startsWith(
        "http://127.0.0.1:8081",
      );
    } catch {
      return false;
    }
  })());

  function refuses(value) {
    try {
      consoleUrl({ CONTEXT_DESKTOP_UI_URL: value }, true);
      return false;
    } catch {
      return true;
    }
  }

  check("HTTP ON A PUBLIC HOST IS REFUSED, NOT LOADED", refuses("http://context.lc/console"));
  check(
    "A HOST THAT MERELY LOOKS LIKE LOOPBACK IS REFUSED",
    refuses("http://127.0.0.1.attacker.invalid/console"),
  );
  check(
    "a host that merely contains `localhost` is refused",
    refuses("http://localhost.attacker.invalid/console"),
  );
  check("a `file:` URL is refused", refuses("file:///tmp/console.html"));
  check("a `javascript:` URL is refused", refuses("javascript:alert(1)"));
  check("something that is not a URL at all is refused", refuses("context.lc/console"));

  check(
    "the pinned origin is derived from the URL rather than configured twice",
    consoleOrigin("https://context.example/console?x=1#y") === "https://context.example",
  );

  /*
    ── THE ADDRESS A LAUNCH REALLY RESOLVED ─────────────────────────────────

    `unexpectedConsoleAddress` is what `--smoke` exits non-zero on, and it is the
    half of F3 the unit checks above cannot be: those ask `consoleUrl` a question
    with the right arguments and get the right answer, which is exactly what the
    suite did while every installed build opened a blank window. This one is
    asked *about the address the window was pointed at*, so the wrong answer is
    visible whatever produced it.

    Sabotage record, run as temporary local edits and reverted. Counts are FAIL
    lines across the whole `apps/desktop` suite.

      returning `null` unconditionally (the guard made a no-op)               6
      dropping the packaged-launch loopback refusal, alone                    0
      dropping the unpackaged-launch production refusal, alone                0
      `consoleUrl`'s fallback regressed to the dev URL for every build        4
      ...and the packaged-launch loopback refusal dropped as well             6

    **Two of those rows are zero, and they are written down rather than left
    out.** The last check in this function compares the resolved address with
    what `consoleUrl` says this launch resolves, and in a healthy tree that
    comparison already refuses everything the two explicit refusals refuse. A
    reviewer counting FAIL lines would conclude those branches are dead.

    They are not, and the last two rows are the witness. The comparison asks
    `consoleUrl` a second time and **agrees with a bug inside it** — precisely
    the failure this file's header records about `NODE_ENV`, where the suite
    was green for months about a variable nothing sets. With `consoleUrl`
    regressed so that every build resolves the dev URL, `A PACKAGED LAUNCH
    POINTED AT LOOPBACK IS A FAILED SMOKE RUN` still holds, because the
    refusal states a fact about the world instead of re-deriving one; delete
    the refusal on top of that and it goes red with two others. The explicit
    refusals are the half that survives the function being wrong.

    The first row is the one worth naming: made `() => null` this function
    still typechecks, `--smoke` still exits 0, and the release gate still goes
    green on the build that shipped — which is the whole failure this PR is
    about, arriving one layer further out.
  */
  check(
    "A PACKAGED LAUNCH POINTED AT LOOPBACK IS A FAILED SMOKE RUN",
    unexpectedConsoleAddress({}, true, "http://localhost:8081/") !== null,
  );
  check(
    "...and that is true of every spelling of loopback",
    ["http://127.0.0.1:8081/", "http://[::1]:8081/"].every(
      (address) => unexpectedConsoleAddress({}, true, address) !== null,
    ),
  );
  check(
    "a packaged launch on the hosted console is fine",
    unexpectedConsoleAddress({}, true, DEFAULT_CONSOLE_URL) === null,
  );
  check(
    "AN UNPACKAGED LAUNCH POINTED AT PRODUCTION IS A FAILED SMOKE RUN",
    unexpectedConsoleAddress({}, false, DEFAULT_CONSOLE_URL) !== null,
  );
  check(
    "a development launch on the dev server is fine",
    unexpectedConsoleAddress({}, false, `${DEV_CONSOLE_URL}/`) === null,
  );
  check(
    "A SELF-HOSTER WHO ASKED FOR AN ADDRESS GETS IT, PACKAGED OR NOT",
    unexpectedConsoleAddress(
      { CONTEXT_DESKTOP_UI_URL: "https://context.example/console" },
      true,
      "https://context.example/console",
    ) === null,
  );
  check(
    "...but an address nobody asked for is still refused, override or no override",
    unexpectedConsoleAddress(
      { CONTEXT_DESKTOP_UI_URL: "https://context.example/console" },
      true,
      "https://somewhere.else.invalid/console",
    ) !== null,
  );
  check(
    "a window that resolved no address at all is a failure, not a pass",
    unexpectedConsoleAddress({}, true, null) !== null,
  );
  check(
    "and the failure says which address it found, because that is the diagnostic",
    (unexpectedConsoleAddress({}, true, "http://localhost:8081/") ?? "").includes("localhost:8081"),
  );

  // --- the version-1 surface -------------------------------------------------

  check("the bridge version is an integer the web build can compare", Number.isInteger(BRIDGE_VERSION));
  check(
    "every capability of this step answers no",
    Object.values(NO_CAPABILITIES).every((value) => value === false),
  );
  check(
    "the capability probe names system audio, which no version number could predict",
    Object.hasOwn(NO_CAPABILITIES, "systemAudio"),
  );

  // --- what the console window may ask the operating system for ------------
  //
  // "Copy note" did nothing: pressed, clipboard unchanged. The console's
  // session denied every permission request — written about the microphone, and
  // right about the microphone — and Chromium routes
  // `navigator.clipboard.writeText` through a `clipboard-sanitized-write`
  // request, so the one way a finished meeting gets off this machine was
  // refused as collateral.
  //
  // The list is the security boundary, so it is checked here rather than
  // written inline in `main/windows.ts`, which imports `electron` and which
  // nothing in this suite can load.

  check(
    "the clipboard write a Copy button needs is granted",
    mayGrantConsolePermission("clipboard-sanitized-write") === true,
  );
  check(
    "...under the other spelling Chromium uses for it too",
    mayGrantConsolePermission("clipboard-write") === true,
  );
  check(
    "READING THE CLIPBOARD IS NOT GRANTED, because no feature here needs it",
    mayGrantConsolePermission("clipboard-read") === false,
  );
  check(
    "THE MICROPHONE IS STILL REFUSED: it belongs to the capture window and the gate",
    mayGrantConsolePermission("media") === false,
  );
  check(
    "...and so is everything else a hosted page might ask for",
    ["geolocation", "notifications", "midi", "display-capture", "openExternal", "fullscreen"].every(
      (permission) => mayGrantConsolePermission(permission) === false,
    ),
  );
  check(
    "a permission Chromium invents later is refused until somebody adds it on purpose",
    mayGrantConsolePermission("some-permission-from-2028") === false,
  );
  check(
    "the list is exactly the clipboard writes, and nothing has crept onto it",
    [...CONSOLE_PERMISSIONS].every((permission) => permission.startsWith("clipboard-")) &&
      !CONSOLE_PERMISSIONS.includes("clipboard-read"),
  );
}
