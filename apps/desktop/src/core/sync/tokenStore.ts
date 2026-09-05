/**
 * Where the gateway credential lives, which is nowhere this app can leak it.
 *
 * The repository's first non-negotiable: credentials never live in Markdown, in
 * the bucket, in logs, in URLs, or on a device. "On a device" is this file's
 * problem — a desktop app has to hold *something* to authenticate, so the rule
 * becomes: the OS keychain holds it, encrypted by the OS, and nothing else on
 * this machine ever sees it in plaintext at rest.
 *
 * Two consequences that are enforced here rather than remembered:
 *
 *  - **The token is never returned to the renderer.** `preload` exposes no
 *    channel that reads it. The renderer asks the main process to post; the
 *    main process attaches the header. A token in a renderer is a token in a
 *    web page, and this app loads its own HTML but the rule is not worth
 *    depending on that.
 *  - **The token is never part of a URL.** The contract's routes are paths; the
 *    credential is a header. `token-in-URL is a compatibility fallback and never
 *    the security boundary` applies to the gateway; a fresh client has no reason
 *    to use the fallback at all.
 */

export interface TokenStore {
  /** The bearer token, or null when this machine is not connected. */
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  /** Disconnect. Must leave nothing behind that a later read could find. */
  clear(): Promise<void>;
  /**
   * False when the OS refused to give us encrypted storage — a Linux session
   * with no keyring, most often. The app then refuses to store a token at all
   * rather than falling back to a file, and says so.
   */
  readonly encrypted: boolean;
}

/** In-memory, for the suite and for `--dev`. Never persisted. */
export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return {
    encrypted: false,
    async read() {
      return token;
    },
    async write(next) {
      token = next;
    },
    async clear() {
      token = null;
    },
  };
}
