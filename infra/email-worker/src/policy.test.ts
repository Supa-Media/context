/**
 * The seam to `senderIsAllowed`, exercised through the import path this Worker
 * actually uses.
 *
 * `worker.test.ts` mocks `./policy` so the rest of the pipeline can be driven
 * with a stub. This file does not, so it is the one place the **real** exported
 * matcher is observed — which is the only way "one matcher, one set of tests"
 * is worth anything.
 *
 * What is asserted here is deliberately not a second copy of
 * `apps/convex/__tests__/ingestionPolicy.test.ts`. That file owns the matcher's
 * behaviour. This one owns the *seam*: that the thing reachable from
 * `./policy` is that matcher and not a local re-implementation. The attack
 * strings below are the ones a hand-rolled matcher gets wrong, so a future edit
 * that swaps the re-export for "a small local helper, just for the Worker"
 * fails here.
 */
import { describe, expect, it, vi } from "vitest";
import { senderIsAllowed } from "./policy";
import { senderIsAllowed as controlPlaneMatcher } from "../../../apps/convex/functions/lib/ingestion";
import { handleEmail, REFUSAL, type Env, type InboundMessage } from "./index";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";

describe("the matcher is the control plane's, not a copy", () => {
  it("is the very same function object", () => {
    // The strongest form the assertion can take. A re-implementation that
    // happened to agree on every case below would still fail this.
    expect(senderIsAllowed).toBe(controlPlaneMatcher);
  });

  it("matches a domain by exact equality, never by suffix", () => {
    const policy = {
      allowedSenders: [],
      allowedDomains: ["example.com"],
      allowAnySender: false,
    };
    expect(senderIsAllowed("alice@example.com", policy)).toBe(true);
    // Every one of these is admitted by `domain.endsWith(allowed)`, and every
    // one of them is trivially registrable by an attacker.
    expect(senderIsAllowed("alice@mail.example.com", policy)).toBe(false);
    expect(senderIsAllowed("alice@evil-example.com", policy)).toBe(false);
    expect(senderIsAllowed("alice@example.com.evil.test", policy)).toBe(false);
  });

  it("strips sub-address tags asymmetrically", () => {
    const bare = {
      allowedSenders: ["alice@example.com"],
      allowedDomains: [],
      allowAnySender: false,
    };
    expect(senderIsAllowed("alice+notes@example.com", bare)).toBe(true);

    const tagged = {
      allowedSenders: ["alice+notes@example.com"],
      allowedDomains: [],
      allowAnySender: false,
    };
    // An owner who wrote the tag asked for that tag.
    expect(senderIsAllowed("alice+other@example.com", tagged)).toBe(false);
    expect(senderIsAllowed("alice@example.com", tagged)).toBe(false);
  });

  it("ignores a display name that quotes an allowed address", () => {
    const policy = {
      allowedSenders: ["alice@example.com"],
      allowedDomains: [],
      allowAnySender: false,
    };
    expect(
      senderIsAllowed('"alice@example.com" <attacker@evil.test>', policy),
    ).toBe(false);
  });

  it("accepts nothing under an empty policy", () => {
    // The fail-closed floor, and a reachable state: an owner who clears both
    // lists has switched ingestion off, and that must not quietly become
    // "accept everything".
    const policy = { allowedSenders: [], allowedDomains: [], allowAnySender: false };
    expect(senderIsAllowed("alice@example.com", policy)).toBe(false);
    expect(senderIsAllowed("", policy)).toBe(false);
  });

  it("still requires a well-formed address under allowAnySender", () => {
    const policy = { allowedSenders: [], allowedDomains: [], allowAnySender: true };
    expect(senderIsAllowed("alice@example.com", policy)).toBe(true);
    expect(senderIsAllowed("", policy)).toBe(false);
    expect(senderIsAllowed("not-an-address", policy)).toBe(false);
  });
});

describe("end to end, through the real matcher", () => {
  /**
   * The pipeline with nothing stubbed but the control plane's transport.
   *
   * `rawMessage()` is from `alice@example.com` and authenticates against
   * `AUTHSERV`, so the only thing left to decide is the policy — and the policy
   * here is the fail-closed floor. Sabotage: make `./policy` re-export a
   * matcher that returns `true`, and this goes green while the message is
   * captured.
   */
  it("refuses a sender the owner's policy does not admit", async () => {
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
          return {
            ticket: "ticket",
            context: { kind: "personal" as const, path: "seyi" },
            targetFolder: "0-inbox/",
            attachmentPolicy: "ignore",
            maxMessageBytes: 5_000_000,
            policy: { allowedSenders: [], allowedDomains: [], allowAnySender: false },
          };
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
    expect(logs.join("\n")).toContain("sender_not_allowed");
    // And it refuses *before* asking for a credential, so a message that was
    // never going to be captured causes no decrypt.
    expect(calls).toEqual(["resolve"]);

    vi.restoreAllMocks();
  });
});
