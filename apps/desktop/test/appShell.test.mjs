/**
 * THIS IS AN APPLICATION, AND A PERSON HAS TO BE ABLE TO OPEN IT.
 *
 * Three defects arrived together in the first signed, notarised build, and all
 * three are about what happens between double-clicking the icon and having a
 * working app on screen:
 *
 *  1. it threw `Dynamic require of "events"` before `app.whenReady()` and
 *     showed a crash dialog;
 *  2. it had no Dock tile, no app-switcher entry and no application menu, so
 *     the owner's report was *"I dont even see a launched app, I should be able
 *     to open the app locally like all these other apps"*;
 *  3. it resolved `http://localhost:8081` as its console address, where nothing
 *     on a person's Mac is listening, and would have opened a blank window.
 *
 * **`test/launch.smoke.mjs` is the guard for all three**, because it starts the
 * app and reads the answers off a running process. This file is the second
 * line, and it is honest about being second: everything here is `main/index.ts`
 * and `electron-builder.yml` read as *text*, which is the same technique
 * `trayOnly.test.mjs` and `consoleBridge.test.mjs` already use for wiring that
 * needs Electron to execute. It runs in the ordinary offline suite, on any
 * runner, with no build and no display — so a pull request that quietly undoes
 * one of these goes red at pull-request time rather than at install time.
 *
 * Comments are stripped before anything is matched, and there is a self-test
 * for the stripper. `docs/decisions/testing.md` names the exact failure that
 * makes this necessary: *"an import guard that read English prose as code"* —
 * and the prose in these files now argues at length about `NODE_ENV`,
 * `LSUIElement` and `app.dock.hide()`, every one of which a naive `includes()`
 * would find and call a defect.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite.
 *
 *   the Dock hidden unconditionally, not only in renderer mode              2
 *   `installApplicationMenu()` removed from `main()`                        2
 *   renderer mode losing `app.dock.hide()` (the escape hatch changes too)   2
 *   `{ role: "paste" }` removed from the Edit menu                          1
 *   `{ role: "close" }` removed from the Window menu                        1
 *   `{ role: "toggleDevTools" }` added to the View menu                     1
 *   the `activate` handler deleted                                          1
 *   `window-all-closed` calling `app.quit()`                                1
 *   the packaged flag never reaching `consoleUrl`                           1
 *   `LSUIElement: true` put back in `electron-builder.yml`                  1
 *   the `NODE_ENV` fallback restored in `core/shell/console.ts`             4
 *   the comment stripper made a no-op (its own self-test)                   3
 *   `--smoke` no longer asking `unexpectedConsoleAddress`                   1
 *   `--smoke` no longer asking about the application menu                   1
 *   the `SMOKE_DEADLINE_MS` timer deleted                                   1
 *   `smokeLoadFailure`'s call moved outside its `if (SMOKE_LOAD)` guard     1
 *   `[smoke]`'s `loaded` field hardcoded to `false`                         1
 *   `--smoke-load` reading the mirror before `awaitSnapshot` resolves       1
 *   `EFFECTIVE_SMOKE_DEADLINE_MS` collapsed back to `SMOKE_DEADLINE_MS`     1
 *   the fallback navigation never awaited before reading the window's URL   1
 *   `mirrorServed` hardcoded rather than asked of the window's own URL      1
 *   the permission notice reverted to "Open the menu bar to grant it"       3
 *   the permission sentence defaulting to the microphone again              1
 *   nothing logging the real text of a capture failure                      1
 *   the shell's `transcriber` branch removed                                1
 *   `explain` back to a parentless, application-modal alert                 1
 *   `explain`'s windowless fallback made a blocking alert                   2
 *   `askSomething` never passing the parent window                          1
 *   the connect question asked with `dialog.showMessageBox` directly        2
 *   `imessage.reconfigure()` back where #329 had it                         2
 *   `push()` hoisted above `const tray`                                     1
 *   `loop.start()` hoisted above `const tray`                               1
 *
 * **The guard row is the one worth reading twice.** `smokeLoadFailure`'s call
 * has to live *inside* `if (SMOKE_LOAD)`, because plain `--smoke` is what the
 * release gate runs on every pull request, on a runner with no route to
 * `context.lc` at all. Moving it outside that guard would fail every offline
 * release for a reason that has nothing to do with a crash — the exact false
 * alarm `SMOKE_DEADLINE_MS`'s own widening already argues against, one layer
 * further out.
 *
 * **The `mirrorServed` rows are the finding that fix was about, made a check.** A
 * Mac session found `--smoke-load` exiting 1 offline even when the mirror had
 * just served a real document — `loaded:false` and nothing else was asked.
 * `mirrorServed` and `wasMirrorServed` (`core/shell/mirror.ts`) are what tells
 * "no network" apart from "broken app", and `smokeLoadFailure` is the one
 * place the exit rule is stated: `loaded || mirrorServed`, not `loaded` alone.
 * Reverting that rule to `loaded` alone — the exact bug — reddens **1** check
 * in `test/mirror.test.mjs`, run as a temporary local edit and reverted:
 * `smokeLoadFailure`'s own docblock names the run.
 *
 * The stripper row is why the stripper has a self-test at all: made into `(s) => s`
 * the three checks that scan for an *absent* string all invert, because the
 * prose these files carry mentions every string they are being checked for. A
 * stripper that does nothing turns this file into a check that the
 * *documentation* is present.
 *
 * The third row is worth its own sentence: the sabotage that deletes
 * `app.dock.hide()` altogether is caught too, because F2 is *conditional*.
 * Making a console launch a real app is not licence to change what
 * `CONTEXT_DESKTOP_UI=renderer` does, and the migration order rests on that
 * mode still being what it was.
 *
 * ## And one that is not here
 *
 * Reverting the main bundle to `format: "esm"` — the defect that shipped — is
 * **not** caught by anything in this file, and nothing in the offline suite
 * could catch it: the bundle is not built when this runs. It is caught by
 * `test/launch.smoke.mjs`, which starts the app. Measured against a packaged
 * `.app` rebuilt with the shipped configuration: no `[smoke]` line, no output
 * at all, and a process still alive at sixty seconds until the harness killed
 * it.
 */

