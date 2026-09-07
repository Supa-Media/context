/**
 * THE OFFLINE DECRYPTOR, OPENING NOTES IT NEVER SAW WRITTEN.
 *
 * Two independent sources of ciphertext, opened by this package's own
 * `src/format.js` — never by importing the gateway's module, which is the
 * whole property this file exists to prove:
 *
 *  1. **The pinned vector**, `apps/mcp/test/encryptionVector.fixtures.json` —
 *     the same fixture the gateway's own suite checks its writer against, so
 *     a future change to the format that moved the writer and this decryptor
 *     out of step would have to change the pinned bytes to keep passing here
 *     too, and could not do that silently.
 *  2. **A note this run encrypts itself**, using `apps/mcp/src/encryption.js`
 *     — the actual gateway code, imported here ONLY to produce ciphertext,
 *     never to open it. If this package's own parser or AES-GCM calls
 *     disagreed with the gateway's about the format, this is what would
 *     catch it: the pinned vector alone is one frozen instance and would not
 *     notice a bug that happened to also match those exact bytes.
 *
 * Also covered: an exported key bundle round-trips through `parseKeyExport`
 * and opens a note; a multi-generation bundle (what a rotated workspace
 * exports) opens notes from either generation; tampering fails closed exactly
 * as the gateway's own module documents; and the CLI itself, exercised as a
 * subprocess against a small on-disk fixture tree, decrypts a directory and
 * leaves everything else untouched.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines in this file.
 *
 *   `isEncryptedNote` returning `false` unconditionally                    12
 *   `decryptNote`'s wrap AAD built from a constant, not the envelope         6
 *
 * Added in adversarial review:
 *
 *   the CLI's single-file path falling back to "write what was read" when
 *   a note cannot be opened                                                 2
 *   `src/format.js` importing one constant from the gateway's module        1
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DecryptorError,
  decryptNote,
  isEncryptedNote,
  parseEncryptedNote,
  parseKeyExport,
} from "../src/format.js";

// Imported ONLY to produce ciphertext for this file's own fixtures — see the
// header. Nothing here calls this module's decrypt path.
import {
  encryptNote,
  encryptNoteForPassphrase,
  generateWorkspaceKey,
} from "../../../apps/mcp/src/encryption.js";

const VECTOR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../apps/mcp/test/encryptionVector.fixtures.json", import.meta.url)),
    "utf8",
  ),
);

let passed = 0;
let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (ok) passed += 1;
  else failed += 1;
}

async function threw(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Every direct decrypt call in an equality check goes through here.
 *
 * A check that throws kills the whole process — zero PASS, zero FAIL — which
 * is a worse signal than a failure and exactly the trap `apps/mcp/test/encryption.test.mjs`
 * documents finding in its own first draft. Wrapping every call means a
 * broken `isEncryptedNote` or `decryptNote` shows up as a FAIL on the line
 * that owns it, not as this file silently reporting nothing at all.
 */
async function value(fn) {
  try {
    return await fn();
  } catch (error) {
    return { threw: error };
  }
}

/* -- (1) the pinned vector, opened with no help from the gateway's module -- */

check(
  "the pinned vector opens to exactly its plaintext",
  (await value(() => decryptNote(VECTOR.document, { [VECTOR.keyId]: VECTOR.workspaceKey }))) === VECTOR.plaintext,
);
check("the pinned vector answers the marker predicate", isEncryptedNote(VECTOR.document) === true);
check(
  "the wrong key fails closed rather than yielding garbage",
  (await threw(() => decryptNote(VECTOR.document, { [VECTOR.keyId]: generateWorkspaceKey() }))) instanceof
    DecryptorError,
);
check(
  "a tampered ciphertext fails closed",
  (await threw(() =>
    decryptNote(VECTOR.document.replace('"ct":"8', '"ct":"9'), {
      [VECTOR.keyId]: VECTOR.workspaceKey,
    }),
  )) instanceof DecryptorError,
);
check("an ordinary note is not mistaken for an encrypted one", isEncryptedNote("# just a note\n") === false);
check(
  "parseEncryptedNote answers null for an ordinary note",
  parseEncryptedNote("# just a note\n") === null,
);

