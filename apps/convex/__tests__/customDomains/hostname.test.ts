import { describe, expect, test } from "vitest";
import { normalizeHostname, relativeRecordName } from "../../functions/lib/customDomains/hostname";
import { unquoteTxt } from "../../functions/lib/customDomains/dns";
import { applyCheck, nextCheckDelay, stageOf, CHECK_WINDOW_MS } from "../../functions/lib/customDomains/lifecycle";
import type { Doc } from "../../_generated/dataModel";

describe("normalizeHostname", () => {
  test.each([
    ["docs.acme-test.com", "docs.acme-test.com"],
    ["  Docs.ACME-test.com.  ", "docs.acme-test.com"],
    ["https://docs.acme-test.com/intake?x=1", "docs.acme-test.com"],
    ["bücher-test.de", "xn--bcher-test-9db.de"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeHostname(input)).toMatchObject({ ok: true, hostname: expected });
  });

  test.each([
    ["", "EMPTY"],
    ["acme", "NOT_A_DOMAIN"],
    ["docs.acme-test.com:8443", "NOT_A_DOMAIN"],
    ["user@docs.acme-test.com", "NOT_A_DOMAIN"],
    ["*.acme-test.com", "NOT_A_DOMAIN"],
    ["-bad.acme-test.com", "NOT_A_DOMAIN"],
    ["acme_test.com", "NOT_A_DOMAIN"],
    ["acme.123", "NOT_A_DOMAIN"],
    ["192.168.1.1", "IP_ADDRESS"],
    ["context.lc", "PLATFORM_DOMAIN"],
    ["MCP.Context.LC", "PLATFORM_DOMAIN"],
    ["router.localhost", "PLATFORM_DOMAIN"],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`, "TOO_LONG"],
  ])("%s is refused as %s", (input, reason) => {
    expect(normalizeHostname(input)).toEqual({ ok: false, reason });
  });

  test("apex is two labels", () => {
    expect(normalizeHostname("acme-test.com")).toMatchObject({ apex: true });
    expect(normalizeHostname("www.acme-test.com")).toMatchObject({ apex: false });
  });
});

test("record names are shown relative to the zone", () => {
  expect(relativeRecordName("acme-test.com", "acme-test.com")).toBe("@");
  expect(relativeRecordName("docs.acme-test.com", "docs.acme-test.com")).toBe("docs");
  expect(relativeRecordName("_context.acme-test.com", "acme-test.com")).toBe("_context");
});

test("TXT answers are unquoted and rejoined", () => {
  expect(unquoteTxt('"context-verification=" "abc"')).toBe("context-verification=abc");
  expect(unquoteTxt("bare")).toBe("bare");
});

function row(overrides: Partial<Doc<"customDomains">> = {}): Doc<"customDomains"> {
  return {
    _id: "d" as Doc<"customDomains">["_id"],
    _creationTime: 0,
    workspaceId: "w" as Doc<"customDomains">["workspaceId"],
    hostname: "docs.acme-test.com",
    apex: false,
    status: "pending",
    verifyToken: "t",
    ownershipVerified: false,
    routingVerified: false,
    httpsReady: false,
    createdBy: "u" as Doc<"customDomains">["createdBy"],
    createdAt: 0,
    updatedAt: 0,
    checkingSince: 0,
    checkCount: 0,
    ...overrides,
  };
}

describe("applyCheck", () => {
  const live = { routing: true, https: true, problem: null };

  test("ownership is sticky once seen", () => {
    const outcome = applyCheck(row({ ownershipVerified: true }), { ownership: false, readiness: live }, 1);
    expect(outcome.patch.status).toBe("active");
  });

  test("a live domain survives a provider it could not reach", () => {
    const outcome = applyCheck(row({ status: "active" }), { ownership: true, readiness: null, providerProblem: "PROVIDER_UNAVAILABLE" }, 1);
    expect(outcome.patch.status).toBeUndefined();
    expect(outcome.checkAgainIn).toBeNull();
  });

  test("a live domain whose DNS moved away goes back to pending", () => {
    const outcome = applyCheck(row({ status: "active", ownershipVerified: true }), { ownership: true, readiness: { routing: false, https: true, problem: "ROUTING_BLOCKED" } }, 1);
    expect(outcome.patch.status).toBe("pending");
    expect(outcome.checkAgainIn).toBe(nextCheckDelay(0));
  });

  test("a run stops after its window and says so", () => {
    const outcome = applyCheck(row(), { ownership: false, readiness: { routing: false, https: false, problem: null } }, CHECK_WINDOW_MS);
    expect(outcome.patch.problem).toBe("TIMED_OUT");
    expect(outcome.checkAgainIn).toBeNull();
  });

  test("stage is the first unmet step", () => {
    expect(stageOf(row())).toBe("ownership");
    expect(stageOf(row({ ownershipVerified: true }))).toBe("routing");
    expect(stageOf(row({ ownershipVerified: true, routingVerified: true }))).toBe("https");
    expect(stageOf(row({ status: "active" }))).toBe("live");
  });
});
