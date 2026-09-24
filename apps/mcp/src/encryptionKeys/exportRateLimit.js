/** The rate limit on `export_encryption_keys`. Moved verbatim out of `src/index.js`. */

import { getWithLegacyFallback } from "../storageLayout.js";

/* ------------------------------- key export -------------------------------- */

/** Where a best-effort, per-context export rate limit is tracked. Plumbing: never listed, never a note. */
const EXPORT_RATE_LIMIT_PATH = ".context/encryption-export-rate.json";

/**
 * Exports allowed per context per rolling window. Matches the console's own
 * `authorizeEncryptionExport` in `apps/convex/functions/encryptionKeys.ts` —
 * not because the two limiters share state (they cannot: this one lives in
 * the customer's own bucket, and the console's lives in the control plane's
 * database, because the two surfaces have no other shared state to spend a
 * round trip reaching) but because an owner exporting from either surface
 * should meet the same policy.
 */
export const EXPORT_RATE_LIMIT = { limit: 5, windowMs: 24 * 60 * 60 * 1000 };

/**
 * A best-effort, bucket-side fixed-window rate limit for `export_encryption_keys`.
 *
 * Zero-dependency and Workers-runtime only, like everything else in this file:
 * a small JSON counter at a plumbing path, read, checked, and written back —
 * the same shape `apps/convex/functions/lib/rateLimit.ts` uses, translated to
 * a store that has no database, only `get`/`put`. It is best-effort rather
 * than exact under a genuine race (two requests reading the same counter
 * before either writes back), which is an acceptable gap for a limit
 * defending an *owner's own* repeated access to their *own* key — the harm a
 * tighter limiter would prevent is a compromised session harvesting the key
 * by retrying, not a race with itself.
 *
 * A corrupt or unreadable counter fails **open toward a fresh window**, never
 * toward "block forever": the file this limiter writes is not canonical data,
 * and refusing an owner their own key because a JSON file got corrupted would
 * be a worse failure than under-counting once.
 *
 * @returns {Promise<boolean>} `true` if the caller is over the limit — and, in
 *   that case, nothing is written, so a rate-limited attempt does not itself
 *   consume budget from the window it is refused against.
 */
export async function checkAndConsumeExportRateLimit(store) {
  const now = Date.now();
  let state = { windowStartedAt: now, count: 0 };
  const existing = await getWithLegacyFallback(store, EXPORT_RATE_LIMIT_PATH);
  if (existing) {
    try {
      const parsed = JSON.parse(await existing.text());
      if (
        parsed &&
        typeof parsed.windowStartedAt === "number" &&
        typeof parsed.count === "number"
      ) {
        state = parsed;
      }
    } catch {
      // Corrupt counter: treated as absent, which resets the window. See above.
    }
  }
  if (now - state.windowStartedAt >= EXPORT_RATE_LIMIT.windowMs) {
    state = { windowStartedAt: now, count: 0 };
  }
  if (state.count >= EXPORT_RATE_LIMIT.limit) return true;
  await store.put(EXPORT_RATE_LIMIT_PATH, JSON.stringify({ ...state, count: state.count + 1 }));
  return false;
}
