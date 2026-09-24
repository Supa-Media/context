/**
 * The notarisation hook's credential decision, the `.p8` repair logic, and
 * what ends up inside the signed bundle. Split out of `packaging.test.mjs`;
 * see that file's header for the full rationale and the sabotage record, and
 * `fixtures.mjs` for the shared `ROOT`/`require`/`P8`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { ROOT, require, P8 } from "./fixtures.mjs";

export async function runNotarizeAndShipChecks(check) {
  // -- the hook's one decision ----------------------------------------------
  const { credentials, privateKey } = require(join(ROOT, "build/notarize.cjs"));
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

}
