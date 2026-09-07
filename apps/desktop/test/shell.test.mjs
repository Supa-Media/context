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
 *
 * Two of those are worth writing down rather than just counting.
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
  DEFAULT_CONSOLE_URL,
  DEV_CONSOLE_URL,
  NO_CAPABILITIES,
  consoleOrigin,
  consoleUrl,
  desktopUiMode,
  shouldExposeBridge,
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
    const env = { NODE_ENV: "production" };
    const url = desktopUiMode(env) === "console" ? consoleUrl(env) : null;
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

  check(
    "with nothing set, a production launch loads the hosted console",
    consoleUrl({ NODE_ENV: "production" }) === `${DEFAULT_CONSOLE_URL}`,
  );
  check(
    "with nothing set, a development launch loads the dev server",
    consoleUrl({ NODE_ENV: "development" }).startsWith(DEV_CONSOLE_URL),
  );
  check(
    "a self-hoster's https origin is honoured",
    consoleUrl({ CONTEXT_DESKTOP_UI_URL: "https://context.example/console" }) ===
      "https://context.example/console",
  );
  check(
    "an empty variable is the same as an unset one",
    consoleUrl({ CONTEXT_DESKTOP_UI_URL: "   ", NODE_ENV: "production" }) === DEFAULT_CONSOLE_URL,
  );

  check("http on loopback is allowed, because `expo start` is one", (() => {
    try {
      return consoleUrl({ CONTEXT_DESKTOP_UI_URL: "http://127.0.0.1:8081" }).startsWith("http://127.0.0.1:8081");
    } catch {
      return false;
    }
  })());

  function refuses(value) {
    try {
      consoleUrl({ CONTEXT_DESKTOP_UI_URL: value, NODE_ENV: "production" });
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
}
