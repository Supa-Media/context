/**
 * Notarisation, when there is anything to notarise with — and a clean skip when
 * there is not.
 *
 * electron-builder calls this `afterSign`, on every macOS build, including the
 * unsigned one somebody runs on their laptop to see whether the app opens. So
 * the first thing it does is decide whether it has been asked to do anything at
 * all, and the rule is: **all three App Store Connect values, or nothing.**
 *
 * That is not defensiveness, it is the difference between two failure modes.
 * A hook that throws on a missing key turns "I wanted to look at the app" into
 * a build failure with an Apple error code in it. A hook that half-runs — a key
 * id with no issuer — hangs on Apple's API and fails ten minutes later saying
 * something about authentication. Neither is worth having, so the absent case
 * is a printed sentence and a return.
 *
 * ## Why it says what it skipped
 *
 * A build that quietly did not notarise is a `.dmg` somebody ships, installs,
 * and watches Gatekeeper refuse — or worse, one that installs and then gets no
 * microphone, because macOS declines to grant TCC to an unsigned
 * hardened-runtime app and says nothing a person can act on. The log line is
 * what makes "this build will not capture system audio" visible at the moment
 * it becomes true rather than on somebody's Mac a week later.
 *
 * ## The three values, and where they come from
 *
 * `ASC_API_KEY_P8` is the **contents** of the `.p8` file — a private key, so it
 * travels as a secret and is written to a temporary file here rather than
 * committed anywhere. `ASC_KEY_ID` and `ASC_ISSUER_ID` identify it. Signing
 * itself needs `CSC_LINK` and `CSC_KEY_PASSWORD`, which electron-builder reads
 * directly and this hook never sees.
 *
 * CommonJS on purpose: electron-builder `require`s this file.
 */

