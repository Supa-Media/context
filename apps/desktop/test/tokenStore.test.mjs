/**
 * The credential at rest — the one file on this machine worth stealing.
 *
 * CLAUDE.md's first non-negotiable ends "…never on a device: encrypted at rest",
 * and `core/sync/tokenStore.ts` spells out what that means for a desktop app:
 * the OS keychain holds it, and a machine with no keyring gets **no plaintext
 * fallback**. Every one of those rules used to live behind a top-level
 * `import { safeStorage } from "electron"`, so none of them had a check — the
 * rules were prose in a header, which is exactly what `docs/decisions/testing.md`
 * says a guard is not.
 *
 * The keychain is a fake here (two calls: is there one, and encrypt/decrypt);
 * everything else — the file, its mode, the atomic rename, the recovery from a
 * damaged one — is real, in a real temporary directory.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   the no-keyring branch writing the token to the file in plaintext           2
 *   `FILE_MODE` relaxed from 0600 to 0644                                      1
 *   a `decryptString` that throws allowed to propagate instead of answering    1
 *   `clear()` leaving the file behind                                          3
 *
 * And one that fails **nothing**, recorded because a reader will otherwise
 * assume it is covered: replacing the temp-file-and-rename with a plain
 * `writeFile` still ends at mode 0600, because the trailing `chmod` runs either
 * way. What that construction buys is the *window* between a file existing and
 * its mode being set — a race a single-threaded suite in a private temporary
 * directory cannot observe at all. The check below pins the mode; the atomicity
 * and the create-time mode are argued in `core/sync/encryptedFileStore.ts` and
 * are not claimed here as tested.
 */

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedFileStore } from "../src/core/sync/encryptedFileStore.ts";

const TOKEN = "fake-refresh-token-not-a-real-one";

/**
 * A keychain, as the two calls this app makes of it.
 *
 * "Encryption" is base64 behind a marker — reversible, obviously not real, and
 * chosen for the one property the checks below need: the plaintext token is not
 * a substring of the ciphertext, so "the token is not on disk" is a check and
 * not a coincidence.
 */
const MARKER = "sealed:";

function seal(value) {
  return Buffer.from(MARKER + Buffer.from(value, "utf8").toString("base64"), "utf8");
}

function fakeKeychain({ available = true, decrypt } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: seal,
    decryptString:
      decrypt ??
      ((buffer) => {
        const text = buffer.toString("utf8");
        if (!text.startsWith(MARKER)) throw new Error("this ciphertext is not ours");
        return Buffer.from(text.slice(MARKER.length), "base64").toString("utf8");
      }),
  };
}

async function contents(directory) {
  return (await readdir(directory)).sort();
}

/**
 * A read that answers rather than throwing, reported as a value.
 *
 * `apps/desktop/README.md` records that three sabotages once *crashed* this
 * suite instead of failing it — zero FAIL lines, which reads like coverage if
 * you count failures. "A damaged file must not crash the launch" is exactly the
 * check that would do it, so it is written so that a throw is a FAIL.
 */
async function answered(store) {
  try {
    return await store.read();
  } catch (error) {
    return `THREW: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function runTokenStoreChecks(check) {
  const directory = await mkdtemp(join(tmpdir(), "context-desktop-"));
  const file = join(directory, "connection.enc");

  try {
    // -- the ordinary machine ------------------------------------------------
    const store = encryptedFileStore(directory, fakeKeychain());
    check("a machine with a keychain says its credential is encrypted", store.encrypted === true);
    check("nothing is on disk before anything is stored", (await contents(directory)).length === 0);
    check("...and reading finds nothing rather than throwing", (await answered(store)) === null);

    await store.write(TOKEN);
    check("the credential reads back", (await store.read()) === TOKEN);
    check("exactly one file exists — the temp file was renamed, not left", (await contents(directory)).length === 1);

    const onDisk = await import("node:fs/promises").then((fs) => fs.readFile(file));
    check("THE PLAINTEXT TOKEN IS NOT ON DISK", !onDisk.toString("utf8").includes(TOKEN));
    check("...what is on disk is exactly what the keychain handed back", onDisk.equals(seal(TOKEN)));

    const mode = (await stat(file)).mode & 0o777;
    check("THE FILE IS 0600 — nobody else's account on this machine can read it", mode === 0o600);

    await store.write("a-second-fake-token");
    check("a second write replaces the first", (await store.read()) === "a-second-fake-token");
    check("...and still leaves one file", (await contents(directory)).length === 1);

    await store.clear();
    check("DISCONNECTING LEAVES NOTHING A LATER READ COULD FIND", (await store.read()) === null);
    check("...the file itself is gone, not emptied", (await contents(directory)).length === 0);
    await store.clear();
    check("...and clearing again is not an error", (await store.read()) === null);

    // -- the damaged file ----------------------------------------------------
    await writeFile(file, "this is not ciphertext this keychain wrote", { mode: 0o600 });
    const damaged = encryptedFileStore(directory, fakeKeychain());
    check("A FILE THIS KEYCHAIN CANNOT OPEN READS AS 'NOT CONNECTED', NOT AS A CRASH", (await answered(damaged)) === null);

    const empty = encryptedFileStore(directory, fakeKeychain({ decrypt: () => "" }));
    check("...and a file that decrypts to nothing is not a connection either", (await answered(empty)) === null);

    await rm(file, { force: true });

    // -- the machine with no keyring ----------------------------------------
    const unencrypted = encryptedFileStore(directory, fakeKeychain({ available: false }));
    check("a machine with no keyring says so, rather than pretending", unencrypted.encrypted === false);
    await unencrypted.write(TOKEN);
    check(
      "NO KEYRING MEANS NO FILE AT ALL — a bearer token is never written in the clear",
      (await contents(directory)).length === 0,
    );
    check("...it is held for this launch only", (await unencrypted.read()) === TOKEN);
    const relaunched = encryptedFileStore(directory, fakeKeychain({ available: false }));
    check("...and a relaunch has to be reconnected", (await relaunched.read()) === null);
    await unencrypted.clear();
    check("...clearing forgets it", (await unencrypted.read()) === null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
