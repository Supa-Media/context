/**
 * THE STAFF SURFACE — `functions/admin.ts` and `functions/lib/admin.ts`.
 *
 * This is a console that reads figures across every tenant and holds the
 * platform's integration credentials. Two things therefore have to be true,
 * and neither is provable by reading the screens:
 *
 *  1. **Being staff is not something the product can grant.** The allowlist is
 *     an environment variable, and every way of becoming staff without being
 *     on it is closed — including the one that looks harmless, signing up as
 *     an allowlisted address without proving you hold the mailbox.
 *  2. **A secret goes in and never comes back out.** `structure.test.ts`
 *     proves that structurally over the call graph; what is proven here is the
 *     behaviour that makes the structural rule meaningful — that the value is
 *     absent from what the console actually returns, and that the fingerprint
 *     shown in its place is not a piece of the credential.
 *
 * Plus the binding property the new envelope scope introduces: a platform
 * secret and a customer's storage credential are sealed to different things
 * and **neither opens in the other's place**, including in the one case where
 * an identifier collision would make them look the same.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *
 *   `requireAdmin` dropping the `emailVerificationTime` check          3
 *   `parseAdminEmails` returning "everybody" for an unset variable     4
 *   `isAdminEmail` matching on domain suffix rather than exactly       2
 *   `additionalData` dropping the `workspace:`/`platform:` segment     2
 *   `normalizeSecretName` allowing a reserved name through             5
 *   `listSecrets` selecting `value` onto its returned row              1
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  ADMIN_EMAILS_ENV_VAR,
  isAdminEmail,
  parseAdminEmails,
} from "../functions/lib/admin";
import {
  AppSecretError,
  FINGERPRINT_LENGTH,
  MAX_SECRET_VALUE_LENGTH,
  RESERVED_SECRET_NAMES,
  fingerprintSecret,
  normalizeSecretDescription,
  normalizeSecretName,
  normalizeSecretValue,
} from "../functions/lib/appSecrets";
import {
  decryptSecret,
  encryptSecret,
  requireKeyset,
  type Keyset,
} from "../functions/lib/crypto";
import {
  DEFAULT_REPORT_DAYS,
  MAX_REPORT_DAYS,
  clampReportDays,
  dayKey,
  dayRange,
  isUsageMetric,
  isUsageSurface,
} from "../functions/lib/usage";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const KEYSET: Keyset = { current: { id: "k1", material: KEY } };

const ADMIN = "staff@supa.media";
const STRANGER = "someone@example.com";

// -- the allowlist --------------------------------------------------------

describe("who counts as staff", () => {
  test("an unset allowlist authorizes nobody", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails("").size).toBe(0);
    expect(parseAdminEmails("   ").size).toBe(0);
    // The direction a misconfiguration must fail in. The other one publishes
    // every tenant's figures and the credential store to whoever signs up.
    expect(isAdminEmail(ADMIN, {})).toBe(false);
    expect(isAdminEmail(ADMIN, { [ADMIN_EMAILS_ENV_VAR]: "" })).toBe(false);
  });

  test("addresses are matched exactly, never by domain", () => {
    const env = { [ADMIN_EMAILS_ENV_VAR]: ADMIN };
    expect(isAdminEmail(ADMIN, env)).toBe(true);
    // The whole point of refusing a suffix rule: none of these is the
    // allowlisted mailbox, and each is trivially registrable by somebody else.
    expect(isAdminEmail("other@supa.media", env)).toBe(false);
    expect(isAdminEmail("staff@supa.media.evil.test", env)).toBe(false);
    expect(isAdminEmail("evilstaff@supa.media", env)).toBe(false);
    expect(isAdminEmail("staff@supa.mediax", env)).toBe(false);
  });

  test("a domain written into the allowlist enrols nobody", () => {
    // Somebody will try this. It must fail closed rather than admit the
    // domain, because the value is a list of addresses and "@supa.media" is
    // not one.
    const env = { [ADMIN_EMAILS_ENV_VAR]: "@supa.media" };
    expect(isAdminEmail(ADMIN, env)).toBe(false);
    expect(isAdminEmail("@supa.media", env)).toBe(true);
  });

  test("entries are split on commas and whitespace, and lowercased", () => {
    const parsed = parseAdminEmails("A@x.test, b@x.test\n  c@x.test,,");
    expect([...parsed].sort()).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
    // A pasted address with different case is the same mailbox.
    expect(isAdminEmail("A@X.test", { [ADMIN_EMAILS_ENV_VAR]: "a@x.test" })).toBe(
      true,
    );
  });

  test("an empty address never matches an empty entry", () => {
    // `"".split(...)` filtering matters: without it the set holds "" and any
    // account with no address on the row becomes staff.
    expect(isAdminEmail("", { [ADMIN_EMAILS_ENV_VAR]: ",," })).toBe(false);
    expect(isAdminEmail(undefined, { [ADMIN_EMAILS_ENV_VAR]: ADMIN })).toBe(
      false,
    );
  });
});

// -- the surface refuses non-staff ---------------------------------------

async function seedUser(
  t: ReturnType<typeof convexTest>,
  email: string,
  verified: boolean,
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    await ctx.db.insert("users", {
      email,
      ...(verified ? { emailVerificationTime: Date.now() } : {}),
    } as never),
  );
}

describe("the admin surface refuses everyone else", () => {
  test("a signed-out caller is refused", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    await expect(t.query(api.functions.admin.listSecrets, {})).rejects.toThrow();
    await expect(t.query(api.functions.admin.usageReport, {})).rejects.toThrow();
  });

  test("a signed-in stranger is refused", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const userId = await seedUser(t, STRANGER, true);
    const asUser = t.withIdentity({ subject: userId });
    await expect(
      asUser.query(api.functions.admin.listSecrets, {}),
    ).rejects.toThrow();
  });

  test("an UNVERIFIED allowlisted address is refused", async () => {
    // The bug this closes: signing up as a staff address, without ever
    // receiving the code, would otherwise be enough to become staff.
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const userId = await seedUser(t, ADMIN, false);
    const asUser = t.withIdentity({ subject: userId });
    await expect(
      asUser.query(api.functions.admin.listSecrets, {}),
    ).rejects.toThrow();
    expect(await asUser.query(api.functions.admin.amIAdmin, {})).toBe(false);
  });

  test("a verified allowlisted address is admitted", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const userId = await seedUser(t, ADMIN, true);
    const asUser = t.withIdentity({ subject: userId });
    expect(await asUser.query(api.functions.admin.amIAdmin, {})).toBe(true);
    expect(await asUser.query(api.functions.admin.listSecrets, {})).toEqual([]);
  });

  test("clearing the allowlist revokes staff immediately", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const userId = await seedUser(t, ADMIN, true);
    const asUser = t.withIdentity({ subject: userId });
    expect(await asUser.query(api.functions.admin.amIAdmin, {})).toBe(true);

    delete process.env[ADMIN_EMAILS_ENV_VAR];
    // No row to update, no session to revoke: the capability was never in the
    // database, so removing the variable is the whole revocation.
    expect(await asUser.query(api.functions.admin.amIAdmin, {})).toBe(false);
  });

  test("refusal does not distinguish a stranger from a missing endpoint", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const strangerId = await seedUser(t, STRANGER, true);

    const signedOut = await t
      .query(api.functions.admin.listSecrets, {})
      .catch((error: unknown) => error);
    const stranger = await t
      .withIdentity({ subject: strangerId })
      .query(api.functions.admin.listSecrets, {})
      .catch((error: unknown) => error);

    // Same code and same message either way. A distinct "you are not an admin"
    // confirms to an authenticated stranger that the surface is there and that
    // their account is the only thing between them and it.
    for (const error of [signedOut, stranger]) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<{ code: string }>).data.code).toBe(
        "NOT_FOUND",
      );
    }
  });
});

// -- secret names ---------------------------------------------------------

describe("what may be stored", () => {
  test("the bootstrapping keys are refused by name", () => {
    // Each of these has to exist before this table can be read at all. A
    // console that accepts the paste and shows a fingerprint would be lying.
    for (const name of RESERVED_SECRET_NAMES) {
      expect(() => normalizeSecretName(name)).toThrow(AppSecretError);
      // And through the normalizer's own casing, so lowercase does not slip by.
      expect(() => normalizeSecretName(name.toLowerCase())).toThrow(
        AppSecretError,
      );
    }
    expect(RESERVED_SECRET_NAMES.has("STORAGE_SECRET_ENCRYPTION_KEY")).toBe(true);
    expect(RESERVED_SECRET_NAMES.has("GATEWAY_SECRET")).toBe(true);
  });

  test("names are environment-variable shaped", () => {
    expect(normalizeSecretName("  search_d1_api_token ")).toBe(
      "SEARCH_D1_API_TOKEN",
    );
    expect(normalizeSecretName("STRIPE_SECRET_KEY")).toBe("STRIPE_SECRET_KEY");
    for (const bad of ["", "AB", "1ABC", "A-B", "A B", "A".repeat(65), "A.B"]) {
      expect(() => normalizeSecretName(bad)).toThrow(AppSecretError);
    }
  });

  test("a value is trimmed, non-empty and bounded", () => {
    // The trailing newline a pasted token almost always carries, and which
    // otherwise fails to authenticate for an invisible reason.
    expect(normalizeSecretValue("  token-value\n")).toBe("token-value");
    expect(() => normalizeSecretValue("   ")).toThrow(AppSecretError);
    expect(() => normalizeSecretValue("")).toThrow(AppSecretError);
    expect(() =>
      normalizeSecretValue("x".repeat(MAX_SECRET_VALUE_LENGTH + 1)),
    ).toThrow(AppSecretError);
  });

  test("a description is optional and bounded", () => {
    expect(normalizeSecretDescription(undefined)).toBeUndefined();
    expect(normalizeSecretDescription("  ")).toBeUndefined();
    expect(normalizeSecretDescription(" for D1 ")).toBe("for D1");
    expect(() => normalizeSecretDescription("x".repeat(201))).toThrow(
      AppSecretError,
    );
  });
});

// -- the fingerprint ------------------------------------------------------

describe("the fingerprint is not the credential", () => {
  test("it is deterministic, short hex, and value-dependent", async () => {
    const a = await fingerprintSecret("token-aaaa");
    const b = await fingerprintSecret("token-bbbb");
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a).toHaveLength(FINGERPRINT_LENGTH);
    expect(await fingerprintSecret("token-aaaa")).toBe(a);
    expect(a).not.toBe(b);
  });

  test("it is not a fragment of the value", async () => {
    // The alternative design — showing a prefix or a last-four — puts a piece
    // of the real credential in every screenshot and log line this appears in.
    const value = "sk_live_0123456789abcdef";
    const fingerprint = await fingerprintSecret(value);
    expect(value).not.toContain(fingerprint);
    expect(value.startsWith(fingerprint)).toBe(false);
    expect(value.endsWith(fingerprint)).toBe(false);
  });

  test("an empty value is refused rather than fingerprinted", async () => {
    await expect(fingerprintSecret("")).rejects.toThrow();
  });
});

// -- the envelope binding -------------------------------------------------

describe("a platform envelope and a workspace envelope are not interchangeable", () => {
  test("a platform secret does not open with a workspace context", async () => {
    const envelope = await encryptSecret("d1-token", KEYSET, {
      platform: "integration",
    });
    await expect(
      decryptSecret(envelope, KEYSET, { workspaceId: "integration" }),
    ).rejects.toThrow();
    await expect(
      decryptSecret(envelope, KEYSET, { workspaceId: "ws_123" }),
    ).rejects.toThrow();
    expect(
      await decryptSecret(envelope, KEYSET, { platform: "integration" }),
    ).toBe("d1-token");
  });

  test("a workspace credential does not open with the platform context", async () => {
    const envelope = await encryptSecret("bucket-key", KEYSET, {
      workspaceId: "ws_123",
    });
    await expect(
      decryptSecret(envelope, KEYSET, { platform: "integration" }),
    ).rejects.toThrow();
    expect(
      await decryptSecret(envelope, KEYSET, { workspaceId: "ws_123" }),
    ).toBe("bucket-key");
  });

  test("an id colliding with the scope label does not cross the boundary", async () => {
    // The reason the AAD carries `workspace:`/`platform:` as a literal segment
    // rather than just the identifier. Without it these two envelopes would be
    // bound to the same bytes and would open in each other's place.
    const platform = await encryptSecret("PLATFORM", KEYSET, {
      platform: "integration",
    });
    const workspace = await encryptSecret("WORKSPACE", KEYSET, {
      workspaceId: "integration",
    });
    expect(
      await decryptSecret(workspace, KEYSET, { workspaceId: "integration" }),
    ).toBe("WORKSPACE");
    await expect(
      decryptSecret(platform, KEYSET, { workspaceId: "integration" }),
    ).rejects.toThrow();
    await expect(
      decryptSecret(workspace, KEYSET, { platform: "integration" }),
    ).rejects.toThrow();
  });

  test("an unbound context is refused on both arms", async () => {
    await expect(
      encryptSecret("x", KEYSET, { workspaceId: "" }),
    ).rejects.toThrow();
    // The plain-JS shape the union cannot prevent at runtime.
    await expect(
      encryptSecret("x", KEYSET, {} as never),
    ).rejects.toThrow();
  });

  test("existing workspace envelopes still open unchanged", async () => {
    // The AAD's `workspace:` segment is spelled exactly as it always was.
    // Changing it would make every stored storage binding undecryptable, which
    // is a data-loss bug that no other test in this file would catch.
    const envelope = await encryptSecret("legacy", KEYSET, {
      workspaceId: "ws_legacy",
    });
    expect(
      await decryptSecret(envelope, KEYSET, { workspaceId: "ws_legacy" }),
    ).toBe("legacy");
  });
});

// -- the console round trip ----------------------------------------------

describe("a secret goes in and does not come back", () => {
  async function adminSession() {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    process.env.STORAGE_SECRET_ENCRYPTION_KEY = KEY;
    const userId = await seedUser(t, ADMIN, true);
    return { t, userId, as: t.withIdentity({ subject: userId }) };
  }

  test("setSecret stores an envelope and listSecrets never returns it", async () => {
    const { t, as } = await adminSession();
    const value = "cf-d1-token-not-real-0000";

    const result = await as.action(api.functions.admin.setSecret, {
      name: "SEARCH_D1_API_TOKEN",
      value,
      description: "Provisions per-brain D1 search databases",
    });
    expect(result.fingerprint).toBe(await fingerprintSecret(value));

    const listed = await as.query(api.functions.admin.listSecrets, {});
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("SEARCH_D1_API_TOKEN");
    expect(listed[0].fingerprint).toBe(result.fingerprint);
    expect(listed[0].updatedByEmail).toBe(ADMIN);

    // The value is absent from the returned shape entirely — not masked, not
    // truncated, not present as a sealed envelope either. Asserted over the
    // serialized row so a nested or renamed field cannot hide in it.
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(value);
    expect(serialized).not.toContain("v2:");
    expect(Object.keys(listed[0])).not.toContain("value");

    // And it really was stored, sealed, and is openable only internally.
    const stored = await t.run(
      async (ctx) => await ctx.db.query("appSecrets").unique(),
    );
    expect(stored?.value.startsWith("v2:")).toBe(true);
    expect(stored?.value).not.toContain(value);
  });

  test("readIntegrationSecret returns what was set", async () => {
    const { t, as } = await adminSession();
    await as.action(api.functions.admin.setSecret, {
      name: "STRIPE_SECRET_KEY",
      value: "sk_test_not_real",
    });
    const opened = await t.action(
      internal.functions.admin.readIntegrationSecret,
      { name: "STRIPE_SECRET_KEY" },
    );
    expect(opened).toBe("sk_test_not_real");
  });

  test("an unset integration reads as null rather than throwing", async () => {
    const { t } = await adminSession();
    expect(
      await t.action(internal.functions.admin.readIntegrationSecret, {
        name: "MAILGUN_API_KEY",
      }),
    ).toBeNull();
  });

  test("setting again replaces the value and records both fingerprints", async () => {
    const { t, as } = await adminSession();
    await as.action(api.functions.admin.setSecret, {
      name: "SEARCH_D1_API_TOKEN",
      value: "first-value",
      description: "keep me",
    });
    await as.action(api.functions.admin.setSecret, {
      name: "SEARCH_D1_API_TOKEN",
      value: "second-value",
    });

    const rows = await t.run(
      async (ctx) => await ctx.db.query("appSecrets").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(
      await t.action(internal.functions.admin.readIntegrationSecret, {
        name: "SEARCH_D1_API_TOKEN",
      }),
    ).toBe("second-value");
    // Rotating a value must not silently wipe the note saying what it is for.
    expect(rows[0].description).toBe("keep me");

    const audit = await t.run(
      async (ctx) => await ctx.db.query("adminAuditEvents").collect(),
    );
    expect(audit.map((row) => row.action)).toEqual([
      "secret.set",
      "secret.updated",
    ]);
    expect(audit[1].details?.previousFingerprint).toBe(
      await fingerprintSecret("first-value"),
    );
    // The trail names the secret and its fingerprint, and holds no value.
    expect(JSON.stringify(audit)).not.toContain("first-value");
    expect(JSON.stringify(audit)).not.toContain("second-value");
  });

  test("a stranger cannot set or delete a secret", async () => {
    const { t } = await adminSession();
    const strangerId = await seedUser(t, STRANGER, true);
    const asStranger = t.withIdentity({ subject: strangerId });

    await expect(
      asStranger.action(api.functions.admin.setSecret, {
        name: "SEARCH_D1_API_TOKEN",
        value: "stolen",
      }),
    ).rejects.toThrow();
    await expect(
      asStranger.mutation(api.functions.admin.deleteSecret, {
        name: "SEARCH_D1_API_TOKEN",
      }),
    ).rejects.toThrow();

    expect(
      await t.run(async (ctx) => await ctx.db.query("appSecrets").collect()),
    ).toEqual([]);
  });

  test("a reserved name is refused through the console, not only the helper", async () => {
    const { t, as } = await adminSession();
    await expect(
      as.action(api.functions.admin.setSecret, {
        name: "STORAGE_SECRET_ENCRYPTION_KEY",
        value: KEY,
      }),
    ).rejects.toThrow();
    expect(
      await t.run(async (ctx) => await ctx.db.query("appSecrets").collect()),
    ).toEqual([]);
  });

  test("deleting removes the row and leaves a trail", async () => {
    const { t, as } = await adminSession();
    await as.action(api.functions.admin.setSecret, {
      name: "SEARCH_D1_API_TOKEN",
      value: "value",
    });
    await as.mutation(api.functions.admin.deleteSecret, {
      name: "SEARCH_D1_API_TOKEN",
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("appSecrets").collect()),
    ).toEqual([]);
    const audit = await t.run(
      async (ctx) => await ctx.db.query("adminAuditEvents").collect(),
    );
    expect(audit.at(-1)?.action).toBe("secret.deleted");
  });
});

// -- the report window ----------------------------------------------------

describe("the usage vocabulary and window", () => {
  test("metric and surface names are a closed set", () => {
    expect(isUsageMetric("mcp.tool_call")).toBe(true);
    expect(isUsageMetric("anything.else")).toBe(false);
    expect(isUsageMetric(42)).toBe(false);
    expect(isUsageSurface("mcp")).toBe(true);
    expect(isUsageSurface("../../etc")).toBe(false);
  });

  test("a report window is clamped rather than obeyed", () => {
    // Without the clamp, `days: 1e9` is a full-table scan an authenticated
    // caller can ask for at will.
    expect(clampReportDays(undefined)).toBe(DEFAULT_REPORT_DAYS);
    expect(clampReportDays(1_000_000)).toBe(MAX_REPORT_DAYS);
    expect(clampReportDays(0)).toBe(1);
    expect(clampReportDays(-5)).toBe(1);
    expect(clampReportDays(Number.NaN)).toBe(DEFAULT_REPORT_DAYS);
    expect(clampReportDays(7)).toBe(7);
  });

  test("day keys are UTC and a range walks midnights", () => {
    expect(dayKey(Date.parse("2026-09-04T23:59:59.999Z"))).toBe("2026-09-04");
    expect(dayKey(Date.parse("2026-09-05T00:00:00.000Z"))).toBe("2026-09-05");
    expect(dayRange("2026-03-03", 3)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
    // Across a month boundary and a leap day, because subtracting 86.4e6 from
    // a local timestamp is where this usually goes wrong.
    expect(dayRange("2028-03-01", 2)).toEqual(["2028-02-29", "2028-03-01"]);
    expect(dayRange("nonsense", 3)).toEqual([]);
    expect(dayRange("2026-03-03", 0)).toEqual([]);
  });

  test("the report zero-fills days with no rows", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const userId = await seedUser(t, ADMIN, true);
    const report = await t
      .withIdentity({ subject: userId })
      .query(api.functions.admin.usageReport, { days: 3 });

    expect(report.window).toHaveLength(3);
    for (const series of report.series) {
      expect(series.points).toHaveLength(3);
      // A hole in a trend line reads as missing data; a zero is a fact.
      expect(series.points.every((point) => point.count === 0)).toBe(true);
      expect(series.total).toBe(0);
    }
    expect(report.activeContexts.distinctInWindow).toBe(0);
  });
});
