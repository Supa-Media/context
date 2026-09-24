/**
 * The deploy workflow itself: the keychain it signs from, the manual-publish
 * gating, the app it just built actually being launched before anything
 * publishes, and the notarize hook's behaviour when Apple refuses. Split out
 * of `packaging.test.mjs`; see that file's header for the full rationale and
 * the sabotage record, and `fixtures.mjs` for the shared `ROOT`/`require`/
 * `P8`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, require, BUILDER, P8 } from "./fixtures.mjs";

export async function runDeployWorkflowChecks(check) {
  // -- the workflow that builds it, and the keychain it signs from -----------
  /*
    Why a check in the desktop suite reads a file in `.github/`: because the
    dmg this suite is about was, twice, not built at all. Both dispatches of
    `deploy-desktop.yml` on the signed path died in forty seconds inside
    electron-builder's own keychain setup:

      security set-key-partition-list -S apple-tool:,apple: -s -k *** <temp>.keychain
      security: SecKeychainUnlock: The user name or passphrase you entered is not correct.

    `createKeychain()` makes a throwaway keychain with a random password and
    then hands `set-key-partition-list -k` the **certificate's** import
    password instead of that keychain's — two different secrets, and only the
    keychain's own unlocks it (electron-userland/electron-builder#10066, whose
    fix is not in any released 26.x). The `security import` immediately before
    it succeeded, which is what proves `CSC_KEY_PASSWORD` is right and the
    keychain password is what was wrong.

    So the workflow owns the keychain now, and electron-builder is handed
    `CSC_KEYCHAIN` and never `CSC_LINK` — because `CSC_LINK` is the switch that
    selects the broken path (`macPackager.ts`: with a csc link it calls
    `createKeychain`, without one it uses `process.env.CSC_KEYCHAIN`). That is a
    property of a YAML file with no test of its own and a forty-minute feedback
    loop through a Mac runner, which is exactly the kind of thing this file is
    for.

    Read with comment lines removed, for the reason the entitlements checks
    above give: that workflow's header explains at length why it does what it
    does, and a check that reads prose is a check that passes on a sentence
    about itself.
  */
  const WORKFLOW = readFileSync(join(ROOT, "..", "..", ".github/workflows/deploy-desktop.yml"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  /* Steps start at one indent inside `steps:`; that is enough of a parser. */
  const steps = WORKFLOW.split(/\n(?=      - )/);
  const buildStep = steps.find((step) => /electron-builder --mac/.test(step));
  const preflight = steps.find((step) => /openssl pkcs12/.test(step));
  const cleanup = steps.find((step) => /delete-keychain/.test(step));

  check("the workflow still builds with electron-builder", buildStep !== undefined);
  check(
    "CSC_LINK NEVER REACHES ELECTRON-BUILDER — it is the switch that selects the broken temp-keychain path",
    buildStep !== undefined && !/CSC_LINK/.test(buildStep),
  );
  check(
    "...and neither does CSC_KEY_PASSWORD, which is what that path mis-uses",
    buildStep !== undefined && !/CSC_KEY_PASSWORD/.test(buildStep),
  );
  check("the identity comes from a keychain this workflow made", /CSC_KEYCHAIN=/.test(WORKFLOW));
  check(
    "the certificate is checked before anything is built, not after forty seconds of packaging",
    preflight !== undefined && steps.indexOf(preflight) < steps.indexOf(buildStep),
  );
  check(
    "...including that it carries a private key, so a .cer exported by mistake is named as one",
    preflight !== undefined && /-nocerts/.test(preflight),
  );
  check(
    "SET-KEY-PARTITION-LIST IS GIVEN THE KEYCHAIN'S OWN PASSWORD — the bug, in one line",
    preflight !== undefined && /set-key-partition-list[^\n]*-k "\$keychain_password"/.test(preflight),
  );
  check(
    "...which is the password the keychain was created with",
    preflight !== undefined && /create-keychain -p "\$keychain_password"/.test(preflight),
  );
  check(
    "the keychain is deleted whether the build passed or failed",
    cleanup !== undefined && /if: always\(\)/.test(cleanup),
  );
  const keyCheck = steps.find((step) => /notarize\.cjs --check/.test(step));
  check(
    "the notarisation key is judged before the build too, not after twenty-six seconds of signing",
    keyCheck !== undefined && steps.indexOf(keyCheck) < steps.indexOf(buildStep),
  );

  /*
    The icon, asked of the built app rather than of the config.

    The checks up in the icon section read `electron-builder.yml` and
    `build/icon.icns` — both of them build *inputs*. That is the same reasoning
    that `NSCameraUsageDescription` has already shown to be unsound here: that
    key is in the shipped Info.plist and appears nowhere in the config, because
    Electron ships a default plist and `extendInfo` is merged into it. A config
    the repo controls does not describe the plist that came out.

    `icon:` has the same shape. The fallback that shipped the atom happens
    inside electron-builder, downstream of every line this repo writes, and
    `CFBundleIconFile` exists only after packaging. So the input checks stay —
    they fail in seconds and say exactly what is wrong — and this row makes sure
    the one place the real artifact exists actually looks at it.
  */
  const iconStep = steps.find((step) => /Check the icon the build actually bundled/.test(step));
  check(
    "THE PACKAGED APP'S OWN ICON IS CHECKED — the config cannot prove what electron-builder bundled",
    iconStep !== undefined,
  );
  check(
    "...by reading CFBundleIconFile out of the built Info.plist, which is where the atom was found",
    iconStep !== undefined && /CFBundleIconFile/.test(iconStep) && /Contents\/Info\.plist/.test(iconStep),
  );
  check(
    "...and comparing bytes against build/icon.icns, so a copy of electron.icns under our name still fails",
    iconStep !== undefined && /cmp -s "\$bundled" build\/icon\.icns/.test(iconStep),
  );
  check(
    "...for both architectures, not just the arm64 one the smoke step gates on",
    iconStep !== undefined &&
      /release\/mac-arm64\/Context\.app/.test(iconStep) &&
      /release\/mac\/Context\.app/.test(iconStep),
  );
  check(
    "...after the build that produces the app, since there is nothing to read before it",
    iconStep !== undefined && steps.indexOf(iconStep) > steps.indexOf(buildStep),
  );
  check(
    "...and it fails the job rather than warning, because a wrong icon is what shipped last time",
    iconStep !== undefined && /exit 1/.test(iconStep),
  );

  // -- publishing: explicit manual input, gated permissions, and idempotency --
  // Main deploys staging only. Desktop publishing still requires a separate
  // manual request, signing, notarisation and the launch check below.
  check(
    "desktop builds only run on explicit manual dispatch",
    /^on:\s*\n\s*workflow_dispatch:/m.test(WORKFLOW) && !/^  push:/m.test(WORKFLOW),
  );
  check(
    "a `publish` dispatch input exists and defaults to false",
    /publish:\s*\n\s*description:[^\n]*\n\s*required:\s*false\s*\n\s*type:\s*boolean\s*\n\s*default:\s*false/.test(
      WORKFLOW,
    ),
  );
  check(
    "the build job elevates to contents: write, not the whole workflow",
    /^permissions:\s*\n\s*contents:\s*read/m.test(WORKFLOW) && /permissions:\s*\n\s*contents:\s*write/.test(WORKFLOW),
  );
  check(
    "checkout does not persist the write token into repo scripts before the gated Publish step",
    /actions\/checkout@v5/.test(WORKFLOW) && /persist-credentials:\s*false/.test(WORKFLOW),
  );
  check(
    "publishing requires the explicit dispatch input and both signing credentials",
    /PUBLISH_REQUESTED/.test(WORKFLOW) &&
      !/github\.event_name == 'push'/.test(WORKFLOW) &&
      /inputs\.publish == true/.test(WORKFLOW) &&
      /SIGNED/.test(WORKFLOW) &&
      /NOTARIZED/.test(WORKFLOW) &&
      /\$PUBLISH_REQUESTED"\s*=\s*"true"\s*\]\s*&&\s*\[\s*"\$SIGNED"\s*=\s*"true"\s*\]\s*&&\s*\[\s*"\$NOTARIZED"\s*=\s*"true"/.test(
        WORKFLOW,
      ),
  );
  check(
    "a manual publish request without signing or notarisation only produces an artifact",
    /echo "publish=false"/.test(WORKFLOW) &&
      /::warning::publish was requested/.test(WORKFLOW),
  );
  check(
    "an already-released version refuses to publish again, before the build rather than after",
    /gh release view "\$TAG"/.test(WORKFLOW) &&
      steps.indexOf(steps.find((step) => /gh release view/.test(step))) < steps.indexOf(buildStep),
  );
  check(
    "artifact-only manual builds keep the committed package version, while every published release stamps a run-number patch in the ephemeral checkout",
    /const base = String\(pkg\.version\)/.test(WORKFLOW) &&
      /PUBLISH_REQUESTED === "true"/.test(WORKFLOW) &&
      /GITHUB_RUN_NUMBER/.test(WORKFLOW) &&
      /version = `\$\{major\}\.\$\{minor\}\.\$\{run\}`/.test(WORKFLOW) &&
      /writeFileSync\("package\.json"/.test(WORKFLOW) &&
      !/npm version/.test(WORKFLOW),
  );
  /*
    This used to be "the build step decides --publish from the same decision"
    — electron-builder's own GitHub provider published straight out of the
    Build step, before anything had run the app it was publishing. A crashing
    build reaching a release is not theoretical: `electron-updater` polls the
    latest published release and would auto-install it onto every Mac already
    running this app. So Build always builds, never publishes, and a separate
    step below is the only place `--publish` (in spirit — it is `gh release
    create` now, not electron-builder's flag) can ever run, gated on the
    launch step actually having passed. See "A release is a build that
    started" in docs/decisions/desktop.md.
  */
  check(
    "THE BUILD STEP ALWAYS PASSES --publish never — publishing is not a flag on this command any more",
    buildStep !== undefined && /--publish never/.test(buildStep) && !/--publish always/.test(buildStep) && !/publish_policy/.test(buildStep),
  );
  check(
    "...and it no longer carries GH_TOKEN or a PUBLISH decision at all — it cannot reach a release, full stop",
    buildStep !== undefined && !/GH_TOKEN/.test(buildStep) && !/PUBLISH/.test(buildStep),
  );
  /*
    electron-builder's own `MacPackager.doSign()` logs `identityName=Developer
    ID Application: <company> (<team id>) identityHash=<sha1>` at "info" level
    on every signed build, unconditionally — proven on a runner, where a
    successful sign printed exactly that line to this public repository's
    Actions log, twice, the redaction below unable to touch it. It is not one
    of this workflow's own `echo`s, so the certificate-subject checks above
    (which read the *preflight*'s shell) do not see it; this reads the Build
    step itself.

    The expression that redacts it is not typed into this test or the
    workflow a second time — both run the exact same file,
    `build/redact-signing-log.sh`, which is the point: an inline `sed` in the
    workflow and a copy of its pattern in this test can drift apart (that is
    exactly how the bug below shipped unnoticed), and a single script cannot.
  */
  check(
    "the Build step pipes electron-builder's output through the shared redaction script, not an inline pattern of its own",
    buildStep !== undefined && /redact-signing-log\.sh/.test(buildStep) && !/sed -E/.test(buildStep),
  );
  check(
    "...and a failure inside that redacted pipe still fails the step",
    buildStep !== undefined && /pipefail/.test(buildStep),
  );

  /*
    The script itself, run exactly as the workflow runs it — piped stdin,
    read stdout — against the line shape captured verbatim from a real signed
    run (company and team id replaced with fakes; the shape is what matters).

    This is also the regression test for the bug that shipped: the script's
    predecessor used `[^\n]*`, which GNU sed (this very check, on whatever
    Linux runs this suite) extends to mean "the rest of the line" but BSD sed
    — `/usr/bin/sed` on the `macos-latest` runner the workflow actually signs
    on — resolves to "not the literal letter n", matching nothing before
    `identityHash=` and leaving the line untouched. Node's `execFileSync`
    below shells out to whatever `sed` the *test* runner has, which proves
    the *expression* is correct rather than proving any particular sed
    accepts it — the real defect was one platform's sed disagreeing with
    another's about what `\n` means inside `[...]`, not a bug this process
    can reproduce without a second sed to compare against. What this can and
    does prove: the fixed expression uses no such extension, matches on this
    sed, and is the one and only place either the workflow or this test reads
    that pattern from.
  */
  const REDACT_SCRIPT_PATH = join(ROOT, "build/redact-signing-log.sh");
  const REDACT_SCRIPT_TEXT = readFileSync(REDACT_SCRIPT_PATH, "utf8");
  /*
    The behavioural checks below run this script through *this* process's own
    `sed`, which on every machine this suite has ever run on is GNU sed — the
    one that extends `\n` inside a bracket expression to mean an actual
    newline. That is exactly why the original bug was invisible here: a test
    written the same way this one is, run on Linux, watches `[^\n]*` behave
    like `.*` and passes. The platform that disagrees is BSD sed on
    `macos-latest`, and this suite has no way to invoke it. So the guarantee
    this test can actually give is narrower and, for that reason, checked
    directly: the expression itself never spells `\n` inside `[...]` again,
    GNU extension or not, because a future edit reaching for "any character
    but a newline" the same way will pass on every developer's machine and
    fail the exact way this one did — silently, on a Mac, in a public log.
  */
  const REDACT_SCRIPT_CODE = REDACT_SCRIPT_TEXT.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  check(
    "the script never reintroduces `[^\\n]` — the GNU-only escape that made the redaction match nothing on the runner's BSD sed",
    // Read with comment lines stripped: the header above explains the exact
    // bug this guards, in prose that necessarily quotes `[^\n]*` itself — a
    // check that read the whole file would fail on the sentence describing
    // the mistake rather than on the mistake.
    !/\[[^\]]*\\n[^\]]*\]/.test(REDACT_SCRIPT_CODE),
  );
  const redact = (input) => execFileSync("bash", [REDACT_SCRIPT_PATH], { input, encoding: "utf8" });
  const FAKE_COMPANY = "Fake Company LLC (Widgets)";
  const FAKE_TEAM_ID = "ABCDE12345";
  const FAKE_HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
  const signingLine = (appOutDir) =>
    `  • signing         file=release/${appOutDir}/Context.app platform=darwin type=distribution ` +
    `identityName=Developer ID Application: ${FAKE_COMPANY} (${FAKE_TEAM_ID}) identityHash=${FAKE_HASH} provisioningProfile=none`;
  const arm64Line = signingLine("mac-arm64");
  const x64Line = signingLine("mac");
  const otherLine = "  • building        target=macOS zip arch=arm64 file=release/Context-0.1.0-arm64-mac.zip";
  const redacted = redact([arm64Line, x64Line, otherLine].join("\n") + "\n");
  check(
    "the shared script redacts the arm64 build's signing line — the exact shape captured from a real run",
    redacted.includes("identityName=[redacted] identityHash=[redacted]"),
  );
  check(
    "...and the x64 build's, which electron-builder prints a second time in the same run",
    redacted.split("identityName=[redacted] identityHash=[redacted]").length - 1 === 2,
  );
  check(
    "...WITHOUT LEAVING THE COMPANY NAME BEHIND",
    !redacted.includes(FAKE_COMPANY),
  );
  check(
    "...OR THE TEAM ID",
    !redacted.includes(FAKE_TEAM_ID),
  );
  check(
    "...or the signing identity's hash",
    !redacted.includes(FAKE_HASH),
  );
  check(
    "a line with no identity in it passes through untouched",
    redacted.includes(otherLine),
  );
  check(
    "everything else on the redacted line survives — this is a redaction, not a line filter",
    redacted.includes("file=release/mac-arm64/Context.app") && redacted.includes("provisioningProfile=none"),
  );

  check(
    "the dmg itself is signed too, not just the app inside it — electron-builder's own default leaves the container unsigned",
    /dmg:\s*\n(?:[^\n]*\n)*?\s*sign:\s*true/.test(BUILDER),
  );

  /*
    The check `spctl --assess` used to run directly against the `.dmg`, which
    Gatekeeper never assesses and electron-builder does not sign by default —
    it printed "no usable signature" on every dispatch, signed or not, and
    was treated as expected rather than as the tautology it was. This reads
    the step that replaced it: mount the dmg the way a person's Finder does,
    assess the `.app` inside, and never let any of the three tools' own
    output — which names the signing identity on success, same as the log
    line just redacted above — reach a public log a second time.
  */
  const verifyStep = steps.find((step) => /hdiutil attach/.test(step));
  check("a step verifies the app inside each dmg, not the dmg's own (nonexistent) signature", verifyStep !== undefined);
  check(
    "...by mounting it read-only, invisibly to Finder",
    verifyStep !== undefined && /hdiutil attach -nobrowse -readonly/.test(verifyStep),
  );
  check(
    "...running spctl against the app Gatekeeper actually assesses",
    verifyStep !== undefined && /spctl --assess --type execute/.test(verifyStep),
  );
  check(
    "...verifying the signature covers every nested binary",
    verifyStep !== undefined && /codesign --verify --deep --strict/.test(verifyStep),
  );
  check(
    "...and validating the notarisation ticket travelled with it",
    verifyStep !== undefined && /stapler validate/.test(verifyStep),
  );
  check(
    "...detaching the volume whether or not the checks it ran passed",
    verifyStep !== undefined && /hdiutil detach/.test(verifyStep),
  );
  check(
    "NONE OF THE THREE TOOLS' OWN OUTPUT REACHES THE LOG — each is redirected, not echoed",
    verifyStep !== undefined &&
      /spctl --assess --type execute -vv "\$app" >\/dev\/null 2>&1/.test(verifyStep) &&
      /codesign --verify --deep --strict "\$app" >\/dev\/null 2>&1/.test(verifyStep) &&
      /stapler validate "\$app" >\/dev\/null 2>&1/.test(verifyStep),
  );
  check(
    "a signed AND notarised build fails the workflow if Gatekeeper refuses it — the case this was actually seen failing",
    verifyStep !== undefined && /strict=true/.test(verifyStep) && /exit 1/.test(verifyStep),
  );
  check(
    "...but an unsigned or un-notarised build only reports, the same honesty this workflow gives that path everywhere else",
    verifyStep !== undefined && /::warning::/.test(verifyStep) && /strict/.test(verifyStep),
  );
  check(
    "the dmg-only spctl check this replaced is gone, not left behind as a second, always-failing assessment",
    !/--context context:primary-signature/.test(WORKFLOW),
  );

  check(
    "a pull request still does not publish a desktop release — only main pushes and manual dispatches can reach this workflow",
    !/^\s*pull_request:/m.test(WORKFLOW),
  );

  // -- the app it just built is started, not just signed --------------------
  /*
    A Mac session found that the signed, notarised artifact this workflow had
    been producing crashed on launch (`Dynamic require of "events"`, from
    electron-updater's inlined CommonJS) and that nothing in this repository
    had ever started the app it publishes: 922 checks passing on a build that
    could not open a window. `--smoke` (a separate pull request, owned there —
    initialise, open the console window, log one line, exit 0 within 10s;
    non-zero on any uncaught error or if no window was created) is the app's
    half; this is the workflow's: a step that actually runs the binary
    electron-builder just produced and fails the job if it did not survive.
  */
  const uploadStep = steps.find((step) => /upload-artifact@v4/.test(step));
  const launchStep = steps.find((step) => /--smoke/.test(step));

  check("a step launches the app that was just built, with --smoke", launchStep !== undefined);
  check(
    "...running the arm64 build electron-builder actually produced, not a guessed path",
    launchStep !== undefined && /release\/mac-arm64\/Context\.app\/Contents\/MacOS\/Context/.test(launchStep),
  );
  check(
    "IT PRECEDES THE ARTIFACT UPLOAD — nothing that fails this gate is ever kept",
    launchStep !== undefined &&
      uploadStep !== undefined &&
      steps.indexOf(launchStep) < steps.indexOf(uploadStep),
  );
  /*
    The one thing this cannot do, stated rather than hidden: `--publish always`
    runs INSIDE `electron-builder --mac` in the Build step, so a `publish: true`
    dispatch has already uploaded to a GitHub Release by the time any step
    after Build runs — the same shape as the Gatekeeper check directly above
    this one, which also verifies a dmg whose contents are, by construction,
    already written to disk. What is asserted here is what is actually true:
    the launch step runs after Build (so it exercises the exact bits Build
    produced) and before the artifact upload, on every dispatch — so it still
    fails the job, in red, on a build that cannot start, whether or not
    electron-builder had already shipped it to a release the moment before.
  */
  check(
    "...and it runs after Build, so it is testing the exact bits that were produced, not a stale copy",
    launchStep !== undefined && buildStep !== undefined && steps.indexOf(buildStep) < steps.indexOf(launchStep),
  );
  check(
    "IT GREPS THE LOG FOR ALL THREE CRASH STRINGS FROM THE MAC SESSION'S REPORT",
    launchStep !== undefined &&
      /Uncaught Exception/.test(launchStep) &&
      /A JavaScript error occurred/.test(launchStep) &&
      /Dynamic require/.test(launchStep),
  );
  check(
    "...even when the process exits 0 — a caught crash logged and swallowed is still a crash",
    launchStep !== undefined && /grep -qE "\$CRASH_STRINGS"/.test(launchStep) && /log_file/.test(launchStep),
  );
  check(
    "A NON-ZERO EXIT FAILS THE STEP",
    launchStep !== undefined && /-ne 0/.test(launchStep),
  );
  /*
    ── THE DEADLINE IS A DEADLINE, NOT A REQUEST ────────────────────────────

    macOS has no `timeout(1)`, so this step builds its own. The first version
    was `perl -e 'alarm 30; exec @ARGV'` — elegant, and resting on three things
    nobody could check from a Linux container: that a pending `alarm(2)`
    survives `execve(2)` on Darwin, that nothing in Electron, Chromium, libuv
    or Node catches or blocks `SIGALRM`, and that a handler-bearing process
    parked in a modal `NSAlert` run loop would still die of it. `SIGALRM` is a
    catchable signal; the state this gate exists to catch is precisely a
    process that has stopped responding to ordinary events.

    So the deadline is a background launch, a watchdog and **`SIGKILL`**, which
    cannot be caught, blocked or ignored by anything. What is asserted is the
    property and not the spelling: the app is started in the background, and
    something sends it signal 9 at a deadline.
  */
  check(
    "...AND SO DOES STILL RUNNING PAST THE DEADLINE",
    launchStep !== undefined && /still alive/.test(launchStep) && /return 1/.test(launchStep),
  );
  check(
    "THE DEADLINE IS `kill -9`, WHICH A CRASH DIALOG CANNOT CATCH, BLOCK OR IGNORE",
    launchStep !== undefined &&
      /kill -9 "\$app_pid"/.test(launchStep) &&
      /SMOKE_DEADLINE_S=\d+/.test(launchStep) &&
      /wait "\$app_pid"/.test(launchStep),
  );
  check(
    "...and it is not a catchable signal exec'd into the app, which is what this replaced",
    launchStep !== undefined && !/alarm \d/.test(launchStep) && !/SIGALRM/.test(launchStep),
  );
  check(
    "...and the deadline is longer than the app's own, so it is a backstop rather than a race",
    launchStep !== undefined && Number(/SMOKE_DEADLINE_S=(\d+)/.exec(launchStep)?.[1] ?? 0) >= 60,
  );
  /*
    `ELECTRON_RUN_AS_NODE` makes the Electron binary run as plain Node: the
    module loader is swapped, the bundle gets a real CommonJS `require`, and no
    `app` object is ever created — so the build that shipped, the one that threw
    `Dynamic require of "events"`, loads under it without a word. It is the one
    variable that turns this whole gate into a check that proves nothing, and it
    is deleted rather than merely not set, because a runner, an action or a
    future `env:` block on this job could all supply it.
  */
  check(
    "THE LAUNCH DELETES `ELECTRON_RUN_AS_NODE`, WHICH WOULD MAKE THIS GATE PROVE NOTHING",
    launchStep !== undefined && /env -u ELECTRON_RUN_AS_NODE "\$app_path" --smoke/.test(launchStep),
  );
  check(
    "...and it does not set `NODE_ENV`, which no packaged launch has and which nothing may prove a build works under",
    launchStep !== undefined && !/NODE_ENV=/.test(launchStep),
  );
  check(
    "IT RUNS ON BOTH THE SIGNED AND THE UNSIGNED PATH — nothing here is gated on steps.certificate or steps.notarize_check",
    launchStep !== undefined && !/steps\.certificate/.test(launchStep) && !/steps\.notarize_check/.test(launchStep),
  );
  check(
    "the x64 build is attempted only where the runner can actually run it — an arm64 runner without Rosetta is a skip, not a false pass",
    launchStep !== undefined && /arch -x86_64/.test(launchStep) && /release\/mac\/Context\.app\/Contents\/MacOS\/Context/.test(launchStep),
  );
  check(
    "...and the skip is a warning that names the gap, not a silent no-op",
    launchStep !== undefined && /::warning::/.test(launchStep) && /Rosetta/.test(launchStep),
  );
  check(
    "the captured log is shown only as its last 40 lines, through the same shared redaction script the Build step uses",
    launchStep !== undefined && /tail -n 40/.test(launchStep) && /redact-signing-log\.sh/.test(launchStep),
  );

  /*
    ── ARM64 STAYS THE GATE; X64 GETS ITS OWN, GENEROUS, NON-FATAL DEADLINE ──

    The first gated release (run 34135737601) measured a GOOD x64 launch —
    Context started, ran --smoke, and exited 0 — using 57 of the shared 60s
    deadline, entirely because it runs under Rosetta emulation on this same
    arm64 runner rather than natively. A slow runner failing a release for
    being slow prints the identical "was still alive ... killed with SIGKILL"
    line a real launch crash does, which is the worst kind of false positive:
    it teaches people to re-run the gate instead of trust it.

    So `launch()` takes the deadline and whether a timeout is fatal as
    arguments, and the two legs are called with different values for both —
    while the crash-string grep and the non-zero-exit check inside `launch()`
    are never conditioned on either argument, so those two failure modes are
    identical for both legs. What is checked below is exactly that shape:
    arm64 keeps its 60s, fatal; x64 gets 240s, non-fatal on a timeout alone.
  */
  check(
    "THE ARM64 LEG IS CALLED WITH A FATAL TIMEOUT — its own 60s deadline still fails the job",
    launchStep !== undefined &&
      /launch "release\/mac-arm64\/Context\.app\/Contents\/MacOS\/Context" "\$arm64_log" "\$SMOKE_DEADLINE_S" true/.test(
        launchStep,
      ),
  );
  check(
    "...and only return code 1 from that call sets $status — a hard fail, not a soft one",
    launchStep !== undefined && /arm64_rc" -eq 1/.test(launchStep),
  );
  check(
    "THE X64 LEG GETS ITS OWN, MUCH LARGER ALLOWANCE — 240s, not the arm64 gate's 60s",
    Number(/X64_SMOKE_DEADLINE_S=(\d+)/.exec(launchStep)?.[1] ?? 0) >= 240,
  );
  check(
    "THE X64 LEG IS CALLED WITH A NON-FATAL TIMEOUT — a Rosetta timeout warns, it does not fail the job",
    launchStep !== undefined &&
      /launch "release\/mac\/Context\.app\/Contents\/MacOS\/Context" "\$x64_log" "\$X64_SMOKE_DEADLINE_S" false/.test(
        launchStep,
      ),
  );
  check(
    "...and only return code 1 from THAT call sets $status too — return 2 (the warn-only timeout) never does",
    launchStep !== undefined && /x64_rc" -eq 1/.test(launchStep) && !/x64_rc" -eq 2/.test(launchStep),
  );
  check(
    "a timed-out x64 leg is reported with ::warning::, inside the same branch that returns the non-fatal code",
    launchStep !== undefined &&
      /timeout_is_fatal" = "true" \]; then\s*\n\s*echo "FAIL:[^\n]*\n\s*return 1\s*\n\s*fi\s*\n\s*echo "::warning::/.test(
        launchStep,
      ),
  );
  check(
    "THE CRASH-STRING CHECK IS UNCONDITIONAL — never gated on timeout_is_fatal, so it still fails the x64 leg too",
    launchStep !== undefined &&
      /grep -qE "\$CRASH_STRINGS" "\$log_file"/.test(launchStep) &&
      // The crash-string grep must not sit inside a block that reads
      // $timeout_is_fatal — that would be exactly how a maintainer could
      // scope the check to one leg and not the other.
      !/timeout_is_fatal[\s\S]{0,200}CRASH_STRINGS/.test(launchStep),
  );
  check(
    "...and the non-zero-exit check is unconditional too, for the same reason",
    launchStep !== undefined &&
      /if \[ "\$status" -ne 0 \]; then/.test(launchStep) &&
      !/timeout_is_fatal[\s\S]{0,120}"\$status" -ne 0/.test(launchStep),
  );
  check(
    "EACH LEG PRINTS ITS OWN ELAPSED TIME AGAINST THE DEADLINE IT ACTUALLY GOT — the margin (e.g. x64's 57s of 60s) stays visible",
    launchStep !== undefined && /after \$\{elapsed\}s \(of \$\{deadline\}s allowed\)/.test(launchStep),
  );

  // -- publishing happens only after the app has been shown to start --------
  /*
    Read `node_modules/electron-updater`'s own `GitHubProvider.js`, to answer
    a question this repository cannot otherwise check without a Mac and a real
    release: `getLatestVersion()` fetches `<tag>/latest-mac.yml` (macOS's
    channel file — `getChannelFilePrefix()` returns `-mac` there), and
    `resolveFiles()` resolves each entry inside it against the same release.
    So the updater needs exactly that file and the zip(s) it names; the dmg is
    never one of them — confirmed by reading the provider rather than assumed,
    because getting this wrong either way is a build that ships without an
    update path or a release that leaves out the file a person needs to
    actually install it.
  */
  const publishStep = steps.find((step) => /gh release create/.test(step));

  check("a step publishes the release, separately from Build", publishStep !== undefined);
  check(
    "IT COMES AFTER THE LAUNCH STEP, NOT BEFORE — publishing follows proof the app starts",
    publishStep !== undefined && launchStep !== undefined && steps.indexOf(launchStep) < steps.indexOf(publishStep),
  );
  check(
    "IT IS GATED ON THE LAUNCH STEP'S OWN OUTCOME, not just on the earlier publish/signed/notarised decision",
    publishStep !== undefined && /steps\.smoke\.outcome\s*==\s*'success'/.test(publishStep),
  );
  check(
    "...and it is still gated on that earlier decision too — a smoke pass alone does not imply publish was requested, signed, or notarised",
    publishStep !== undefined && /steps\.decide\.outputs\.publish\s*==\s*'true'/.test(publishStep),
  );
  check(
    "it uploads exactly what electron-updater's GitHub provider reads — latest-mac.yml and the zip(s) — plus the dmg for a first install",
    publishStep !== undefined &&
      /release\/\*\.dmg/.test(publishStep) &&
      /release\/\*\.zip/.test(publishStep) &&
      /release\/latest-mac\.yml/.test(publishStep),
  );
  check(
    "it uses the workflow's own built-in token — no new secret was added for this",
    publishStep !== undefined && /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(publishStep),
  );
  check(
    "it publishes the same tag the early refusal already checked, not a second copy of that logic",
    publishStep !== undefined && /TAG: v\$\{\{ steps\.version\.outputs\.value \}\}/.test(publishStep) && /"\$TAG"/.test(publishStep),
  );
  check(
    "no second electron-builder invocation runs here — it would re-sign and re-notarise different bytes than the ones just launched",
    publishStep !== undefined && !/electron-builder/.test(publishStep),
  );

  // -- the hook when Apple says no -------------------------------------------
  /*
    The other half of "all three, or nothing". A hook that swallowed a failed
    notarisation would produce a dmg that Gatekeeper refuses and macOS gives no
    microphone to, with a green build behind it — which is the same silent
    outcome every other check in this file exists to stop, arriving by a
    different door.

    And with it, the one credential this repository writes to a disk it does not
    own. `ASC_API_KEY_P8` is a private key; the hook writes it 0600 into a
    private temp directory so `notarytool` can read it, and removes it in a
    `finally`. A failed submission is exactly when a `finally` gets dropped, so
    the failing path is where it is checked.
  */
  const notarizeModule = require.resolve("@electron/notarize");
  const realNotarize = require.cache[notarizeModule];
  let submitted = null;
  require.cache[notarizeModule] = {
    id: notarizeModule,
    filename: notarizeModule,
    loaded: true,
    exports: {
      notarize: async (options) => {
        submitted = options;
        throw new Error("HTTP status code: 401. Invalid credentials.");
      },
    },
  };
  // Required after the fake is in place, and out of the cache first: the
  // `credentials` export above was reached through the real module.
  delete require.cache[require.resolve(join(ROOT, "build/notarize.cjs"))];
  const hook = require(join(ROOT, "build/notarize.cjs")).default;

  const context = {
    electronPlatformName: "darwin",
    appOutDir: ROOT,
    packager: { appInfo: { productFilename: "Context" } },
  };
  const saved = { ...process.env };
  process.env.ASC_API_KEY_P8 = P8;
  process.env.ASC_KEY_ID = "fake-key-id";
  process.env.ASC_ISSUER_ID = "fake-issuer-id";
  let thrown = null;
  try {
    await hook(context);
  } catch (error) {
    thrown = error;
  }
  check(
    "A NOTARISATION APPLE REFUSED FAILS THE BUILD — it is never a quiet unsigned dmg",
    thrown instanceof Error && /401/.test(thrown.message),
  );
  check("...and it did submit, so the failure is Apple's answer and not a typo here", submitted !== null);
  check("...it was submitted with notarytool and the key on disk", submitted?.tool === "notarytool" && typeof submitted?.appleApiKey === "string");
  check(
    "THE PRIVATE KEY IS GONE AFTER A FAILED SUBMISSION, not left on the runner",
    submitted !== null && !existsSync(submitted.appleApiKey),
  );
  check("...and the directory it was written into with it", submitted !== null && !existsSync(dirname(submitted.appleApiKey)));

  // Credentials still set, so what stops this one is the platform guard and
  // nothing else — with them cleared first, the skip below would pass whether
  // the guard existed or not, which is a check that reads as coverage and is
  // not.
  submitted = null;
  let notMac = true;
  try {
    await hook({ ...context, electronPlatformName: "win32" });
  } catch {
    notMac = false;
  }
  check("nothing is submitted off macOS, credentials or no credentials", notMac && submitted === null);

  process.env.ASC_API_KEY_P8 = "";
  process.env.ASC_KEY_ID = "";
  process.env.ASC_ISSUER_ID = "";
  submitted = null;
  let skipped = true;
  try {
    await hook(context);
  } catch {
    skipped = false;
  }
  check("with no credentials the same hook returns quietly", skipped && submitted === null);

  Object.assign(process.env, saved);
  if (realNotarize) require.cache[notarizeModule] = realNotarize;
  else delete require.cache[notarizeModule];
}
