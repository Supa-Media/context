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
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";

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
  check(
    "IT BUILDS A ZIP TOO — Squirrel.Mac applies an update from a zip, never a dmg",
    /target:\s*zip/.test(BUILDER),
  );
  check("...for both architectures, because an Intel Mac is still a Mac", BUILDER.includes("arm64") && BUILDER.includes("x64"));
  check("it is a menu-bar app, with no dock icon", /LSUIElement:\s*true/.test(BUILDER));
  check("the notarisation hook is wired", BUILDER.includes("afterSign: build/notarize.cjs"));
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
  const { credentials, privateKey } = require(join(ROOT, "build/notarize.cjs"));
  /*
    A .p8 as Apple issues it, with a fake key in it. Every check below is about
    the *shape* of the document, so the bytes inside can be nonsense — and in a
    public repository they had better be.
  */
  const P8 = "-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PRIVATE KEY-----";
  check("no credentials at all is a skip, not a failure", credentials({}) === null);
  check(
    "TWO OF THREE IS ALSO A SKIP — a half-configured notarisation hangs on Apple's API and blames auth",
    credentials({ ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" }) === null &&
      credentials({ ASC_API_KEY_P8: P8, ASC_KEY_ID: "k" }) === null &&
      credentials({ ASC_API_KEY_P8: P8, ASC_ISSUER_ID: "i" }) === null,
  );
  const complete = credentials({ ASC_API_KEY_P8: P8, ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" });
  check("all three notarises", complete !== null && complete.keyId === "k" && complete.issuerId === "i");
  check(
    "an empty string is not a credential — a workflow passing an unset secret sets it to ''",
    credentials({ ASC_API_KEY_P8: "", ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" }) === null,
  );

  // -- the .p8, after a text box has had it ---------------------------------
  /*
    The first build to get past code signing died twenty-six seconds later on

      Failed to notarize via notarytool. Error: invalidPEMDocument

    which says the file the hook wrote is not a PEM and nothing whatever about
    why. A .p8 is a multi-line PEM and a secret store is a text box, so the four
    repairs below are the four ways it arrives damaged — each unambiguous, each
    checked here rather than discovered on a runner after a signing run.

    The fifth case is the one that must NOT be repaired: something that is not a
    private key is refused, with a sentence that counts lines and characters and
    prints none of them.
  */
  const escaped = P8.replace(/\n/g, "\\n");
  check("a key stored with its newlines escaped is repaired", privateKey(escaped) === P8 + "\n");
  check("...and one with CRLF line endings", privateKey(P8.replace(/\n/g, "\r\n")) === P8 + "\n");
  check(
    "...and one base64-encoded whole, which is what the certificate secret wanted",
    privateKey(Buffer.from(P8, "utf8").toString("base64")) === P8 + "\n",
  );
  check("...and one with quotes left round it", privateKey(`"${P8}"`) === P8 + "\n");
  check("an intact key is returned intact, with the newline notarytool reads to", privateKey(P8) === P8 + "\n");

  /*
    A fifth way the .p8 arrives damaged, found on a real run rather than
    guessed at: every newline gone, not escaped to `\n` and not CRLF, just
    absent (or, on the actual failing secret — diagnosed structurally, never
    by reading its content — turned into a handful of stray whitespace
    characters where the line breaks used to be). Either way the BEGIN/END
    markers and the base64 body survive, run together on one line. Unambiguous
    because a real PEM's body is pure base64 once its incidental whitespace is
    stripped, and its BEGIN/END labels match, so this is repaired by
    re-wrapping rather than refused — anything that does not fit that exact
    shape falls through to the ordinary refusal below.
  */
  const realPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const oneLine = realPem.trim().split("\n").join("");
  check(
    "a real key with every newline lost — BEGIN, base64 and END run onto one line — is repaired",
    (() => {
      // Not equality against `realPem`: this only asserts the repaired text
      // is a PEM `node:crypto` accepts, which is what "repaired" has to mean
      // — the wrapping algorithm need not reproduce Node's own line breaks
      // byte-for-byte to be a valid, parseable PKCS#8 document.
      try {
        createPrivateKey(privateKey(oneLine));
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    "...wrapped at 64 characters a line, like the file Apple issued",
    privateKey(oneLine)
      .trim()
      .split("\n")
      .slice(1, -1)
      .every((line) => line.length <= 64),
  );
  check(
    "...ending in the newline notarytool reads to, same as every other shape",
    privateKey(oneLine).endsWith("\n"),
  );
  const oneLineBody = oneLine.slice("-----BEGIN PRIVATE KEY-----".length, -"-----END PRIVATE KEY-----".length);
  check(
    "a one-line body with a stray character is refused, not silently dropped",
    (() => {
      try {
        privateKey(`-----BEGIN PRIVATE KEY-----${oneLineBody.slice(0, -1)}!-----END PRIVATE KEY-----`);
        return false;
      } catch {
        return true;
      }
    })(),
  );
  check(
    "...and mismatched one-line labels are refused, not paired up by guesswork",
    (() => {
      try {
        privateKey(`-----BEGIN PRIVATE KEY-----${oneLineBody}-----END EC PRIVATE KEY-----`);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  /*
    The shape actually found in production: newlines turned to single spaces
    rather than deleted outright — every one of `realPem`'s three line breaks
    replaced with " " instead of "". Confirmed by a content-blind diagnostic
    run against the real, still-failing secret (structure only: it reported
    matching BEGIN/END labels and a body that was pure base64 except for a
    handful of whitespace characters — never the base64 itself).
  */
  const spaceJoined = realPem.trim().split("\n").join(" ");
  check(
    "a real key with its newlines turned to spaces — the shape found on the live secret — is repaired",
    (() => {
      try {
        createPrivateKey(privateKey(spaceJoined));
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    "...however many spaces stand in for the lost newline, not just exactly one",
    (() => {
      try {
        createPrivateKey(privateKey(realPem.trim().split("\n").join("   ")));
        return true;
      } catch {
        return false;
      }
    })(),
  );
  check(
    "...but a stray non-whitespace character among the spaces is still refused",
    (() => {
      try {
        privateKey(spaceJoined.slice(0, -30) + "!" + spaceJoined.slice(-29));
        return false;
      } catch {
        return true;
      }
    })(),
  );

  const refused = (value) => {
    try {
      privateKey(value);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  /*
    THE REFUSAL REACHES A PUBLIC LOG, SO IT MUST NOT CARRY THE KEY.

    The `require.main === module` block at the foot of `notarize.cjs` — what
    `--check` runs in CI — writes `::error::` plus the message into the Actions
    log of a public, MIT-licensed repository. (`exports.default` has no catch at
    all; an earlier version of this comment said it did, which was wrong about
    the file it sits beside.) `privateKey`'s throw is careful
    today — it reports a line count, a character count and whether the markers
    were seen, and never `text` itself — but nothing was checking that, and the
    cheapest debugging change anybody could make to it is to interpolate the
    value that failed to parse.

    This repository has already been bitten by exactly that shape once:
    `MacPackager.doSign()` printed the signing identity, company name and Apple
    team id to a public log on the first successful signed build, and needed a
    `sed` in the workflow to redact it. That one was a dependency's logging. This
    one would be ours, and it would be a private key.

    So: every refusal is asked whether any run of the thing it refused survived
    into the sentence. A base64 body is the part worth stealing, so the probe is
    a distinctive body rather than a generic one — a message that echoed even a
    fragment would contain a slice of it.
  */
  {
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk";
    const shapes = [
      body,
      `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`,
      `-----BEGIN PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`,
      `-----BEGIN PRIVATE KEY-----\n${body}`,
      `  ${body}  `,
      `-----BEGIN PRIVATE KEY-----\r\n${body}`,
    ];
    /*
      EIGHT CHARACTERS OF THE BODY, not sixteen, and every offset rather than
      every other one. MEASURED against the check above this block, which asks
      whether one short probe survives whole: `text.slice(20, 60)` — a
      mid-string echo — passes it and fails this; `text.slice(0, 10)` passed
      BOTH at sixteen. A ten-character prefix of a PEM file is the `-----BEGIN`
      marker rather than key material, so that one is not the leak it looks
      like, but the reason has to be the run length rather than luck.

      Eight is short enough to catch a partial echo and long enough not to
      collide with the fixed prose: the refusal's own words are checked below
      to still be there, so a run length that made this vacuous would show up
      as this block passing while that one fails.
    */
    const runs = [];
    for (let i = 0; i + 8 <= body.length; i += 1) runs.push(body.slice(i, i + 8));

    const leaked = [];
    for (const shape of shapes) {
      const message = refused(shape);
      // A shape this repairs rather than refuses is fine — the check is about
      // what a REFUSAL says, and a repair says nothing at all.
      if (message === null) continue;
      if (message.includes(body) || runs.some((run) => message.includes(run))) {
        leaked.push(shape.slice(0, 24));
      }
    }
    check(
      "A REFUSED App Store Connect KEY IS NEVER QUOTED BACK — the message reaches a public Actions log",
      leaked.length === 0,
    );
    check(
      "...and the refusals still say enough to act on: a count, and which marker was missing",
      /\d+ line\(s\)/.test(refused("hello") ?? "") &&
        /characters/.test(refused("hello") ?? "") &&
        /-----BEGIN/.test(refused("hello") ?? ""),
    );
  }

  check("SOMETHING THAT IS NOT A PRIVATE KEY IS REFUSED, not written out for notarytool to reject", refused("hello") !== null);
  check(
    "...a truncated paste too — a BEGIN with no matching END",
    refused("-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=") !== null,
  );
  check(
    "...and the refusal names the secret and what it should hold",
    /ASC_API_KEY_P8/.test(refused("hello") ?? "") && /\.p8/.test(refused("hello") ?? ""),
  );
  check(
    "...WITHOUT PRINTING ANY OF IT — a private key does not go in a public repository's logs",
    !(refused("sensitive-nonsense") ?? "").includes("sensitive-nonsense"),
  );
  check(
    "...and base64 of something binary is named as what it almost certainly is — the certificate, in the wrong secret",
    /belongs in CSC_LINK/.test(refused(Buffer.from([0x30, 0x82, 0x0a, 0x1f, 0x02, 0x01, 0x03]).toString("base64")) ?? ""),
  );
  check(
    "a key present but unusable is not a skip — the build was asked to notarise and cannot",
    refused("hello") !== null && credentials({ ASC_API_KEY_P8: "", ASC_KEY_ID: "k", ASC_ISSUER_ID: "i" }) === null,
  );

  // -- what ships -----------------------------------------------------------
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check("packaging is one command", typeof manifest.scripts.package === "string");
  check("...and it builds the bundle first, because the dmg ships `dist/`", manifest.scripts.package.includes("scripts/build.mjs"));
  check("electron-builder is a devDependency, not something a build downloads", "electron-builder" in manifest.devDependencies);
  check("...as is the notarisation tool the hook requires", "@electron/notarize" in manifest.devDependencies);
  check(
    "A LOCAL `pnpm package` NEVER PUBLISHES — electron-builder's own default for a config carrying a `publish` block is not something to trust a developer's ambient GH_TOKEN against",
    /--publish\s+never/.test(manifest.scripts.package),
  );
  /*
    What ends up inside the asar, checked as a rule rather than as a list.

    Pinning the exact set was the first version and it was wrong in the
    direction that matters: it would have gone red on a workspace package the
    app legitimately started using, which is a check that has to be edited to
    stay true. What is worth holding is that this app ships **almost no**
    third-party runtime code — every dependency is one of ours, in this
    repository, with exactly one named exception below — and esbuild bundles
    all of it. A signed binary is the last place to grow a supply chain nobody
    reviewed.

    ## The one exception, and why it earns the name rather than the rule

    `electron-updater` is the library `docs/decisions/desktop.md`'s "The shell
    updates itself" section decided on, and there is no `workspace:` version of
    it to depend on instead — it is the mechanism this step exists to add, the
    same way `electron` and `electron-builder` already are third-party and
    already are load-bearing. Refusing it here would be refusing the
    deliverable, not guarding anything, so it is named once, pinned to an exact
    version rather than left to float, and nothing else gets the same pass.
  */
  const THIRD_PARTY_RUNTIME_DEPENDENCIES = new Set(["electron-updater"]);
  check(
    "every runtime dependency is either ours, in this repository, or the one named exception",
    // `workspace:` rather than a scope prefix, and the difference is not
    // cosmetic: the first version matched `@context/` and `@context-lc/`, and
    // #263 renamed the hook to `@supa-media/context-hook` — a package that is
    // still ours, still in this repository, and would have turned this check
    // red for a rename. What is being asserted is "resolved from this
    // workspace, not downloaded", and pnpm spells that `workspace:`.
    Object.entries(manifest.dependencies).every(
      ([name, range]) =>
        THIRD_PARTY_RUNTIME_DEPENDENCIES.has(name) || String(range).startsWith("workspace:"),
    ),
  );
  check(
    "...and the exception is pinned to an exact version, not left to float in a signed binary",
    // No leading `^`, `~`, or anything else that lets a registry resolve to a
    // version nobody reviewed: `^6.3.9` reads as "pinned" in the manifest and
    // is not one, because that range still matches `6.4.0`. This check was
    // itself the hole once — `/^\^?\d+\.\d+\.\d+$/` made the caret optional
    // and so accepted the very range it existed to refuse.
    /^\d+\.\d+\.\d+$/.test(String(manifest.dependencies["electron-updater"])),
  );
  check(
    "...and a caret range is what this check exists to catch, not something it would wave through",
    !/^\d+\.\d+\.\d+$/.test("^6.3.9"),
  );
  check(
    "...and it is exactly one exception, not a name that quietly grew a second meaning",
    THIRD_PARTY_RUNTIME_DEPENDENCIES.size === 1,
  );
  check("...and there is at least one workspace dependency, so that rule is checking something", Object.keys(manifest.dependencies).length > THIRD_PARTY_RUNTIME_DEPENDENCIES.size);
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
  const keyCheck = steps.find((step) => /notarize\.cjs --check/.test(step));
  check(
    "the notarisation key is judged before the build too, not after twenty-six seconds of signing",
    keyCheck !== undefined && steps.indexOf(keyCheck) < steps.indexOf(buildStep),
  );

  // -- publishing: a boolean input, gated permissions, and idempotency --------
  /*
    `docs/decisions/desktop.md`'s fourth "shell updates itself" decision: a
    `publish` dispatch input, `contents: write` scoped to the one job that can
    ever use it, and a refusal to publish a version this workflow already
    released. None of this can be *exercised* here — that needs a Mac, a real
    certificate and a real GitHub Release — but every one of these has failed
    silently before in this exact file (see the sabotage record above), so what
    is checked is the shape that would let it fail silently again.
  */
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
    "publishing is decided once, from the dispatch input AND both credentials — not the input alone",
    /PUBLISH_REQUESTED/.test(WORKFLOW) &&
      /SIGNED/.test(WORKFLOW) &&
      /NOTARIZED/.test(WORKFLOW) &&
      /\$PUBLISH_REQUESTED"\s*=\s*"true"\s*\]\s*&&\s*\[\s*"\$SIGNED"\s*=\s*"true"\s*\]\s*&&\s*\[\s*"\$NOTARIZED"\s*=\s*"true"/.test(
        WORKFLOW,
      ),
  );
  check(
    "an already-released version refuses to publish again, before the build rather than after",
    /gh release view "\$TAG"/.test(WORKFLOW) &&
      steps.indexOf(steps.find((step) => /gh release view/.test(step))) < steps.indexOf(buildStep),
  );
  check(
    "the version comes from apps/desktop/package.json, never bumped by this workflow itself",
    /require\('\.\/package\.json'\)\.version/.test(WORKFLOW) && !/npm version|package\.json['"],?\s*JSON\.stringify/.test(WORKFLOW),
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
    "nothing about a branch triggers this workflow, signing or no signing",
    /^on:\n  workflow_dispatch:/m.test(WORKFLOW) && !/^\s*(push|pull_request):/m.test(WORKFLOW),
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