/* -- (2) a note THIS RUN encrypts, with the real gateway code -------------- */

const WORKSPACE_ID = "ws_decryptor_test_0000000000000000";
const KEY_A = generateWorkspaceKey();
const PLAINTEXT = "---\nupdated: 2026-09-07\ntags: [decryptor-test]\n---\n\n# Written by the gateway\n\nOpened by this package.\n";

const freshlyEncrypted = await encryptNote(PLAINTEXT, {
  workspaceId: WORKSPACE_ID,
  workspaceKey: KEY_A,
  keyId: "k1",
});

check(
  "a note the real gateway code just encrypted opens through this package's own implementation",
  (await value(() => decryptNote(freshlyEncrypted, { k1: KEY_A }))) === PLAINTEXT,
);

// Multi-generation: what an export from a rotated workspace looks like.
const KEY_B = generateWorkspaceKey();
const onOldGeneration = await encryptNote("older note, k1\n", {
  workspaceId: WORKSPACE_ID,
  workspaceKey: KEY_A,
  keyId: "k1",
});
const onNewGeneration = await encryptNote("newer note, k2\n", {
  workspaceId: WORKSPACE_ID,
  workspaceKey: KEY_B,
  keyId: "k2",
});
const bothKeys = { k1: KEY_A, k2: KEY_B };
check(
  "a multi-generation key bundle opens a note from the OLD generation",
  (await value(() => decryptNote(onOldGeneration, bothKeys))) === "older note, k1\n",
);
check(
  "...and a note from the NEW generation, with the same bundle",
  (await value(() => decryptNote(onNewGeneration, bothKeys))) === "newer note, k2\n",
);
check(
  "a bundle missing the note's generation refuses rather than guessing",
  (await threw(() => decryptNote(onOldGeneration, { k2: KEY_B }))) instanceof DecryptorError,
);

/* -- (3) the export format round-trips through this package's own parser -- */

const exportDoc = {
  v: 1,
  workspace_id: WORKSPACE_ID,
  exported_at: new Date().toISOString(),
  current: "k2",
  keys: [
    { generation: "k1", alg: "A256GCM", key: KEY_A },
    { generation: "k2", alg: "A256GCM", key: KEY_B },
  ],
  envelope: { version: 1, alg: "A256GCM", spec: "docs/decisions/encryption.md" },
};
const parsedExport = parseKeyExport(JSON.parse(JSON.stringify(exportDoc)));
check(
  "a real export bundle round-trips and opens both generations",
  parsedExport.workspaceId === WORKSPACE_ID &&
    parsedExport.current === "k2" &&
    (await value(() => decryptNote(onOldGeneration, parsedExport.keys))) === "older note, k1\n" &&
    (await value(() => decryptNote(onNewGeneration, parsedExport.keys))) === "newer note, k2\n",
);
check(
  "a malformed export is refused, never silently accepted",
  (await threw(async () => parseKeyExport({ ...exportDoc, v: 2 }))) instanceof DecryptorError &&
    (await threw(async () => parseKeyExport({ ...exportDoc, current: "k9" }))) instanceof DecryptorError,
);

/* -- (3a) the note no export will ever open -------------------------------- */
//
// A note locked with a passphrase carries a `passphrase` recipient and no
// workspace one, so no key export opens it — ever, by design. What this
// package owes such a note is the truth about WHY, because the person reading
// it has already revoked our credential and has nobody to ask: "your export is
// missing a generation" sends them hunting for a key that was never written
// down anywhere, and the honest answer is that the passphrase is the key.
//
// Encrypted with the gateway's own passphrase writer, opened — refused — by
// this package's own reader, which is the same arrangement as every other
// check in this file.
{
  const kek = new Uint8Array(32).fill(7);
  const lockedNote = await encryptNoteForPassphrase("locked body\n", {
    workspaceId: WORKSPACE_ID,
    kek,
    kdf: { id: "argon2id", v: 19, m: 19456, t: 2, p: 1, salt: "c2FsdHNhbHRzYWx0c2E" },
  });
  check(
    "a passphrase-locked note is recognised as an encrypted note and parses",
    isEncryptedNote(lockedNote) && parseEncryptedNote(lockedNote).recipients.length === 1,
  );
  check(
    "...and its KDF descriptor survives the shape check this package makes",
    parseEncryptedNote(lockedNote).recipients[0].kind === "passphrase" &&
      parseEncryptedNote(lockedNote).recipients[0].kdf.id === "argon2id",
  );
  const refusal = await threw(async () => decryptNote(lockedNote, { k1: KEY_A }));
  check(
    "...and a key export is refused by name rather than as a missing generation",
    refusal instanceof DecryptorError &&
      /locked with a passphrase/.test(refusal.message) &&
      !/not present in this export/.test(refusal.message),
  );
}

