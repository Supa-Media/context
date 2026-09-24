/**
 * The packaging, checked as far as a machine with no Mac can check it.
 *
 * None of this can be *proved* here — a signature, a notarisation ticket and a
 * TCC grant all need Apple and a laptop. What can be checked is everything that
 * silently produces a build which looks fine and cannot hear anything, and each
 * of those has cost somebody a day before:
 *
 *  - **an entitlements file without `com.apple.security.device.audio-input`**.
 *    The build signs, notarises, installs, opens, records — and captures
 *    silence, because TCC refused before any dialog was shown.
 *  - **`hardenedRuntime` off**. Notarisation is refused, and the failure names
 *    a flag rather than a reason.
 *  - **a missing usage string**. macOS kills the process the moment it asks for
 *    the microphone, with a crash log nobody reads as "you forgot a plist key".
 *  - **a notarisation hook that throws when it has no credentials**, which
 *    turns "let me look at the app" into a build failure, or one that
 *    half-runs, which hangs on Apple's API for ten minutes and then blames
 *    authentication.
 *  - **no app icon**, which ships Electron's atom. This one is not
 *    hypothetical: it went out, and the owner asked why their Dock had an
 *    atom in it. No key, no file at the default path, no warning — every
 *    other gate green, because an icon is the one part of the packaging that
 *    the app working perfectly tells you nothing about.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `com.apple.security.device.audio-input` removed from the entitlements       1
 *   `hardenedRuntime: false`                                                    1
 *   `NSMicrophoneUsageDescription` removed                                      2
 *   the notarize hook notarising with only two of the three ASC values          1
 *   `entitlementsInherit` dropped (the helper processes lose the mic)           1
 *   a `<key>` left behind with its `<true/>` deleted                            2
 *   the runtime-dependency rule matching a scope prefix instead of `workspace:` 1
 *   a notarisation Apple refused caught and logged instead of thrown            1
 *   `rmSync` in the hook's `finally` made a no-op (the key stays on the runner) 2
 *   the `electronPlatformName !== "darwin"` guard removed                       1
 *   the `publish` input's default flipped to `true`                            1
 *   the build job's `contents: write` override dropped back to `read`          1
 *   the exact-pin regex given its `\^?` back, and `electron-updater` re-floated 1
 *   the launch-the-built-app step removed outright                             12
 *   that step moved to after the artifact upload                               1
 *   `Dynamic require` dropped from the launch step's crash-string grep         1
 *   the Build step given `--publish always` back                              1
 *   the publish-the-release step removed outright                             8
 *   that step moved to before the launch/smoke step                           1
 *   the smoke-outcome gate dropped from the publish step's `if:`              1
 *   `env -u ELECTRON_RUN_AS_NODE` dropped from the launch command            1
 *   the deadline back to `perl -e 'alarm 30; exec @ARGV'`, no SIGKILL        2
 *   the deadline shortened below the app's own `--smoke` timer               1
 *   "still alive at the deadline" no longer failing the step                 1
 *   the x64 leg's timeout switched from a warning back to a fatal FAIL      1
 *   the crash-string check scoped to skip the x64 leg                      1
 *   the `icon:` key removed from `electron-builder.yml`                    1
 *   `build/icon.icns` deleted, the key left pointing at nothing            1
 *   the icns rebuilt with only its 1024 rung                               1
 *   `withoutYamlComments` made a no-op (its self-test, in appShell)        2
 *
 * The first one was measured at **0** before these checks were asked of the
 * plist\'s keys rather than of its text: that file\'s header discusses every
 * entitlement it grants and several it refuses, so an `includes()` was true of
 * the prose after the key itself was gone.
 *
 * **The icon rows are the same lesson, and were written already knowing it.**
 * With the `icon:` key deleted and the comments left alone, a plain
 * `BUILDER.includes("icon.icns")` still returns true — measured — because the
 * paragraph above that key explains what the file is and why it is named. The
 * check is anchored to a whole line *and* run against the config with comments
 * stripped, and the row above showing the stripper reddening its own self-test
 * is what keeps that second half honest.
 *
 * ## This file, split
 *
 * The suite grew past the size ceiling and was split by behaviour into
 * `packaging/`. This module covers the entitlements plist, the
 * electron-builder config and the app icon. `notarizeAndShip.test.mjs`
 * covers the notarize hook's credential decision, the `.p8` repair logic and
 * what ends up inside the signed bundle. `deployWorkflow.test.mjs` covers
 * the deploy workflow: the keychain it signs from, manual-publish gating,
 * the launch-before-publish gate, and the notarize hook's behaviour when
 * Apple refuses. `fixtures.mjs` holds the reads and constants all three
 * share.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutYamlComments } from "../appShell.test.mjs";
import { ROOT, BUILDER, ENTITLEMENTS } from "./fixtures.mjs";

export async function runEntitlementsAndIconChecks(check) {
  // -- the entitlement that decides whether this app can hear anything -------
  /*
    Asked of the plist's own keys, never of the file's text. The header of that
    file discusses every entitlement it declares and several it deliberately
    does not, so `includes("…audio-input")` was true of the *prose* — deleting
    the key left this check green, which is a check that reads a sentence about
    itself.
  */
  const granted = (name) => new RegExp(`<key>${name.replace(/\./g, "\\.")}</key>\\s*<true/>`).test(ENTITLEMENTS);
  check(
    "THE MICROPHONE ENTITLEMENT IS GRANTED — without it a signed build records silence",
    granted("com.apple.security.device.audio-input"),
  );
  check("Chromium's JIT is allowed, or the renderer will not start", granted("com.apple.security.cs.allow-jit"));
  check("...and its unsigned executable memory with it", granted("com.apple.security.cs.allow-unsigned-executable-memory"));
  check(
    "library validation is disabled, or a signed app refuses its own framework",
    granted("com.apple.security.cs.disable-library-validation"),
  );
  check(
    "the camera is NOT granted — this app has no video path",
    // Asked of the plist's own keys rather than of the file: the header
    // *names* this entitlement in its list of deliberate absences, and a check
    // that reads prose is a check that fails on a sentence about itself.
    !/com\.apple\.security\.device\.camera<\/key>/.test(ENTITLEMENTS),
  );

  /*
    A plist `codesign` will accept at all.

    Not a parser — this suite has no XML dependency and does not want one — but
    the two shapes that break signing with an unhelpful error: an unbalanced
    dict, and a key with no value after it. Every entitlement here is a boolean,
    so the counts have to match, and a `<key>` left behind by a deletion is
    exactly what that catches.
  */
  const keys = (ENTITLEMENTS.match(/<key>/g) ?? []).length;
  const booleans = (ENTITLEMENTS.match(/<(?:true|false)\/>/g) ?? []).length;
  check("the entitlements plist is balanced: one value per key", keys > 0 && keys === booleans);
  check(
    "...inside exactly one dict, in a plist",
    (ENTITLEMENTS.match(/<dict>/g) ?? []).length === 1 &&
      (ENTITLEMENTS.match(/<\/dict>/g) ?? []).length === 1 &&
      ENTITLEMENTS.includes("<plist version=\"1.0\">"),
  );

  // -- the build that macOS will accept -------------------------------------
  check("the hardened runtime is on, which notarisation requires", /hardenedRuntime:\s*true/.test(BUILDER));
  check("the entitlements file is the one above", BUILDER.includes("build/entitlements.mac.plist"));
  check(
    "...and the helper processes inherit it, or the renderer that holds the microphone does not have it",
    /entitlementsInherit:\s*build\/entitlements\.mac\.plist/.test(BUILDER),
  );
  check("it builds a dmg", /target:\s*dmg/.test(BUILDER));
  check(
    "IT BUILDS A ZIP TOO — Squirrel.Mac applies an update from a zip, never a dmg",
    /target:\s*zip/.test(BUILDER),
  );
  check("...for both architectures, because an Intel Mac is still a Mac", BUILDER.includes("arm64") && BUILDER.includes("x64"));
  /*
    A check that used to be here, deliberately gone rather than quietly dropped:

        check("it is a menu-bar app, with no dock icon", /LSUIElement:\s*true/.test(BUILDER));

    It asserted the opposite of what this app now is. `LSUIElement` was removed
    from `electron-builder.yml` when the console became what a launch opens —
    the owner's report was "I dont even see a launched app" — and that file's
    `extendInfo` block explains the removal at length. The check went on passing
    anyway, because it matched the *explanation*: `# \`LSUIElement: true\` used
    to be here`. It was green while asserting a fact that had been false for as
    long as the sentence keeping it green had existed.

    Deleting it loses no coverage. `appShell.test.mjs` asserts the true fact —
    that `LSUIElement` is absent — against the config with comments stripped,
    and carries `LSUIElement: true` put back as a sabotage row. That is the
    assertion; this was its stale negation.
  */
  check("the notarisation hook is wired", BUILDER.includes("afterSign: build/notarize.cjs"));

  // -- the icon that tile in the Dock actually draws -------------------------
  /*
    The defect this section is about: the owner asked why the app in their Dock
    was the Electron atom. It was never configured. There was no `icon:` key in
    this file and no file at electron-builder's default `build/icon.icns`, and
    that combination does not warn — electron-builder falls back to the
    `electron.icns` inside its own dependency and writes it into
    `CFBundleIconFile`. Confirmed on the shipped app:

        $ PlistBuddy -c "Print :CFBundleIconFile" Context.app/Contents/Info.plist
        electron.icns

    Every other gate was green. It signed, it notarised, Gatekeeper accepted it,
    the smoke test launched it. An icon is the one part of the packaging that no
    amount of the app working correctly can tell you about, which is why it went
    out and stayed out.

    Asked of the config with its comments stripped, for the reason this suite
    has already been bitten by twice: the paragraph above the key discusses
    `icon.icns`, the default path and `CFBundleIconFile` by name, so every check
    here would pass on the prose with the key itself deleted.

    And asked of the `mac:` block rather than of the file, because `icon:` is a
    real key in more than one section. Anchored to a whole line but not to a
    parent, this check stayed green with the key moved under `dmg:` — where it
    names the volume icon of the disk image and says nothing about the app —
    which is the original defect shipping again behind a passing test.
  */
  const builderKeys = withoutYamlComments(BUILDER);
  /* From `mac:` to the next line that starts a section of its own. */
  const macBlock = (() => {
    const lines = builderKeys.split("\n");
    const start = lines.findIndex((line) => /^mac:\s*$/.test(line));
    if (start === -1) return "";
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^\S/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  })();
  check(
    "THE APP ICON IS CONFIGURED — unset, electron-builder silently ships its own atom",
    /^\s+icon:\s*build\/icon\.icns\s*$/m.test(macBlock),
  );
  check(
    "...and the file it names is really there, because the key alone is not the icon",
    existsSync(join(ROOT, "build/icon.icns")),
  );

  /*
    A real icns, and a complete one.

    An `.icns` is a container: `icns`, a length, then `[4-byte type][length]
    [data]` chunks. macOS picks the member matching what it is drawing — 16 and
    32 for the Finder list and the menu bar, 512 and 1024 for the Dock and Quick
    Look — and falls back to resampling the nearest when a rung is missing. A
    single-resolution file is therefore not a failure anyone sees as one: it
    looks right in the Dock and smeared everywhere else, which is exactly the
    kind of half-fix this check exists to refuse.
  */
  const ICNS = readFileSync(join(ROOT, "build/icon.icns"));
  check(
    "it is an icns rather than a renamed png, and its own length header agrees",
    ICNS.subarray(0, 4).toString("ascii") === "icns" && ICNS.readUInt32BE(4) === ICNS.length,
  );
  const chunks = new Set();
  for (let at = 8; at + 8 <= ICNS.length; ) {
    chunks.add(ICNS.subarray(at, at + 4).toString("ascii"));
    const size = ICNS.readUInt32BE(at + 4);
    if (size < 8) break; // a zero length would spin here; a malformed file is a failure below
    at += size;
  }
  /*
    The ladder `iconutil` emits for a full iconset, by the type codes it writes:
    16, 32, 128, 256 and 512 at 1x (ic04, ic05, ic07, ic08, ic09) and their @2x
    partners 32, 64, 256, 512 and 1024 (ic11, ic12, ic13, ic14, ic10).
  */
  const RUNGS = {
    ic04: "16", ic05: "32", ic07: "128", ic08: "256", ic09: "512",
    ic11: "16@2x", ic12: "32@2x", ic13: "128@2x", ic14: "256@2x", ic10: "512@2x",
  };
  const missing = Object.entries(RUNGS).filter(([type]) => !chunks.has(type)).map(([, size]) => size);
  check(
    `IT CARRIES THE WHOLE LADDER, 16 TO 1024 — a one-size icns looks right in the Dock and smeared in Finder${
      missing.length ? ` (missing ${missing.join(", ")})` : ""
    }`,
    missing.length === 0,
  );

  check(
    "publishing targets GitHub Releases, not left for a build to guess a provider",
    /publish:\s*\n\s*provider:\s*github/.test(BUILDER),
  );
  check(
    "...as a real release, not a draft the update check can never see",
    /releaseType:\s*release/.test(BUILDER),
  );
  check(
    "...pinned to this repository, so a fork publishes to itself rather than here",
    /owner:\s*Supa-Media/.test(BUILDER) && /repo:\s*context/.test(BUILDER),
  );
  check(
    "writeUpdateInfo is not turned off — that flag is what silently starves the updater of latest-mac.yml",
    !/writeUpdateInfo:\s*false/.test(BUILDER),
  );

  // -- the sentences macOS shows before anybody agrees to anything ----------
  //
  // The declaration, `key + ":"`, and not the comment about it — this file's
  // own header already argues that distinction for the microphone string
  // below; the two keys this defect added are held to the same rule rather
  // than the looser substring check the original three had, which a header
  // comment naming a renamed key in prose would still have passed.
  for (const key of [
    "NSMicrophoneUsageDescription",
    "NSAudioCaptureUsageDescription",
    "NSCalendarsUsageDescription",
    "NSCalendarsFullAccessUsageDescription",
    "NSAppleEventsUsageDescription",
  ]) {
    check(`${key} is declared, or macOS kills the process instead of asking`, BUILDER.includes(`${key}:`));
  }

  /*
    EVERY PERMISSION A COLLECTOR OR THE RECORDER ACTUALLY ASKS FOR HAS ITS
    PLIST STRING — named against the source file that asks, not against a
    list somebody remembers to keep in step by hand.

    Found the hard way: `NSAppleEventsUsageDescription` and
    `NSCalendarsFullAccessUsageDescription` were both absent while
    `core/detection/collectors.ts`' own header already said "browser tab URLs
    need Automation, and the calendar needs Calendars" — the plist and the
    code disagreed about what this app needs, and nothing here would have
    caught it, because the check above only knew the three keys it was
    written to know about. Read on the owner's own Mac, on the shipped
    bundle identifier: three Apple Events rows already granted despite the
    missing string, and the Calendar row sitting at the write-only value
    macOS 14+ hands out to an app that only declares the legacy key — see
    `docs/decisions/desktop-updates.md`, "The one-way door", for both
    findings and what they do and do not explain.

    This table is therefore read against the actual collector source, not
    hand-typed twice: `windows()` and `calendarEvents()` are the two
    `SignalCollectors` members `platform/macos/windows.ts` and
    `platform/macos/calendar.ts` implement over `osascript`/JXA (Apple
    Events), and `calendar.ts` additionally reads calendar *data*, which is
    the second, separate TCC category `NSCalendarsFullAccessUsageDescription`
    gates. A collector added later that also shells out to another
    application and is never added here is exactly the gap this guard cannot
    see — which is why it reads the collector interface's own member names
    rather than a list somebody typed from memory.
  */
  const WINDOWS_SOURCE = readFileSync(join(ROOT, "src/platform/macos/windows.ts"), "utf8");
  const CALENDAR_SOURCE = readFileSync(join(ROOT, "src/platform/macos/calendar.ts"), "utf8");
  check(
    "windows() drives another application over Apple Events, as documented",
    /osascript/.test(WINDOWS_SOURCE),
  );
  check(
    "calendarEvents() drives Calendar.app over Apple Events, as documented",
    /osascript/.test(CALENDAR_SOURCE),
  );
  check(
    "BOTH COLLECTORS THAT SEND APPLE EVENTS ARE COVERED BY ONE USAGE STRING",
    BUILDER.includes("NSAppleEventsUsageDescription:"),
  );
  check(
    "THE CALENDAR COLLECTOR'S OWN DATA READ IS COVERED BY THE FULL-ACCESS STRING, not only the legacy one",
    BUILDER.includes("NSCalendarsFullAccessUsageDescription:"),
  );
  /*
    The *declaration*, not the comment about it. `BUILDER.split(key)[1]` read
    the header's own prose — this file explains both keys before it sets them —
    so the check passed on a sentence rather than on the string macOS will show.
  */
  //
  // Whitespace is collapsed first, because the string is folded across lines in
  // the YAML and macOS shows it as one sentence: a check that matched the file's
  // line breaks would be checking the indentation rather than the sentence.
  const microphoneString = (BUILDER.split("NSMicrophoneUsageDescription:")[1] ?? "")
    .slice(0, 400)
    .replace(/\s+/g, " ");
  check(
    "the microphone string says what happens to the audio, because that is the whole question",
    /thrown away|never saved|not stored/.test(microphoneString),
  );
  check(
    "...and says the audio is opened only for a meeting somebody started",
    /only after you press|only for a meeting/i.test(microphoneString),
  );

}
