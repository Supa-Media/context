/**
 * Where the development OTP bypass is allowed to exist.
 *
 * ## The variable, and why one argument decides everything about it
 *
 * `@supa-media/convex`'s email provider reads `DEV_OTP_BYPASS`. When it is
 * `"true"`, `generateVerificationToken` stops generating and returns a fixed
 * six-digit code — for **every** address, because the generator takes no
 * arguments and has no idea who is signing in. It is the ordinary customer
 * provider, not a separate one: there is exactly one email OTP provider and
 * this changes what it mints.
 *
 * The framework ships one control against that being live where it should not
 * be, `productionIdentifier`, and honours the variable unless that identifier
 * is truthy *and* `CONVEX_SITE_URL` contains it. It is opt-in, which makes an
 * omission indistinguishable from a decision: `if (productionIdentifier && …)`
 * with `undefined` is false for every input there is, so a deployment that
 * never passes one has the control in its dependency and none of its effect.
 * That is the shape this module exists to close, and it is why the tests
 * beside it read `auth.ts` rather than only these functions.
 *
 * ## Whitelist, not blocklist
 *
 * The obvious reading of `productionIdentifier` is "name production, so the
 * bypass is ignored there". That protects the deployments somebody remembered
 * to name. It does not protect a self-host — a supported path here — and it
 * does not protect the next deployment, which is the one nobody has named yet.
 *
 * So the question asked is the opposite one: **is this the single deployment
 * the bypass is for?** The gate is the same four-way shape
 * `stagingStorageIsFree` already uses for the other staging-only concession,
 * and it is deliberately the same: `CONVEX_CLOUD_URL` is set by the platform
 * rather than by an operator, so copying `APP_ENV` and `APP_ORIGIN` onto
 * another deployment does not carry the bypass with them.
 *
 * ## Why both a guard and a seal
 *
 * They close different holes and neither covers the other:
 *
 *  - The **guard** is the framework's own mechanism, used as intended. It
 *    depends on a substring match against `CONVEX_SITE_URL`, so where that
 *    variable is absent no identifier can satisfy it and the framework honours
 *    the bypass whatever this module returns.
 *  - The **seal** clears the variable before the providers are built, so the
 *    generator never sees it. It is the one that covers the case above, and it
 *    is best-effort: an environment object that refuses writes leaves the
 *    guard as the remaining answer.
 */

/** The staging app origin. One deployment, named once. */
const STAGING_ORIGIN = "https://staging.context.lc";

/** What this module reads. `process.env` in production, a literal in tests. */
type Environment = Record<string, string | undefined>;

/**
 * Is this the isolated staging deployment the bypass exists for?
 *
 * All four legs, because each rules out a different mistake: the first two are
 * ordinary configuration an operator can copy, and the last two tie the answer
 * to the deployment the platform says this actually is.
 */
export function devOtpBypassAllowed(env: Environment = process.env): boolean {
  const deployment = env.STAGING_CONVEX_DEPLOYMENT;
  return (
    env.APP_ENV === "staging" &&
    env.APP_ORIGIN === STAGING_ORIGIN &&
    Boolean(deployment) &&
    env.CONVEX_CLOUD_URL === `https://${deployment}.convex.cloud`
  );
}

/**
 * The `productionIdentifier` to hand `createSupaAuth`.
 *
 * `undefined` on staging, so the bypass staging depends on still works. Off
 * staging it returns the deployment's own site URL, which is trivially a
 * substring of itself — the framework's test is `siteUrl.includes(identifier)`,
 * so this is the shortest value guaranteed to satisfy it without naming any
 * deployment in a public repository.
 */
export function productionOtpGuard(env: Environment = process.env): string | undefined {
  if (devOtpBypassAllowed(env)) return undefined;
  return env.CONVEX_SITE_URL || undefined;
}

/**
 * Clear `DEV_OTP_BYPASS` unless this deployment is the one it is for.
 *
 * Call before `createSupaAuth`: the providers read the variable while they are
 * being built, so afterwards is too late.
 *
 * Returns what it did, so a test can tell "sealed" from "was never set" —
 * two states that look identical from the environment alone afterwards.
 */
export function sealDevOtpBypass(env: Environment = process.env): "allowed" | "sealed" | "absent" {
  if (env.DEV_OTP_BYPASS !== "true") return "absent";
  if (devOtpBypassAllowed(env)) return "allowed";
  try {
    env.DEV_OTP_BYPASS = "false";
  } catch {
    // A frozen environment. The guard above is the remaining answer, and the
    // line below still says what happened.
  }
  console.error(
    "DEV_OTP_BYPASS is set on a deployment that is not the isolated staging backend; ignoring it.",
  );
  return "sealed";
}
