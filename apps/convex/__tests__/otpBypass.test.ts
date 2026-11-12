import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  isIsolatedStaging,
  productionOtpGuard,
  sealDevOtpBypass,
} from "../functions/lib/otpBypass";

/**
 * The development OTP bypass, and the one argument that decides where it works.
 *
 * `@supa-media/convex`'s email provider mints a fixed six-digit code for
 * **every** address when `DEV_OTP_BYPASS` is `"true"`. The framework ships one
 * control against that reaching a deployment it should not: `productionIdentifier`,
 * which it compares against `CONVEX_SITE_URL` before honouring the variable.
 *
 * The control is opt-in, and an argument nobody passes is a guard that cannot
 * fire — `if (productionIdentifier && …)` with `undefined` is false for every
 * input there is. So these checks are about the wiring as much as the logic,
 * and the last one reads the call site rather than the helper.
 *
 * Since 2026-11-11 the bypass is honoured nowhere, staging included: a fixed
 * code for every address is what CASA 1.2.1 / 1.3.x failed. Staging's
 * personas are issued real codes instead (`functions/signInCodes.ts`).
 */

/** The exact environment the isolated staging backend presents. */
const staging = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://staging.context.lc",
  STAGING_CONVEX_DEPLOYMENT: "example-deployment",
  CONVEX_CLOUD_URL: "https://example-deployment.convex.cloud",
  CONVEX_SITE_URL: "https://example-deployment.convex.site",
};

/** An ordinary deployment that is not staging: no selectors, a live origin. */
const production = {
  APP_ENV: "production",
  APP_ORIGIN: "https://app.example.invalid",
  CONVEX_SITE_URL: "https://your-deployment.convex.site",
};

/** What a self-hosted deployment looks like: none of the staging selectors. */
const selfHost = {
  APP_ORIGIN: "https://notes.example.invalid",
  CONVEX_SITE_URL: "https://your-deployment.convex.site",
};

/**
 * The framework's own predicate, restated. `createOtpGenerator` honours the
 * bypass unless `productionIdentifier` is truthy AND `CONVEX_SITE_URL` contains
 * it, so a guard that is merely non-empty does not close anything.
 */
function frameworkIgnoresBypass(
  env: Record<string, string | undefined>,
  guard: string | undefined,
): boolean {
  const siteUrl = env.CONVEX_SITE_URL ?? "";
  return Boolean(guard) && siteUrl.includes(guard as string);
}

describe("the isolated staging deployment (asked before a persona is issued a code)", () => {
  it("is recognised on staging and nowhere else", () => {
    expect(isIsolatedStaging(staging)).toBe(true);
    expect(isIsolatedStaging(production)).toBe(false);
    expect(isIsolatedStaging(selfHost)).toBe(false);
    expect(isIsolatedStaging({})).toBe(false);
  });

  it("refuses when any single leg of the staging shape is missing", () => {
    // Each leg alone. The platform sets CONVEX_CLOUD_URL, so an operator who
    // copies APP_ENV and APP_ORIGIN onto another deployment still fails here.
    for (const leg of Object.keys(staging)) {
      if (leg === "CONVEX_SITE_URL") continue;
      const broken = { ...staging, [leg]: undefined };
      expect(isIsolatedStaging(broken), `${leg} alone must close the gate`).toBe(false);
    }
    expect(isIsolatedStaging({ ...staging, CONVEX_CLOUD_URL: "https://your-deployment.convex.cloud" })).toBe(false);
    expect(isIsolatedStaging({ ...staging, APP_ORIGIN: "https://context.lc" })).toBe(false);
  });
});

describe("the guard handed to the framework", () => {
  it("makes the framework ignore the bypass everywhere, staging included", () => {
    // Not merely "returns something": the framework's own test is a substring
    // match, so a guard the site URL does not contain would read as protection
    // and be none. Staging is on the list since 2026-11-11 (CASA 1.2.1).
    for (const env of [staging, production, selfHost]) {
      const guard = productionOtpGuard(env);
      expect(guard).toBeTruthy();
      expect(frameworkIgnoresBypass(env, guard)).toBe(true);
    }
  });
});

describe("sealing the variable itself", () => {
  it("clears it everywhere, staging included", () => {
    for (const base of [production, staging, selfHost]) {
      const env = { ...base, DEV_OTP_BYPASS: "true" } as Record<string, string | undefined>;
      expect(sealDevOtpBypass(env)).toBe("sealed");
      expect(env.DEV_OTP_BYPASS).not.toBe("true");
    }
  });

  it("says so when the variable was never set", () => {
    expect(sealDevOtpBypass({ ...production })).toBe("absent");
  });

  it("closes the case the framework's own guard cannot", () => {
    // `CONVEX_SITE_URL` absent: no identifier can be a substring of "", so the
    // framework would honour the bypass however this repo configures it. The
    // seal is what covers that, which is why both exist.
    const env = { APP_ENV: "production", DEV_OTP_BYPASS: "true" } as Record<string, string | undefined>;
    expect(frameworkIgnoresBypass(env, productionOtpGuard(env))).toBe(false);
    expect(sealDevOtpBypass(env)).toBe("sealed");
    expect(env.DEV_OTP_BYPASS).not.toBe("true");
  });
});

describe("the wiring, read at the call site", () => {
  it("passes the guard to createSupaAuth and seals before building providers", () => {
    // The defect this file exists for was an omission, not a mistake: every
    // helper above can be correct while nothing calls it. So assert the call
    // site, and assert the order — providers are built during the
    // createSupaAuth call, so the seal has to precede it.
    const source = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
    expect(source).toContain("sealDevOtpBypass()");
    expect(source).toContain("productionIdentifier: productionOtpGuard()");
    expect(source.indexOf("sealDevOtpBypass()")).toBeLessThan(source.indexOf("createSupaAuth("));
  });
});
