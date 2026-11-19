/**
 * Waiting out a GitHub API rate limit instead of failing the run (2026-11-19).
 *
 * On 2026-11-19 the repository's GITHUB_TOKEN installation limit ran out. The
 * cause was the benchmark runner lock's poll (scripts/bench-runner-lock.mjs):
 * 35 calls every 30 seconds for each waiting run. With the limit gone, Promote
 * to Production and CI failed on HTTP 403 and nothing said why. A rate-limited
 * call now waits for the reset and retries, up to the caller's deadline; any
 * other error still fails at once.
 *
 * Dependency-free ESM, shared by the scripts that call the GitHub API.
 */

export const MAX_BACKOFF_MS = 300_000;

/** Exponential backoff for a rate limit that names no reset time: 15 s, 30 s, 60 s ... capped. */
export function backoffMs(attempt) {
  return Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** attempt);
}

function header(headers, name) {
  return typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
}

/**
 * How long to wait before retrying a response, or null when it is not a rate
 * limit. Only error statuses count, so a 200 whose body mentions a rate limit
 * (a note, say) is not mistaken for one.
 */
export function responseWaitMs({ status, headers, body = "", now = Date.now(), attempt = 0 }) {
  if (status < 400) return null;
  const remaining = header(headers, "x-ratelimit-remaining");
  const retryAfter = header(headers, "retry-after");
  const limited =
    status === 429 ||
    (status === 403 && remaining === "0") ||
    (retryAfter != null && retryAfter !== "") ||
    /rate limit/i.test(String(body ?? ""));
  if (!limited) return null;

  if (retryAfter != null && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const reset = Number(header(headers, "x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now + 1000);
  return backoffMs(attempt);
}

/** Whether a `gh` failure (its stderr, or the message of a thrown error) is a rate limit. */
export function isGhRateLimitError(error) {
  return /rate limit|HTTP 429/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
}

/**
 * Runs `fn`, and when it throws a rate-limit error (`waitFor` returns a wait
 * for it) sleeps and tries again. Gives up with the original error once the
 * deadline has passed, and never sleeps past the deadline.
 */
export async function retryOnRateLimit(
  fn,
  { deadline, waitFor, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log },
) {
  for (let attempt = 0; ; ) {
    try {
      return await fn();
    } catch (error) {
      const wait = await waitFor(error, attempt);
      if (wait == null) throw error;
      const left = deadline - now();
      if (left <= 0) throw error;
      const ms = Math.min(Math.max(wait, 1000), left);
      log(`GitHub API rate limit hit; waiting ${Math.ceil(ms / 1000)} s before retrying.`);
      await sleep(ms);
      attempt += 1;
    }
  }
}