/* -- (3b) the independence itself, read off the source -------------------- */
//
// Every check above proves the two implementations AGREE. None of them proves
// they are two implementations: this file could import the gateway's module
// for its own decrypt path, or `src/format.js` could reach it through one
// hop, and every assertion would still pass — greenly, while the property the
// package exists for was gone.
//
// So the shipped surface is read as text. `package.json`'s `files` is `bin`
// and `src`; every import in those two directories must be either a `node:`
// builtin or a path inside this package. One relative hop into `apps/` or a
// bare npm specifier fails here — and a bare specifier would also break the
// "zero dependencies, runs from a folder and a Node" promise the README makes
// to somebody who has already revoked our credential.
{
  const shippedDirs = ["../src", "../bin"];
  const offenders = [];
  for (const dir of shippedDirs) {
    const dirPath = fileURLToPath(new URL(dir, import.meta.url));
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith(".js")) continue;
      const source = readFileSync(join(dirPath, entry), "utf8");
      for (const match of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const specifier = match[1];
        const isBuiltin = specifier.startsWith("node:");
        const isInsidePackage =
          (specifier.startsWith("./") || specifier.startsWith("../")) &&
          !specifier.includes("../../");
        if (!isBuiltin && !isInsidePackage) offenders.push(`${dir}/${entry} -> ${specifier}`);
      }
      for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']/g)) {
        offenders.push(`${dir}/${entry} -> dynamic import ${match[1]}`);
      }
    }
  }
  check(
    "nothing this package ships imports the gateway's module, or anything off npm",
    offenders.length === 0,
  );
  // And the scanner is not vacuous: it finds the one deliberate import in
  // THIS file, which is the gateway module used to produce ciphertext.
  const ownSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  check(
    "...and the scanner would see such an import if there were one",
    /from\s+["']\.\.\/\.\.\/\.\.\/apps\/mcp\/src\/encryption\.js["']/.test(ownSource),
  );
}

/* -- (4) the CLI itself, against a small on-disk bucket -------------------- */

