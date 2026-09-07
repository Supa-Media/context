/**
 * The keychain, behind the `TokenStore` interface `core/` was written against.
 *
 * Electron's `safeStorage` encrypts with a key the OS holds — the login
 * keychain on macOS, DPAPI on Windows, libsecret where there is a keyring on
 * Linux. What it hands back is ciphertext, which still has to be put somewhere,
 * so the ciphertext lives in one file in the app's own `userData` directory.
 *
 * Three properties, and each is the reason a line is the way it is.
 *
 * **A machine that cannot encrypt does not get a plaintext fallback.** On a
 * Linux session with no keyring, `isEncryptionAvailable()` is false, and the
 * honest answer is to hold the credential in memory for this launch and say so
 * — `encrypted` is on the interface for exactly this, and the app reports it.
 * Writing a bearer token to a file in plaintext to be helpful is how "credentials
 * never live on a device" becomes a sentence in a README that the code does not
 * keep.
 *
 * **The file is created 0600, at open time.** `writeFile` then `chmod` leaves a
 * window in which somebody else's account can read it, and on a shared machine
 * that window is the whole attack. Same construction as `packages/hook`'s
 * config, for the same reason — and the write is atomic (temp file, rename), so
 * a laptop lid closing mid-write cannot leave a half-credential that the next
 * launch cannot parse and cannot recover from.
 *
 * **Nothing here logs.** Not the token, not the ciphertext, not the path
 * contents. A failed read answers `null`, which the app already handles as "not
 * connected".
 */

import { safeStorage } from "electron";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TokenStore } from "../core/sync/tokenStore.ts";

const FILE_MODE = 0o600;
const FILE_NAME = "connection.enc";

/**
 * The store this app runs on.
 *
 * @param userDataDir `app.getPath("userData")`. Passed in rather than read here
 *   so this module has one Electron import and the suite could drive it with a
 *   temporary directory if it ever grows a check that is not about the keychain
 *   itself.
 */
export function keychainTokenStore(userDataDir: string): TokenStore {
  const path = join(userDataDir, FILE_NAME);
  const encrypted = safeStorage.isEncryptionAvailable();
  /** The in-memory fallback for a machine with no keyring. Never written down. */
  let inMemory: string | null = null;

  return {
    encrypted,

    async read(): Promise<string | null> {
      if (!encrypted) return inMemory;
      let ciphertext: Buffer;
      try {
        ciphertext = await readFile(path);
      } catch {
        // Missing is the ordinary first run. Unreadable is a broken install,
        // and both mean the same thing to the app: connect this machine.
        return null;
      }
      try {
        const value = safeStorage.decryptString(ciphertext);
        return value === "" ? null : value;
      } catch {
        // Written by another user account, another machine, or a keychain that
        // has since been reset. Not recoverable and not worth a crash.
        return null;
      }
    },

    async write(value: string): Promise<void> {
      if (!encrypted) {
        inMemory = value;
        return;
      }
      const ciphertext = safeStorage.encryptString(value);
      const temporary = join(dirname(path), `.connection.${process.pid}.${Date.now()}.tmp`);
      const handle = await open(temporary, "wx", FILE_MODE);
      try {
        await handle.writeFile(ciphertext);
        await handle.sync().catch(() => {});
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      // The rename carries the temp file's own 0600; this only matters when an
      // older build left a laxer file behind.
      await chmod(path, FILE_MODE).catch(() => {});
    },

    async clear(): Promise<void> {
      inMemory = null;
      await unlink(path).catch(() => {});
    },
  };
}
