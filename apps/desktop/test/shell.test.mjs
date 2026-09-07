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
 * **The loopback sabotage is why the set is matched on the whole hostname.**
 * Written as `hostname.includes("localhost")` every other check stays green and
 * `https`-only quietly stops being true for `localhost.attacker.invalid` — the
 * same shape `docs/decisions/meetings.md` records for the transcription
 * Worker's address.
 */

import { readFile } from "node:fs/promises";

import {
  BRIDGE_VERSION,
  DEFAULT_CONSOLE_URL,
  DEV_CONSOLE_URL,
  NO_CAPABILITIES,
  consoleOrigin,
  consoleUrl,
  mayAnswerSender,
  shouldExposeBridge,
} from "../src/core/shell/console.ts";

const PINNED = "https://context.lc";

/**
 * `main/index.ts` as text, because this suite cannot import it.
 *
 * It imports Electron at the top level, which is the whole reason the rules it
 * enforces live in `core/`. Read at module scope so the checks below stay
 * synchronous.
 */
const mainSource = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");

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

  // --- and the main process answers only its own window ---------------------

  /*
    THE OTHER HALF, WHICH `shouldExposeBridge`'S DOCBLOCK CLAIMED EXISTED.

    It said: "The main process re-checks the sender on every channel it handles
    … this one decides what is exposed, that one decides what is answered, and
    either alone leaves a hole." MEASURED at the time: `senderFrame` and
    `event.sender` appeared nowhere in `apps/desktop/src`, and not one of the
    fourteen `ipcMain` handlers looked at who was asking. The layer was prose.

    Nothing leaked — both console channels answer public values, and every other
    renderer in this app loads a local file with a preload that exposes no way
    to send. But the sentence is the one a person adding the NEXT channel reads,
    and the next channels are the ones this docblock calls "the only route from
    a page to this app's microphone". So it is a check now.

    The evidence is frame IDENTITY rather than the sender's origin, and that is
    deliberate: identity is unambiguous at preload time, where an origin the
    main process reads off a frame mid-navigation is a lifecycle assumption this
    suite cannot test. The origin comparison stays in `shouldExposeBridge`,
    where `location.origin` is the document's own and is exactly the layer a
    redirect has to get past.
  */
  const sender = (overrides = {}) => ({
    isConsoleWindow: true,
    isMainFrame: true,
    ...overrides,
  });

  check("the console window's main frame is answered", mayAnswerSender(sender()) === true);
  check(
    "ANOTHER WINDOW IN THIS APP IS NOT ANSWERED ON A CONSOLE CHANNEL",
    mayAnswerSender(sender({ isConsoleWindow: false })) === false,
  );
  check(
    "A SUBFRAME IS NOT ANSWERED, EVEN INSIDE THE CONSOLE WINDOW",
    mayAnswerSender(sender({ isMainFrame: false })) === false,
  );
  check(
    "a frame that has already gone away is not answered",
    mayAnswerSender({ isConsoleWindow: false, isMainFrame: false }) === false,
  );
  check(
    "...and neither is one whose evidence is missing rather than false",
    mayAnswerSender({}) === false && mayAnswerSender(null) === false,
  );

  /*
    AND THE HANDLERS HAVE TO USE IT.

    A predicate nothing calls is the same prose in a different font, and this
    file cannot import `main/index.ts` to find out — it imports Electron at the
    top level, which is the whole reason the rule lives in `core/`. So the
    source is read: every `ipcMain.on` for a console channel must have the gate
    on it. Counted rather than merely matched, so deleting one handler's gate
    cannot be hidden by the other one still having it.
  */
  const consoleHandlers = [...mainSource.matchAll(/ipcMain\.on\(CONSOLE_[A-Z_]+_CHANNEL, \(event\) => \{\n(.*?)\n  \}\);/gs)];
  check(
    "BOTH CONSOLE CHANNELS ARE REGISTERED, so this check is reading something",
    consoleHandlers.length === 2,
  );
  check(
    "...and every one of them refuses a sender the gate rejects",
    consoleHandlers.length === 2 &&
      consoleHandlers.every(([, body]) => body.includes("mayAnswerSender(")),
  );

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
