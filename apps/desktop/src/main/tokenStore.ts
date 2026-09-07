/**
 * The keychain, behind the `TokenStore` interface `core/` was written against.
 *
 * Electron's `safeStorage` encrypts with a key the OS holds — the login
 * keychain on macOS, DPAPI on Windows, libsecret where there is a keyring on
 * Linux. What it hands back is ciphertext, which still has to be put somewhere,
 * and where that is and what the rules around it are live in
 * `core/sync/encryptedFileStore.ts`: refuse to store rather than fall back to
 * plaintext, create the file 0600 at open time, write atomically, log nothing.
 *
 * This file is what is left once those rules are somewhere the suite can reach
 * — the name of the keychain, and nothing else. That split is the point.
 * CLAUDE.md names credential storage as code that gets a test proving the
 * attack fails, and every one of those rules used to sit behind a top-level
 * `import { safeStorage } from "electron"` that no suite on plain Node could
 * load. `test/tokenStore.test.mjs` drives them all with a fake keychain now;
 * what stays here is the one line that genuinely needs Electron.
 */

import { safeStorage } from "electron";
import { encryptedFileStore } from "../core/sync/encryptedFileStore.ts";
import type { TokenStore } from "../core/sync/tokenStore.ts";

/**
 * The store this app runs on.
 *
 * @param userDataDir `app.getPath("userData")`.
 */
export function keychainTokenStore(userDataDir: string): TokenStore {
  return encryptedFileStore(userDataDir, safeStorage);
}
