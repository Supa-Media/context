/**
 * The development OTP bypass is off on every deployment of Context.
 *
 * `@supa-media/convex`'s email provider reads `DEV_OTP_BYPASS`. When it is
 * `"true"`, `generateVerificationToken` stops generating and returns a fixed
 * six-digit code for **every** address. Until 2026-11-11 it was allowed on
 * the isolated staging deployment, so staging's personas signed in with
 * `000000`. A fixed code that never expires and works for anybody is what
 * the CASA assessment failed (1.2.1, 1.3.x), staging included, so it is now
 * refused everywhere. Staging's scripts and people get a real code instead,
 * issued for one persona at a time (`functions/signInCodes.ts`).
 *
 * ## Why both a guard and a seal
 *
 *  - The **guard** is the framework's own mechanism: it ignores the variable
 *    when `productionIdentifier` is truthy *and* `CONVEX_SITE_URL` contains
 *    it. Passing the deployment's own site URL satisfies that wherever the
 *    URL is set.
 *  - The **seal** clears the variable before the providers are built, so the
 *    generator never sees it. It covers a deployment without
 *    `CONVEX_SITE_URL`, where no identifier can satisfy the guard.
 */

/** The staging app origin. One deployment, named once. */
const STAGING_ORIGIN = "https://staging.context.lc";

/** What this module reads. `process.env` in production, a literal in tests. */
type Environment = Record<string, string | undefined>;

/**
 * Is this the isolated staging deployment? Asked before a staging persona is
 * issued a code (`functions/signInCodes.ts`); it never re-enables the bypass.
 *
 * All four legs, because each rules out a different mistake: the first two are
 * ordinary configuration an operator can copy, and the last two tie the answer
 * to the deployment the platform says this actually is. `CONVEX_CLOUD_URL` is
 * set by the platform rather than by an operator.
 */
export function isIsolatedStaging(env: Environment = process.env): boolean {
  const deployment = env.STAGING_CONVEX_DEPLOYMENT;
  return (
    env.APP_ENV === "staging" &&
    env.APP_ORIGIN === STAGING_ORIGIN &&
    Boolean(deployment) &&
    env.CONVEX_CLOUD_URL === `https://${deployment}.convex.cloud`
  );
}

/**
 * The `productionIdentifier` to hand `createSupaAuth`: the deployment's own
 * site URL, which is trivially a substring of itself, so the framework ignores
 * the bypass wherever that URL is set, without naming any deployment here.
 */
export function productionOtpGuard(env: Environment = process.env): string | undefined {
  return env.CONVEX_SITE_URL || undefined;
}

/**
 * Clear `DEV_OTP_BYPASS` if it is set, on every deployment.
 *
 * Call before `createSupaAuth`: the providers read the variable while they are
 * being built, so afterwards is too late. Returns what it did, so a test can
 * tell "sealed" from "was never set".
 */
export function sealDevOtpBypass(env: Environment = process.env): "sealed" | "absent" {
  if (env.DEV_OTP_BYPASS !== "true") return "absent";
  try {
    env.DEV_OTP_BYPASS = "false";
  } catch {
    // A frozen environment. The guard above is the remaining answer, and the
    // line below still says what happened.
  }
  console.error("DEV_OTP_BYPASS is set, and Context never honours it; ignoring it.");
  return "sealed";
}
