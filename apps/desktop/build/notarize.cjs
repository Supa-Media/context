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

/** All three, or the build is not being asked to notarise. */
function credentials(env) {
  const key = env.ASC_API_KEY_P8;
  const keyId = env.ASC_KEY_ID;
  const issuerId = env.ASC_ISSUER_ID;
  if (!key || !keyId || !issuerId) return null;
  return { key, keyId, issuerId };
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