import { readFileSync } from "node:fs";

/**
 * Source with its comments removed, so a rule is matched against code.
 *
 * Block comments only, and deliberately: a line-comment stripper would have to
 * decide whether `//` inside `"https://context.lc/console"` starts one, and
 * every sentence this file needs to ignore is in a `/** ... *\/` docblock. YAML
 * is `#` to end of line, which has the same hazard for a `#` inside a string
 * and none of the same need — `electron-builder.yml`'s values are plain.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The same idea for YAML, where a comment is `#` to end of line.
 *
 * Exported because `packaging.test.mjs` needs it too. `electron-builder.yml`'s
 * comments now argue about the app icon at length — naming `icon.icns`, the
 * default path and `CFBundleIconFile` — so a check for the icon run against the
 * raw file would pass on the paragraph explaining the icon rather than on the
 * key that sets it. One stripper with one self-test, rather than a second copy
 * over there that nothing checks.
 */
export function withoutYamlComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");
}

export function runAppShellChecks(check) {
  const raw = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const source = withoutComments(raw);
  const consoleRaw = readFileSync(new URL("../src/core/shell/console.ts", import.meta.url), "utf8");
  const consoleSource = withoutComments(consoleRaw);
  const builderRaw = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const builder = withoutYamlComments(builderRaw);

  /* --- the checker itself ------------------------------------------------- */

  check(
    "THE COMMENT STRIPPER ACTUALLY STRIPS — otherwise this file checks the prose",
    withoutComments('/* app.dock.hide(); */ const a = 1;').includes("app.dock") === false &&
      withoutComments("/** NODE_ENV */\nconst b = 2;").includes("NODE_ENV") === false &&
      withoutComments("const c = 3;").includes("const c = 3;") &&
      withoutYamlComments("  # LSUIElement: true\n  type: distribution").includes("LSUIElement") === false &&
      withoutYamlComments("  type: distribution").includes("type: distribution"),
  );
  check(
    "...and these files really do argue about the strings being checked",
    builderRaw.includes("LSUIElement") && consoleRaw.includes("NODE_ENV"),
  );

  /* --- defect 2: a Dock tile, an app switcher entry and a menu ------------- */

  check(
    "A CONSOLE LAUNCH — THE DEFAULT — IS NOT HIDDEN FROM THE DOCK",
    /async function main\(\): Promise<void> \{\s*if \(RENDERER_UI\) app\.dock\?\.hide\(\);\s*else installApplicationMenu\(\);/.test(
      source,
    ) && (source.match(/app\.dock\??\.hide\(\)/g) ?? []).length === 1,
  );
  check(
    "...and `LSUIElement` is gone from the packaged Info.plist, so the default really is an app",
    builder.includes("LSUIElement") === false,
  );
  check(
    "THE MENU-BAR-ONLY MODE SURVIVES FOR `CONTEXT_DESKTOP_UI=renderer`",
    /if \(RENDERER_UI\) app\.dock\?\.hide\(\);/.test(source),
  );
  check(
    "AN APPLICATION MENU IS INSTALLED IN CONSOLE MODE",
    /Menu\.setApplicationMenu\(/.test(source) && /else installApplicationMenu\(\);/.test(source),
  );
  {
    /*
      The console hosts a text editor. On macOS Cmd-C, Cmd-V, Cmd-X, Cmd-Z and
      Cmd-A are menu key equivalents and nothing else — with no Edit menu they
      are dead keys, in a window somebody is typing a meeting note into.
    */
    const menu = source.match(/function installApplicationMenu\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    const roles = [...menu.matchAll(/role: "([a-zA-Z]+)"/g)].map((match) => match[1]);
    check(
      "THE EDIT MENU CARRIES THE CLIPBOARD AND UNDO ROLES",
      ["undo", "redo", "cut", "copy", "paste", "selectAll"].every((role) => roles.includes(role)),
    );
    check(
      "CMD-W CLOSES THE WINDOW AND CMD-Q QUITS",
      roles.includes("close") && roles.includes("quit"),
    );
    check(
      "...and no developer tools in a shipped build",
      roles.includes("toggleDevTools") === false,
    );
  }
  check(
    "A DOCK CLICK REOPENS A WINDOW THAT WAS CLOSED, RATHER THAN ONLY RAISING ONE",
    /app\.on\("activate", \(\) => \{[\s\S]*?openConsoleWindow\(\)[\s\S]*?\}\);/.test(source),
  );
  check(
    "CLOSING THE LAST WINDOW DOES NOT QUIT, SO A RECORDING SURVIVES IT",
    /app\.on\("window-all-closed", \(\) => undefined\);/.test(source),
  );

  /* --- defect 3: which address an installed build resolves ----------------- */

  check(
    "THE CONSOLE ADDRESS IS CHOSEN BY `app.isPackaged`",
    /consoleUrl\(process\.env, app\.isPackaged\)/.test(source),
  );
  check(
    "...and by nothing named NODE_ENV, which nothing in this repository sets",
    source.includes("NODE_ENV") === false && consoleSource.includes("NODE_ENV") === false,
  );

  /* --- the gate itself: `--smoke`'s exit code has to carry the verdict ----- */

  /*
    THE RELEASE STEP READS AN EXIT CODE AND NOTHING ELSE.

    `test/launch.smoke.mjs` asserts the address, the Dock tile and the menu from
    outside the process — but `deploy-desktop.yml` runs the packaged binary
    directly, because the runner has a `.app` and not a checkout. Anything the
    app does not check itself is therefore not checked by the release gate, and
    F3 in particular would have gone out green a second time: a build pointed at
    `http://localhost:8081` still initialises, still opens a window, and still
    prints its line.

    Matched as *code*, after the stripper, because the smoke block's own
    comments argue about `localhost:8081` and about menu roles at length.
  */
  {
    const smoke = source.match(/if \(SMOKE\) \{[\s\S]*?\n  \}\n\}/)?.[0] ?? "";
    check(
      "`--smoke` EXITS NON-ZERO ON AN ADDRESS THAT DISAGREES WITH `app.isPackaged`",
      /unexpectedConsoleAddress\(process\.env, app\.isPackaged, consoleAddress\)/.test(smoke) &&
        /endSmoke\(1, wrongAddress\)/.test(smoke),
    );
    check(
      "...and on an application menu with no clipboard or undo roles",
      ["undo", "cut", "copy", "paste", "selectall", "quit"].every((role) =>
        new RegExp(`"${role}"`).test(smoke),
      ) && /endSmoke\(1, `the application menu is missing/.test(smoke),
    );
    check(
      "...and it still exits non-zero when no window was created",
      /if \(windows < 1\) return endSmoke\(1,/.test(smoke),
    );
    check(
      "A HUNG LAUNCH ENDS ITSELF, SO A RELEASE JOB IS NEVER HELD OPEN",
      /const SMOKE_DEADLINE_MS = \d[\d_]*;/.test(source) &&
        /setTimeout\(\s*\(\) => endSmoke\(1, [^)]*\),\s*EFFECTIVE_SMOKE_DEADLINE_MS,?\s*\);/.test(source),
    );
    check(
      "...and `--smoke-load` gets its own wait layered on top, not instead of it",
      /const EFFECTIVE_SMOKE_DEADLINE_MS = SMOKE_LOAD \? SMOKE_DEADLINE_MS \+ SMOKE_LOAD_DEADLINE_MS : SMOKE_DEADLINE_MS;/.test(
        source,
      ),
    );

    /*
      PLAIN `--smoke` NEVER CLAIMED THE PAGE LOADED, AND NOW SAYS SO IN ITS OWN
      REPORT.

      Before this, `[smoke]` carried no field for it at all — not a lie, but not
      an answer either, and a person reading the line while diagnosing a mirror
      that served raw JavaScript had no way to tell "did the page even reach
      `did-finish-load`" from the report alone. `loaded` closes that: honest and
      unwaited on plain `--smoke`, and actually awaited (up to
      `SMOKE_LOAD_DEADLINE_MS`) only when `--smoke-load` asks for it.
    */
    check(
      "THE `[smoke]` REPORT SAYS WHETHER THE CONSOLE LOADED, NOT ONLY WHETHER A WINDOW EXISTS",
      /loaded,/.test(smoke) &&
        /let loaded = consoleWindow !== null && !consoleWindow\.webContents\.isLoading\(\);/.test(smoke),
    );
    check(
      "`--smoke-load` WAITS FOR THE CONSOLE'S FIRST NAVIGATION TO SETTLE, RATHER THAN GUESSING",
      /if \(SMOKE_LOAD && consoleLoadSettled !== null\) \{/.test(smoke) &&
        /Promise\.race\(\[\s*consoleLoadSettled,/.test(smoke),
    );
    check(
      "...and only then asks the mirror what it wrote — after `awaitSnapshot`, not before it",
      /if \(loaded\) await consoleMirror\?\.awaitSnapshot\(\);/.test(smoke),
    );
    check(
      "...and, on a failed load, waits for the fallback navigation too, before reading the window's own URL",
      /if \(!loaded\) await consoleMirror\?\.awaitFallback\(\);/.test(smoke),
    );
    check(
      "THE REPORT NAMES THE FACT THIS FIX IS ABOUT: WHETHER THE MIRROR'S OWN INDEX IS text/html",
      /const snapshotIsHtmlDocument =\s*\n\s*snapshotIndexType === null \? null : snapshotIndexType\.toLowerCase\(\)\.startsWith\("text\/html"\);/.test(
        smoke,
      ) && /snapshotIsHtmlDocument,/.test(smoke),
    );
    /*
      THE FALSE POSITIVE ITSELF: offline with a good mirror used to exit 1.

      A Mac session found this on hardware — `--smoke-load` exited 1 on
      `loaded:false` alone, before `mirrorServed` existed as a field, even
      though the mirror had just served a real document. "No network" and
      "broken app" must not share an exit code, and `mirrorServed` plus
      `wasMirrorServed` are what tells them apart.
    */
    check(
      "THE REPORT ALSO NAMES WHETHER THE WINDOW ENDED ON A USABLE MIRROR",
      /const mirrorServed = wasMirrorServed\(\s*consoleWindow\?\.webContents\.getURL\(\) \?\? "",\s*snapshotIsHtmlDocument,?\s*\);/.test(
        smoke,
      ) && /mirrorServed,/.test(smoke),
    );
    check(
      "THE EXIT RULE ASKS ONE PURE FUNCTION, NOT TWO INLINE CHECKS",
      /if \(SMOKE_LOAD\) \{\s*const failure = smokeLoadFailure\(\{\s*loaded,\s*mirrorServed,\s*snapshotIsHtmlDocument,\s*deadlineMs: SMOKE_LOAD_DEADLINE_MS,?\s*\}\);\s*if \(failure !== null\) return endSmoke\(1, failure\);\s*\}/.test(
        smoke,
      ),
    );
    /*
      AND IT IS HANDED THE FLAG THAT LETS IT SAY WHICH.

      The sentence used to offer four possibilities and claim "the report line
      above says which"; the report line says `mirrorServed:false`, which is
      the question. `snapshotIsHtmlDocument` is already computed three lines
      up and already printed — passing it is what makes the exit sentence name
      one case instead of a list, and in particular name the case that shipped
      twice: a usable mirror on disk the window never reached.
    */
    check(
      "...and it is told whether there was a usable mirror at all, so the sentence can say which",
      /smokeLoadFailure\(\{[^}]*snapshotIsHtmlDocument,/.test(smoke),
    );
    check(
      "...and that function is imported from the one place the rule is stated",
      /import \{ smokeLoadFailure, wasMirrorServed \} from "\.\.\/core\/shell\/mirror\.ts";/.test(source),
    );
  }

  /* --- a permission notice can never point at the menu bar ----------------- */

  /*
    THE DEFECT: the owner's first recording on real hardware granted the
    microphone mid-session, capture still could not open an input, and the
    session degraded to an empty typed note — while the panel told them to
    "open the menu bar to grant it". The menu bar cannot grant a TCC
    permission; only System Settings can, and a sentence that sends somebody
    to the wrong place is worse than no sentence, because it looks like an
    instruction that was followed.

    Checked against the CLOSED SET itself rather than against one call site:
    `CONSOLE_NOTICES` is exactly the object `explain()` is required to read
    from (see `trayOnly.test.mjs`, "EVERY SENTENCE THE TRAY EXPLAINS COMES
    FROM THE CLOSED SET"), so a permission-shaped key added here next year is
    covered by the same regex without anybody having to remember to extend a
    second list.
  */
  {
    const notices = source.match(/const CONSOLE_NOTICES = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";
    check("THE CLOSED SET OF CONSOLE NOTICES IS FOUND AT ALL", notices !== "");

    // Every key that talks about a permission macOS gates behind TCC —
    // matched by name so a future `screenPermissions` or `micPermissions` is
    // caught without this file being edited to know it exists.
    const permissionEntries = [
      ...notices.matchAll(/(\w*[Pp]ermission\w*):\s*\n?\s*"((?:[^"\\]|\\.)*)"/g),
    ];
    check(
      "THE SUITE ACTUALLY FOUND A PERMISSION NOTICE TO CHECK",
      permissionEntries.length > 0,
    );
    check(
      "NO PERMISSION NOTICE EVER SENDS SOMEBODY TO THE MENU BAR — it cannot grant a TCC permission",
      permissionEntries.every(([, , text]) => !/menu[\s-]?bar/i.test(text)),
    );
    check(
      "...it sends them to System Settings, which is the only place that can",
      permissionEntries.every(([, , text]) => /System Settings/.test(text)),
    );
    check(
      "...and it tells them to record again, which is the one instruction that actually recovers the session",
      permissionEntries.every(([, , text]) => /record again/i.test(text)),
    );
  }

  /* --- a grant that still cannot open gets its own sentence, not that one -- */

  /*
    THE FOLLOW-ON DEFECT, same hardware session: macOS recorded the grant at
    14:04, mid-run — but every recording after it, for the rest of that
    process's life, still failed to open an input, and the panel *still* said
    "not granted" at 14:57. AVFoundation's per-process authorization can lag a
    grant made in System Settings until the process relaunches, so a person
    who did exactly what `CONSOLE_NOTICES.microphonePermission` told them to do
    sees the
    same sentence again — which reads as "that didn't work" about an
    instruction that was never wrong, it was just already followed. The only
    thing that actually recovers this one is a relaunch, so it needs its own
    sentence and its own key: reusing a permission sentence here would send this
    person back to a System Settings toggle that is already on.
  */
  {
    const notices = source.match(/const CONSOLE_NOTICES = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";
    const stale = notices.match(/(\w+):\s*\n?\s*"((?:[^"\\]|\\.)*Quit and reopen(?:[^"\\]|\\.)*)"/);
    check("THE STALE-GRANT SENTENCE EXISTS IN THE CLOSED SET", stale !== null);
    check(
      "...names quitting and reopening, the one thing that actually recovers a stale process",
      stale !== null && /quit and reopen/i.test(stale[2]),
    );
    check(
      "...and does not reuse the 'macOS has not granted' sentence, which would be false here",
      stale !== null && !/has not granted/i.test(stale[2]),
    );
    const staleKey = stale?.[1];
    check(
      "THE CONSOLE ROUTES A STALE GRANT TO ITS OWN SENTENCE rather than the generic 'not granted' one",
      typeof staleKey === "string" &&
        (source.match(new RegExp(`CONSOLE_NOTICES\\.${staleKey}\\b`, "g")) ?? []).length >= 2,
    );
  }

  /* --- a permission notice names WHICH permission -------------------------- */

  /*
    There used to be one `permissions` sentence and it named the microphone —
    not because anything had been read, but because the microphone is the usual
    answer. `outcome.missing` has always known which permission macOS actually
    refused, and the only renderer that could print the other name was the
    panel (`renderer/panel.ts`, "Screen Recording"), which is `null` on a
    default launch. So the console blamed the microphone whatever happened.
  */
  {
    const notices = source.match(/const CONSOLE_NOTICES = Object\.freeze\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";
    check(
      "THE CLOSED SET HAS A SENTENCE PER PERMISSION, one of which names Screen Recording",
      /microphonePermission:\s*\n?\s*"(?:[^"\\]|\\.)*Microphone(?:[^"\\]|\\.)*"/.test(notices) &&
        /screenRecordingPermission:\s*\n?\s*"(?:[^"\\]|\\.)*Screen Recording(?:[^"\\]|\\.)*"/.test(notices),
    );
    const refusal = source.match(/} else if \(result\.why === "permissions"\) \{[\s\S]*?\n {4}\} else if/)?.[0] ?? "";
    check(
      "THE SENTENCE IS CHOSEN FROM `missing`, NOT DEFAULTED TO THE MICROPHONE",
      /missingPermissions\.includes\("screen"\)/.test(refusal) &&
        /explain\(CONSOLE_NOTICES\.screenRecordingPermission\);/.test(refusal) &&
        /explain\(CONSOLE_NOTICES\.microphonePermission\);/.test(refusal),
    );
    check(
      "...and the console's own refusal asks the same question rather than inventing a second",
      /permissionNotice\(result\.missing \?\? \[\]\)/.test(source) &&
        /function permissionNotice\(missing: readonly PermissionKind\[\]\): string \{/.test(source),
    );
  }

  /* --- a failure names its own subsystem, and is written down -------------- */

  /*
    NOTHING IN `apps/desktop/src` LOGGED A CAPTURE FAILURE AT ALL.

    The shell caught a `BeginResult` that was not ok, substituted a sentence
    from the closed set, and dropped the real text on the floor — so on a
    machine where the system tap had never once opened, the only trace anywhere
    was two `UnhandledPromiseRejectionWarning` lines from Electron's internals,
    naming Chromium's problem rather than this app's. The person still gets a
    closed-set sentence; the log is the half that was missing.
  */
  {
    check(
      "A CAPTURE FAILURE IS WRITTEN DOWN WITH ITS REAL TEXT",
      /function logCaptureFailure\(why: string, message: string \| null\): void \{\s*console\.error\(/.test(
        source,
      ) && (source.match(/logCaptureFailure\(/g) ?? []).length >= 5,
    );
    const engine = source.match(/} else if \(result\.why === "transcriber"\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    check(
      "AN ENGINE THAT FAILED IS EXPLAINED AS AN ENGINE, not as a permission",
      engine !== "" &&
        /logCaptureFailure\("transcriber", result\.message \?\? null\);/.test(engine) &&
        /explain\(CONSOLE_NOTICES\.captureFailed\);/.test(engine) &&
        /Permission\b/.test(engine) === false,
    );
  }

  /* --- an alert may never stop the main process ---------------------------- */

  /*
    THE MEASUREMENT: `sample` on the live main process while one of these was
    up put **1374 of 1374 samples** on `-[NSAlert runModal]` ->
    `-[NSApplication runModalForWindow:]`. A `dialog.showMessageBox(options)`
    with no `browserWindow` is application-modal on macOS, and for as long as it
    is open the main process is stopped: no outbox drain, no finalize, no IPC
    answered. `explain()` fires on exactly the capture-failed path, which is the
    worst moment available to stop draining a queue holding somebody's meeting.

    Passing the parent makes it a window sheet — document-modal, process still
    running behind it. Where there is no window, an alert is not available at
    all: `explain` degrades to a `Notification`, which never blocks.
  */
  {
    const explainBody = source.match(/function explain\(sentence: string\): void \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    check("THE `explain` BODY IS FOUND AT ALL", explainBody !== "");
    check(
      "A SENTENCE IS SHOWN AS A WINDOW SHEET, never as an application-modal alert",
      /void dialog\.showMessageBox\(parent, \{/.test(explainBody) &&
        /dialog\.showMessageBox\(\{/.test(explainBody) === false,
    );
    check(
      "...and with no window to attach one to it CANNOT BLOCK — it notifies instead",
      /new Notification\(\{ title: "Context", body: sentence \}\)\.show\(\)/.test(explainBody) &&
        /console\.error\(`\[shell\] \$\{sentence\}`\)/.test(explainBody),
    );

    const asker = source.match(/function askSomething\([\s\S]*?\n\}/)?.[0] ?? "";
    check(
      "A QUESTION IS ASKED THROUGH ONE PLACE, which passes the parent when there is one",
      /return parent === null \? dialog\.showMessageBox\(options\) : dialog\.showMessageBox\(parent, options\);/.test(
        asker,
      ),
    );
    check(
      "...and both remaining questions go through it",
      (source.match(/await askSomething\(liveConsoleWindow\(\), \{/g) ?? []).length === 2,
    );
    /*
      The whole-file sweep, because the defect is an *omitted argument* and a
      per-call-site check only catches the sites somebody remembered to list.
      Three calls remain in the file: `explain`'s sheet and `askSomething`'s two
      arms, so everything outside those two bodies must have none.
    */
    const elsewhere = source.replace(explainBody, "").replace(asker, "");
    check(
      "NO OTHER CALL SITE OPENS A MESSAGE BOX, so a fourth cannot omit its window quietly",
      explainBody !== "" && asker !== "" && /dialog\.showMessageBox/.test(elsewhere) === false,
    );
  }

  /* --- the setup order that made the app exit 1 on launch ------------------ */

  /*
    `imessage.reconfigure()` can reach its own `onChange`, `onChange` calls
    `push()`, and `push()` reads `controller`, `tray` and `updater`. Called
    beside the service's constructor — above all three — it threw
    `ReferenceError: Cannot access 'controller' before initialization`. It
    arrived through a promise, so there was no stack at the call site: the app
    simply exited 1 about a second after launch, printing nothing.

    `main` shipped that way from #329 until the call moved down beside the other
    service starts. Nothing caught it because the only thing that launches the
    app is `deploy-desktop.yml`'s gate, which does not run on a pull request —
    so the failure appeared at release time, against whichever commit happened
    to be at the head, which was not the one that caused it.

    Positional on purpose. A call textually above the declaration is the defect
    whether or not today's reading of the control flow says it is reachable.
  */
  check(
    "NOTHING RECONFIGURES THE IMESSAGE SERVICE ABOVE `controller` — that path reaches push(), and the app exits 1 on launch",
    source.includes("imessage.reconfigure()") &&
      source.includes("const controller = new MeetingController") &&
      source.indexOf("imessage.reconfigure()") >
        source.indexOf("const controller = new MeetingController"),
  );

  /*
    ...and the same defect one name over, because the check above is one line.

    The class is not `imessage.reconfigure()`. It is: a callback registered
    inside `main()` reaches `push()`, and something drives it before the things
    `push()` reads exist. `push()` dereferences `tray`, `controller`, `updater`,
    `panel` and `notepad`, and `const tray = new AppTray(` is the last of those
    to be declared — so nothing in `main()` above that line may drive a service
    whose callbacks call `push()`, and nothing may call `push()` or `update()`
    there either. `update()` counts twice over: it calls `push()` itself and it
    calls `imessage.reconfigure()` when the patch carries `imessageEnabled`,
    which is the original defect reached through a name the check above cannot
    see.

    Today the region holds five statements — two settings reads, a queue
    recovery, its write-back, and `connection.load()` — and none of them can
    reach `push()`. A sixth that can goes red here rather than at release time.

    Positional, like the check above, and for the same reason: whether a given
    early drive is fatal *today* depends on whether it reaches `push()` before
    the next `await` hands control back. Sabotaged one at a time, from the top
    of this suite:

      `imessage.reconfigure()` back where #329 had it   both checks red; app exits 1
      `push()` hoisted above `const tray`               this check only;  app exits 1
      `loop.start()` hoisted above `const tray`         this check only;  app still exits 0

    The third is the point of writing it positionally. It is latent rather than
    fatal — detection is off by default and the first collect is asynchronous,
    so `onUpdate` lands after `main()` has run on past `const tray` — and a
    guard that only reddened on the fatal ones would be a guard that waits for
    somebody to turn detection on.

    What it does not cover, said out loud rather than left to be assumed: it
    reads statements at `main()`'s own indentation, so a drive nested inside
    another expression, one reached through a freshly named helper, or one made
    on a handle copied to a second variable all get past it. It is a wider net
    than a single line, not a proof.
  */
  const mainStart = source.indexOf("async function main(): Promise<void> {");
  const lastPushDependency = source.indexOf("const tray = new AppTray(");
  const beforePushCanRun =
    mainStart === -1 || lastPushDependency === -1 || lastPushDependency < mainStart
      ? null
      : source.slice(mainStart, lastPushDependency);
  const drivenTooEarly =
    beforePushCanRun === null
      ? []
      : [
          ...(beforePushCanRun.match(
            /^ {2}(?:void |await )?(?:imessage|controller|updater|loop|tray)\.[A-Za-z]/gm,
          ) ?? []),
          ...(beforePushCanRun.match(/^ {2}(?:void |await )?(?:push|update)\(/gm) ?? []),
        ];
  check(
    "NOTHING DRIVES A PUSH-REACHING SERVICE ABOVE `tray` — the same launch crash, one name over",
    beforePushCanRun !== null && drivenTooEarly.length === 0,
  );
}
