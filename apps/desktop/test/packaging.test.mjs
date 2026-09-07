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
 *
 * The first one was measured at **0** before these checks were asked of the
 * plist\'s keys rather than of its text: that file\'s header discusses every
 * entitlement it grants and several it refuses, so an `includes()` was true of
 * the prose after the key itself was gone.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** The builder config, read as text: this file has no YAML parser and needs none. */
const BUILDER = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
const ENTITLEMENTS = readFileSync(join(ROOT, "build/entitlements.mac.plist"), "utf8");

export function runPackagingChecks(check) {
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
  check("...for both architectures, because an Intel Mac is still a Mac", BUILDER.includes("arm64") && BUILDER.includes("x64"));
  check("it is a menu-bar app, with no dock icon", /LSUIElement:\s*true/.test(BUILDER));
  check("the notarisation hook is wired", BUILDER.includes("afterSign: build/notarize.cjs"));

  // -- the sentences macOS shows before anybody agrees to anything ----------
  for (const key of [
    "NSMicrophoneUsageDescription",
    "NSAudioCaptureUsageDescription",
    "NSCalendarsUsageDescription",
  ]) {
    check(`${key} is declared, or macOS kills the process instead of asking`, BUILDER.includes(key));
  }
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

  // -- the hook's one decision ----------------------------------------------
  const { credentials } = require(join(ROOT, "build/notarize.cjs"));
  check("no credentials at all is a skip, not a failure", credentials({}) === null);
  check(
    "TWO OF THREE IS ALSO A SKIP — a half-configured notarisation hangs on Apple's API and blames auth",
    credentials({ ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" }) === null &&
      credentials({ ASC_API_KEY_P8: "k", ASC_KEY_ID: "k" }) === null &&
      credentials({ ASC_API_KEY_P8: "k", ASC_ISSUER_ID: "i" }) === null,
  );
  const complete = credentials({ ASC_API_KEY_P8: "-----BEGIN", ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" });
  check("all three notarises", complete !== null && complete.keyId === "k" && complete.issuerId === "i");
  check(
    "an empty string is not a credential — a workflow passing an unset secret sets it to ''",
    credentials({ ASC_API_KEY_P8: "", ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" }) === null,
  );

  // -- what ships -----------------------------------------------------------
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check("packaging is one command", typeof manifest.scripts.package === "string");
  check("...and it builds the bundle first, because the dmg ships `dist/`", manifest.scripts.package.includes("scripts/build.mjs"));
  check("electron-builder is a devDependency, not something a build downloads", "electron-builder" in manifest.devDependencies);
  check("...as is the notarisation tool the hook requires", "@electron/notarize" in manifest.devDependencies);
  /*
    What ends up inside the asar, checked as a rule rather than as a list.

    Pinning the exact set was the first version and it was wrong in the
    direction that matters: it would have gone red on a workspace package the
    app legitimately started using, which is a check that has to be edited to
    stay true. What is worth holding is that this app ships **no third-party
    runtime code** — every dependency is one of ours, in this repository, and
    esbuild bundles it. A signed binary is the last place to grow a supply
    chain nobody reviewed.
  */
  check(
    "every runtime dependency is one of ours, in this repository",
    Object.keys(manifest.dependencies).every((name) => name.startsWith("@context/") || name.startsWith("@context-lc/")),
  );
  check("...and there is at least one, so that rule is checking something", Object.keys(manifest.dependencies).length > 0);
}
