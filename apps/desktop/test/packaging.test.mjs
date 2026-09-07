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
 *   the runtime-dependency rule matching a scope prefix instead of `workspace:` 1
 *   a notarisation Apple refused caught and logged instead of thrown            1
 *   `rmSync` in the hook's `finally` made a no-op (the key stays on the runner) 2
 *   the `electronPlatformName !== "darwin"` guard removed                       1
 *
 * The first one was measured at **0** before these checks were asked of the
 * plist\'s keys rather than of its text: that file\'s header discusses every
 * entitlement it grants and several it refuses, so an `includes()` was true of
 * the prose after the key itself was gone.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** The builder config, read as text: this file has no YAML parser and needs none. */
const BUILDER = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
const ENTITLEMENTS = readFileSync(join(ROOT, "build/entitlements.mac.plist"), "utf8");

export async function runPackagingChecks(check) {
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
    // `workspace:` rather than a scope prefix, and the difference is not
    // cosmetic: the first version matched `@context/` and `@context-lc/`, and
    // #263 renamed the hook to `@supa-media/context-hook` — a package that is
    // still ours, still in this repository, and would have turned this check
    // red for a rename. What is being asserted is "resolved from this
    // workspace, not downloaded", and pnpm spells that `workspace:`.
    Object.values(manifest.dependencies).every((range) => String(range).startsWith("workspace:")),
  );
  check("...and there is at least one, so that rule is checking something", Object.keys(manifest.dependencies).length > 0);
  check(
    "...and it would notice a real one — a registry range is not a workspace range",
    !["^1.0.0", "1.0.0", "latest", "npm:left-pad@1"].some((range) => String(range).startsWith("workspace:")),
  );

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
  check(
    "nothing about a branch triggers this workflow, signing or no signing",
    /^on:\n  workflow_dispatch:/m.test(WORKFLOW) && !/^\s*(push|pull_request):/m.test(WORKFLOW),
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
  process.env.ASC_API_KEY_P8 = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n";
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
