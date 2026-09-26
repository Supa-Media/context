/**
 * One usable access token, and the lock that keeps there being only one
 * refresh at a time.
 *
 * Split out of `commands.js` when it crossed the review threshold: every
 * command needs a token, and none of them needs to know how the rotation is
 * kept honest. Nothing here loads a third-party dependency — the hooks run
 * through it, and `installer.test.mjs` asserts that path stays clean.
 */

import { open, readFile, stat, unlink as unlinkFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { discover, refreshTokens } from "./oauth.js";
import { endpointKey, loadEndpoint, saveEndpoint } from "./config.js";

/**
 * A lock older than this is treated as abandoned and taken over, and the work
 * inside one is given less than that to finish. The order between them is the
 * whole guarantee — a deadline above the staleness window would let one
 * process still be refreshing while the next has already taken the lock, and
 * two processes spending one rotating refresh token is what the gateway
 * answers by revoking the grant. `hooks.test.mjs` asserts the inequality
 * rather than trusting these two numbers to be edited together.
 */
export const LOCK_STALE_MS = 30_000;
export const REFRESH_DEADLINE_MS = 10_000;

/**
 * A usable access token, refreshing if the stored one is spent.
 *
 * The refreshed pair is written back before it is used, because a rotating
 * refresh token that is spent and not persisted leaves the install permanently
 * unable to authenticate — and the failure surfaces at the end of some future
 * session, where nobody is looking.
 */
export async function accessTokenFor({
  endpoint,
  configPath,
  fetchImpl = fetch,
  timeoutMs = REFRESH_DEADLINE_MS,
}) {
  const record = await loadEndpoint(endpoint, configPath);
  if (!record?.refreshToken && !record?.accessToken) {
    throw new Error(`not signed in for ${endpointKey(endpoint)} — run: npx -y @supa-media/context login`);
  }
  if (record.accessToken && Number(record.expiresAt) > Date.now()) return record.accessToken;
  if (!record.refreshToken) {
    throw new Error("the stored session has expired — run: npx -y @supa-media/context install");
  }

  // One refresh at a time per credentials file. Refresh tokens rotate and the
  // gateway treats a spent one as a replay, so two hooks refreshing together
  // (two sessions closing at once) would lose the sign-in. Whoever waits
  // re-reads the file and uses the token the other one stored.
  //
  // The work inside is on a deadline, and the deadline is the reason the lock
  // means anything: a lock older than `LOCK_STALE_MS` is taken over, and four
  // unbounded requests (three for discovery, one for the token) could sit in
  // here far longer than that on a network that has stopped answering. A hook
  // runs as a laptop closes, which is exactly when that happens.
  const release = await acquireLock(`${configPath}.lock`);
  try {
    const current = await loadEndpoint(endpoint, configPath);
    if (current?.accessToken && Number(current.expiresAt) > Date.now()) return current.accessToken;
    if (!current?.refreshToken) {
      throw new Error("the stored session has expired — run: npx -y @supa-media/context login");
    }
    return await withDeadline(timeoutMs, async (signal) => {
      const discovery = await discover(endpoint, { fetchImpl, signal });
      const tokens = await refreshTokens(
        discovery,
        { clientId: current.clientId, refreshToken: current.refreshToken },
        { fetchImpl, signal }
      );
      await saveEndpoint(
        endpoint,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || current.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope || current.scope,
        },
        configPath
      );
      return tokens.accessToken;
    });
  } finally {
    await release();
  }
}

/**
 * Run `work` with a deadline, and tell it to stop when the deadline passes.
 *
 * The signal is what closes a real socket; the race is what frees the lock
 * even when whatever is on the other end ignores it. Both, because only one of
 * them is under this process's control.
 */
async function withDeadline(ms, work) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("the sign-in server did not answer in time; nothing was changed"));
    }, ms);
  });
  const running = work(controller.signal);
  // The deadline may answer first, and an aborted request rejects a moment
  // later with nobody left to hear it. In a hook an unhandled rejection is a
  // crashed process at the end of somebody's session, so it is heard here.
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An exclusive lock file, created with `wx` so only one process wins.
 *
 * A lock older than `staleMs` belonged to a process that died holding it and is
 * taken over rather than waited on forever. **A takeover means two processes
 * now think they hold it**, so the lock carries a tag and a release unlinks it
 * only when the tag is still the one it wrote. Unlinking by path alone meant
 * the process that had already been taken over deleted the new holder's lock
 * on its way out, and a third process could then walk in beside them — which
 * for a rotating refresh token is the replay the lock exists to prevent.
 */
export async function acquireLock(path, { waitMs = 10_000, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      const tag = randomBytes(12).toString("hex");
      await handle.writeFile(tag, "utf8");
      await handle.close();
      return async () => {
        const held = await readFile(path, "utf8").catch(() => null);
        if (held === tag) await unlinkFile(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > staleMs) {
        await unlinkFile(path).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error("another Context process is refreshing the sign-in; try again");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

