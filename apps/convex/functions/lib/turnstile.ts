/**
 * The human check in front of the one write that has no account behind it.
 *
 * ## Why this exists here and nowhere else
 *
 * Every other write in this product resolves a grant or a session to a person
 * with a handle, and the cost of abusing one is an account somebody has to
 * keep. A collect link has neither: it is a URL an owner published so that
 * strangers can answer a form, which is the same shape as a comment box and
 * attracts the same traffic. Without a challenge, the first script that finds
 * one fills a customer's bucket with junk on their quota.
 *
 * ## It fails CLOSED, and that is the production branch rather than scaffolding
 *
 * With no secret configured, `verifyHumanChallenge` returns `not-configured`
 * and the caller **refuses the submission**. That is not a placeholder waiting
 * for the real behaviour — it *is* the right behaviour the day the secret is
 * rotated out, mistyped, or dropped by a rebuilt environment. A route that
 * accepted unverified posts whenever its key went missing would be a route
 * whose defence disappears exactly when somebody is most likely to be probing
 * it.
 *
 * So collect mode ships dark: the code is complete and refuses, and the
 * feature turns on when the owner sets `TURNSTILE_SECRET_KEY` in the Convex
 * environment. No second deploy, no flag, no code change.
 *
 * ## What is sent, and what is not
 *
 * The token the widget produced and the secret. **Not** the workspace, the
 * note, the answers, the link, or anything derived from them: Cloudflare is
 * being asked one question — "was there a human here" — and everything else
 * would be telling a third party about a customer's context to get an answer
 * that does not depend on it. The visitor's IP is deliberately omitted too;
 * it improves scoring and it is the one field that makes this a disclosure
 * about a person rather than about a request.
 *
 * A network failure is `unavailable`, which the caller also refuses on. Taking
 * an unverified answer because Cloudflare had a bad minute is the same hole as
 * taking one because the key was missing.
 */

/** Where Cloudflare verifies a widget token. */
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The env var the secret arrives in. Synced by `deploy-convex.yml`. */
export const TURNSTILE_SECRET_ENV_VAR = "TURNSTILE_SECRET_KEY";

/** How long to wait before treating verification as unavailable. */
const VERIFY_TIMEOUT_MS = 5_000;

export type ChallengeOutcome =
  /** A human, as far as Cloudflare can tell. */
  | "verified"
  /** The token was missing, malformed, replayed, or refused. */
  | "failed"
  /** No secret is set on this deployment. The caller refuses. */
  | "not-configured"
  /** Cloudflare could not be reached, or answered something unreadable. */
  | "unavailable";

/**
 * Whether this deployment can verify a challenge at all.
 *
 * Separate from `verifyHumanChallenge` so a *read* of a collect link can tell
 * the visitor the form is not accepting answers, instead of drawing a form,
 * taking two minutes of their typing and refusing at the end.
 */
export function humanChallengeConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const secret = env[TURNSTILE_SECRET_ENV_VAR];
  return typeof secret === "string" && secret.length > 0;
}

/**
 * Ask Cloudflare whether the token in front of this submission came from a
 * human. Never throws: every failure is an outcome the caller refuses on.
 */
export async function verifyHumanChallenge(
  token: string | undefined,
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ChallengeOutcome> {
  const env = options.env ?? process.env;
  const secret = env[TURNSTILE_SECRET_ENV_VAR];
  if (typeof secret !== "string" || secret.length === 0) return "not-configured";

  // Checked before the round trip. A missing token is the overwhelmingly
  // common shape of an automated post, and it costs Cloudflare nothing to
  // refuse it here.
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return "failed";
  }

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(VERIFY_TIMEOUT_MS)
          : undefined,
    });
  } catch {
    // The error may quote the request, and the request holds the secret. It is
    // dropped rather than wrapped — the same rule the control-plane client
    // follows.
    return "unavailable";
  }

  if (!response.ok) return "unavailable";

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return "unavailable";
  }

  // `success` and nothing else. The response also carries hostname, action and
  // error codes; none of them are read, because each is a second thing that
  // could be wrong and the answer to "was there a human" is one boolean.
  const success = (parsed as { success?: unknown } | null)?.success;
  return success === true ? "verified" : "failed";
}

/** What a visitor is told, per outcome. One sentence, and never why. */
export function challengeRefusal(outcome: ChallengeOutcome): string {
  switch (outcome) {
    case "not-configured":
      return "This form is not accepting answers right now.";
    case "unavailable":
      return "The check in front of this form could not run. Try again in a moment.";
    default:
      return "That check did not pass. Reload the page and try again.";
  }
}
