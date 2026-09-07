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
  check(
    "the build step decides --publish from the same decision, not a second copy of the condition",
    buildStep !== undefined && /--publish "\$publish_policy"/.test(buildStep) && /PUBLISH: \$\{\{ steps\.decide\.outputs\.publish \}\}/.test(buildStep),
  );
  check(
    "GH_TOKEN is the workflow's own built-in token — no new secret was added for this",
    buildStep !== undefined && /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(buildStep),
  );
  /*
    electron-builder's own `MacPackager.doSign()` logs `identityName=Developer
    ID Application: <company> (<team id>) identityHash=<sha1>` at "info" level
    on every signed build, unconditionally — proven on a runner, where a
    successful sign printed exactly that line to this public repository's
    Actions log. It is not one of this workflow's own `echo`s, so the
    certificate-subject checks above (which read the *preflight*'s shell) do
    not see it; this reads the Build step itself.
  */
  check(
    "ELECTRON-BUILDER'S OWN SIGNING LOG IS REDACTED — identityName carries the company name and Apple team id",
    buildStep !== undefined && /identityName=/.test(buildStep) && /sed -E/.test(buildStep),
  );
  check(
    "...and a failure inside that redacted pipe still fails the step",
    buildStep !== undefined && /pipefail/.test(buildStep),
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