const { notarize } = require("@electron/notarize");
const { mkdtempSync, rmSync, writeFileSync, chmodSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

/**
 * The .p8 as `notarytool` needs to read it, out of a secret that has been
 * through a text box.
 *
 * This is not defensiveness either: the first signed build to get past code
 * signing died on
 *
 *   Failed to notarize via notarytool. Error: invalidPEMDocument
 *
 * after twenty-six seconds of signing, which says only "the file I wrote is
 * not a PEM" and nothing about why. A `.p8` is a multi-line PEM, and every
 * common way of getting one into a secret store damages it in one of four
 * ways: CRLF line endings, newlines escaped to a literal backslash-n, the
 * whole file base64-encoded because that is what \`CSC_LINK\` wanted, or quotes
 * left around it by a copy from a JSON blob. Each of those is unambiguous and
 * repaired here.
 *
 * What is NOT repaired is a value that is not a private key at all, and that
 * throws with a sentence somebody can act on — counting lines and characters,
 * never printing any of them, because this is a private key and the logs of a
 * public repository are public.
 *
 * A fifth shape joins those four, found on a real run rather than guessed at:
 * every newline gone — not escaped to a literal `\n`, not CRLF, just absent —
 * which is what a single-line ("password"-typed) field in 1Password does to a
 * multi-line paste. `-----BEGIN ... -----`, the base64 body and
 * `-----END ... -----` survive, run together on one line. That is unambiguous
 * enough to re-wrap: a real PEM's body is pure base64 and its BEGIN/END labels
 * match, so anything of that exact shape is repaired below, and anything that
 * is merely close to it (a stray character in the body, labels that do not
 * match) is left for the ordinary refusal at the end of this function rather
 * than guessed at.
 */
function privateKey(raw) {
  let text = String(raw).replace(/\r\n?/g, "\n").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (text.includes("\\n")) {
    text = text.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  }
  const oneLine = /^-----BEGIN ([A-Z ]+)-----([A-Za-z0-9+/=]+)-----END \1-----$/.exec(text);
  if (oneLine) {
    const [, label, body] = oneLine;
    const wrapped = body.match(/.{1,64}/g) ?? [body];
    text = `-----BEGIN ${label}-----\n${wrapped.join("\n")}\n-----END ${label}-----`;
  }
  let base64OfSomethingElse = false;
  if (!text.includes("-----BEGIN") && /^[A-Za-z0-9+/=\n]+$/.test(text)) {
    const decoded = Buffer.from(text, "base64").toString("utf8").replace(/\r\n?/g, "\n").trim();
    if (decoded.includes("-----BEGIN")) text = decoded;
    else base64OfSomethingElse = true;
  }
  // The `\1` is the point: a BEGIN whose END does not match it is a truncated
  // paste, and notarytool reports that as the same three words as everything
  // else.
  if (!/^-----BEGIN ([A-Z ]*)PRIVATE KEY-----\n[\s\S]+\n-----END \1PRIVATE KEY-----$/.test(text)) {
    const lines = text.split("\n").length;
    const sawBegin = text.startsWith("-----BEGIN");
    throw new Error(
      `ASC_API_KEY_P8 is not a PEM private key — ${lines} line(s), ${text.length} characters, and ` +
        `${sawBegin ? "no -----END line that matches its -----BEGIN" : "no -----BEGIN line at all"}. ` +
        "It should be the contents of the AuthKey_XXXXXXXXXX.p8 file Apple issued, newlines and all — " +
        "around 250 characters over three or four lines. A single line with matching " +
        "-----BEGIN/-----END markers and a base64 body in between is repaired automatically " +
        "(what a single-line field in a secret store does to a multi-line paste) — this value " +
        "is not that either." +
        // The one guess worth making, because it is the mistake the two secrets
        // invite: CSC_LINK is base64 and this one is not, and a value that is
        // base64 of something binary is almost certainly the certificate.
        (base64OfSomethingElse
          ? " What is there is base64 that decodes to something that is not a PEM at all, which is what a base64-encoded .p12 certificate looks like — that value belongs in CSC_LINK, not here."
          : ""),
    );
  }
  // notarytool reads a file, and a PEM's last line ends.
  return `${text}\n`;
}

/**
 * All three, or the build is not being asked to notarise.
 *
 * A key that is present and unusable is not the same as no key: it throws,
 * because the build was asked to notarise and cannot.
 */
function credentials(env) {
  const key = env.ASC_API_KEY_P8;
  const keyId = env.ASC_KEY_ID;
  const issuerId = env.ASC_ISSUER_ID;
  if (!key || !keyId || !issuerId) return null;
  return { key: privateKey(key), keyId: keyId.trim(), issuerId: issuerId.trim() };
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const asc = credentials(process.env);
  if (asc === null) {
    console.log(
      "[notarize] skipped — ASC_API_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID are not all set.\n" +
        "[notarize] This build is NOT notarised: Gatekeeper will refuse it on another Mac,\n" +
        "[notarize] and macOS will not grant it the microphone or system audio.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);

  // The key is a secret in an environment variable and `notarytool` wants a
  // file. It is written 0600 into a private temp directory and removed in a
  // `finally`, so a failed notarisation does not leave a signing key on a
  // runner's disk.
  const directory = mkdtempSync(join(tmpdir(), "context-asc-"));
  const keyPath = join(directory, "AuthKey.p8");
  try {
    writeFileSync(keyPath, asc.key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    console.log(`[notarize] submitting ${appName}.app to Apple — this takes a few minutes.`);
    await notarize({
      tool: "notarytool",
      appPath,
      appleApiKey: keyPath,
      appleApiKeyId: asc.keyId,
      appleApiIssuer: asc.issuerId,
    });
    console.log("[notarize] done — the app is notarised and stapled.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

// Exported for the suite: the decision this file makes is "all three, or
// nothing", and that is the half worth checking without a Mac.
exports.credentials = credentials;
exports.privateKey = privateKey;

/**
 * `node build/notarize.cjs --check` — the same three values, judged before a
 * build rather than after it.
 *
 * The workflow runs this next to the certificate preflight, and for the same
 * reason: without it, a damaged key is discovered by Apple's own tool after
 * electron-builder has downloaded Electron, packaged an app and signed it, and
 * the answer it gives back is three words. The key never leaves this process —
 * not to a log, not to a file, not to `GITHUB_ENV`.
 */
if (require.main === module) {
  // TEMPORARY diagnostic, never merged: structural facts only — lengths,
  // booleans, counts, and the two standard PEM label strings (not secret;
  // "PRIVATE KEY" / "EC PRIVATE KEY" are fixed vocabulary, never the key
  // material) — to find out which exact shape a live secret is in without
  // ever reading or printing the base64 body itself.
  if (process.env.ASC_API_KEY_P8) {
    const raw = process.env.ASC_API_KEY_P8;
    const normalized = raw.replace(/\r\n?/g, "\n").trim();
    console.log(
      `[diagnose] rawLength=${raw.length} normalizedLength=${normalized.length} lines=${normalized.split("\n").length}`,
    );
    console.log(
      `[diagnose] startsWithBEGIN=${normalized.startsWith("-----BEGIN")} endsWithDashes=${normalized.endsWith("-----")}`,
    );
    console.log(
      `[diagnose] includesLiteralBackslashN=${raw.includes("\\n")} includesCR=${raw.includes("\r")} ` +
        `includesTab=${raw.includes("\t")} includesQuote=${raw.includes('"') || raw.includes("'")}`,
    );
    const beginMatch = /^-----BEGIN ([A-Z ]+)-----/.exec(normalized);
    const endMatch = /-----END ([A-Z ]+)-----$/.exec(normalized);
    console.log(
      `[diagnose] beginLabel=${beginMatch ? JSON.stringify(beginMatch[1]) : "none"} ` +
        `endLabel=${endMatch ? JSON.stringify(endMatch[1]) : "none"} labelsMatch=${
          beginMatch && endMatch ? beginMatch[1] === endMatch[1] : "n/a"
        }`,
    );
    if (beginMatch && endMatch && normalized.length > beginMatch[0].length + endMatch[0].length) {
      const middle = normalized.slice(beginMatch[0].length, normalized.length - endMatch[0].length);
      const whitespaceCount = (middle.match(/\s/g) ?? []).length;
      const nonBase64NonWsCount = (middle.match(/[^A-Za-z0-9+/=\s]/g) ?? []).length;
      console.log(
        `[diagnose] middleLength=${middle.length} whitespaceCount=${whitespaceCount} ` +
          `nonBase64NonWhitespaceCount=${nonBase64NonWsCount} ` +
          `middleStartsWithDash=${middle.startsWith("-")} middleEndsWithDash=${middle.endsWith("-")}`,
      );
    }
  }
  try {
    const asc = credentials(process.env);
    if (asc === null) {
      console.log("[notarize] ASC_API_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID are not all set — this build will NOT be notarised.");
    } else {
      console.log(`[notarize] the App Store Connect key parses as a PEM private key (${asc.key.trim().split("\n").length} lines), with a key id and an issuer id.`);
    }
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