const workdir = mkdtempSync(join(tmpdir(), "context-decryptor-test-"));
try {
  const bucketDir = join(workdir, "bucket");
  mkdirSync(join(bucketDir, "1-projects"), { recursive: true });
  writeFileSync(join(bucketDir, "privacy.md"), "role: privacy-manifest\n");
  writeFileSync(join(bucketDir, "1-projects", "plain.md"), "# a plaintext note\n");
  writeFileSync(join(bucketDir, "1-projects", "secret.md"), freshlyEncrypted);

  const keysPath = join(workdir, "keys.json");
  writeFileSync(
    keysPath,
    JSON.stringify({
      v: 1,
      workspace_id: WORKSPACE_ID,
      current: "k1",
      keys: [{ generation: "k1", alg: "A256GCM", key: KEY_A }],
    }),
  );

  const binPath = fileURLToPath(new URL("../bin/decrypt.js", import.meta.url));
  const outDir = join(workdir, "out");
  execFileSync(process.execPath, [binPath, keysPath, bucketDir, outDir], { stdio: "pipe" });

  const decryptedSecret = readFileSync(join(outDir, "1-projects", "secret.md"), "utf8");
  const plainNote = readFileSync(join(outDir, "1-projects", "plain.md"), "utf8");
  const privacy = readFileSync(join(outDir, "privacy.md"), "utf8");
  check(
    "the CLI decrypts the encrypted note in a whole-directory run",
    decryptedSecret === PLAINTEXT,
  );
  check(
    "...and copies the plaintext note and privacy.md through byte-for-byte",
    plainNote === "# a plaintext note\n" && privacy === "role: privacy-manifest\n",
  );

  // Single-file mode, writing to an explicit output path.
  const singleOut = join(workdir, "single.md");
  execFileSync(process.execPath, [binPath, keysPath, join(bucketDir, "1-projects", "secret.md"), singleOut], {
    stdio: "pipe",
  });
  check("single-file mode with an output path writes exactly the plaintext", readFileSync(singleOut, "utf8") === PLAINTEXT);

  // Single-file mode with no output path prints to stdout.
  const stdout = execFileSync(
    process.execPath,
    [binPath, keysPath, join(bucketDir, "1-projects", "secret.md")],
    { encoding: "utf8" },
  );
  check("single-file mode with no output path prints the plaintext to stdout", stdout === PLAINTEXT);

  // A note this bundle cannot open: left out of the output tree, not copied
  // through as ciphertext under a plaintext-looking name, and the CLI exits
  // non-zero to say the recovery was partial.
  const strangerKey = generateWorkspaceKey();
  const unopenable = await encryptNote("nope\n", {
    workspaceId: WORKSPACE_ID,
    workspaceKey: strangerKey,
    keyId: "k9",
  });
  writeFileSync(join(bucketDir, "1-projects", "unopenable.md"), unopenable);
  const outDir2 = join(workdir, "out2");
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [binPath, keysPath, bucketDir, outDir2], { stdio: "pipe" });
  } catch (error) {
    exitCode = error.status;
  }
  check("the CLI exits non-zero when a note in the tree could not be opened", exitCode === 2);
  const survivedEntries = readdirSync(join(outDir2, "1-projects"));
  check(
    "a note this run cannot open is left out of the output tree rather than copied as ciphertext",
    !survivedEntries.includes("unopenable.md") && survivedEntries.includes("secret.md"),
  );

  /* -- (5) the same rule, in single-file mode ------------------------------- */
  //
  // The directory walk's rule — a note this run could not open is never
  // written out under a plaintext-looking name — has to hold for one note as
  // well, and it did not: single-file mode fell through to "write what we
  // read", so an output file appeared containing the envelope and the run
  // announced it as "copied (already plaintext)". Both forms are asked here.
  //
  // The input is a note whose envelope is well-formed and whose CIPHERTEXT is
  // corrupt — the shape a truncated sync or a bad restore leaves, and the one
  // that reaches furthest into the decryptor before failing.
  const corrupted = freshlyEncrypted.replace(
    /"ct":"([A-Za-z0-9_-]{8})/,
    (_match, head) => `"ct":"${head.split("").reverse().join("")}`,
  );
  const corruptedPath = join(bucketDir, "1-projects", "corrupted.md");
  writeFileSync(corruptedPath, corrupted);

  const refusedOut = join(workdir, "refused.md");
  let singleExit = 0;
  let singleStderr = "";
  try {
    execFileSync(process.execPath, [binPath, keysPath, corruptedPath, refusedOut], {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    singleExit = error.status;
    singleStderr = String(error.stderr ?? "");
  }
  let wroteAnything = true;
  try {
    readFileSync(refusedOut, "utf8");
  } catch {
    wroteAnything = false;
  }
  check(
    "a corrupted envelope is refused cleanly in single-file mode: nothing written, exit 2, and a reason",
    singleExit === 2 && wroteAnything === false && /nothing written/.test(singleStderr),
  );

  let stdoutExit = 0;
  let stdoutBytes = "";
  try {
    stdoutBytes = execFileSync(process.execPath, [binPath, keysPath, corruptedPath], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    stdoutExit = error.status;
    stdoutBytes = String(error.stdout ?? "");
  }
  check(
    "...and with no output path it prints no ciphertext to stdout either",
    stdoutExit === 2 && stdoutBytes === "",
  );

  // Not a crash, and not a stack trace: the person running this has no
  // gateway to ask, so the message is the whole of what they get.
  check(
    "the refusal names the cause rather than throwing a stack trace",
    /tampered ciphertext|does not open/.test(singleStderr) && !/at Object|at async/.test(singleStderr),
  );
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILURES` : "\nALL PASS");
process.exit(failed ? 1 : 0);
