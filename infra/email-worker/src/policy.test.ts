/**
 * The seam to `senderIsAllowed`, and the fail-closed posture while it is
 * unwired.
 *
 * `worker.test.ts` mocks this module so the rest of the pipeline can be
 * exercised. This file does not, so it is the one place the *real* exported
 * matcher is observed — which is the only way the fail-closed claim is worth
 * anything.
 */
import { describe, expect, it, vi } from "vitest";
import { SENDER_MATCHER_WIRED, senderIsAllowed } from "./policy";
import { handleEmail, REFUSAL, type Env, type InboundMessage } from "./index";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";

describe("while the control plane's matcher is unwired", () => {
  it("says so, rather than pretending", () => {
    // When this flips to `true`, the import at the top of ./policy.ts is the
    // real one and the tests below stop describing reality — which is why the
    // flag exists rather than a comment.
    expect(SENDER_MATCHER_WIRED).toBe(false);
  });

  it("denies every sender, under every policy", () => {
    const policies = [
      { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false },
      { allowedSenders: [], allowedDomains: ["example.com"], allowAnySender: false },
      { allowedSenders: [], allowedDomains: [], allowAnySender: true },
      { allowedSenders: ["*"], allowedDomains: ["*"], allowAnySender: true },
    ];
    for (const policy of policies) {
      expect(senderIsAllowed("alice@example.com", policy)).toBe(false);
      expect(senderIsAllowed("", policy)).toBe(false);
    }
  });

  it("makes the Worker refuse a message that would otherwise be captured", async () => {
    // The posture, end to end: an unwired deployment ingests nothing rather
    // than ingesting everything. Sabotage: default `SENDER_MATCHER_WIRED` to
    // true, or make the placeholder return `true`, and this fails.
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));

    const raw = rawMessage();
    const rejected: string[] = [];
    const message: InboundMessage = {
      to: "seyi@context.lc",
      from: "alice@example.com",
      raw: streamOf(raw),
      rawSize: raw.length,
      setReject: (reason) => void rejected.push(reason),
      forward: async () => {},
    };
    const env: Env = {
      CONTROL_PLANE_URL: "https://control-plane.test",
      EMAIL_WORKER_SECRET: "not-a-real-secret",
      INGEST_DOMAIN: "context.lc",
      AUTH_SERVICE_ID: AUTHSERV,
    };
    const calls: string[] = [];
    await handleEmail(message, env, {
      controlPlane: {
        async resolveIngestion() {
          calls.push("resolve");
          return null;
        },
        async getBinding() {
          calls.push("binding");
          return null;
        },
        async record() {
          calls.push("record");
        },
      } as never,
    });

    expect(rejected).toEqual([REFUSAL]);
    expect(logs.join("\n")).toContain("sender_matcher_unwired");
    // And it refuses before it asks the control plane anything at all, so an
    // unwired deployment is not also a traffic generator.
    expect(calls).toEqual([]);

    vi.restoreAllMocks();
  });
});
