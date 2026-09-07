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
import { encryptNote, generateWorkspaceKey } from "../../../apps/mcp/src/encryption.js";

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
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILURES` : "\nALL PASS");
process.exit(failed ? 1 : 0);
