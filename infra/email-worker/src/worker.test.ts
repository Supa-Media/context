/**
 * The handler: the wiring, and the one property that can only be checked here.
 *
 * ============================================================================
 * WHAT AN ATTACKER LEARNS FROM A REJECTION: NOTHING
 * ============================================================================
 *
 * Ingestion is on the apex, so `<name>@context.lc` is an address anybody can
 * send to. If a rejection differed at all between "no such workspace", "not an
 * allowed sender", "over quota", "storage is broken" and "failed
 * authentication", then bouncing mail off the MX would enumerate every account
 * here, one guess at a time, from any mail client on earth.
 *
 * `describe("a rejection is one answer")` asserts that by *whole observable
 * effect* — the same discipline as `apps/convex/__tests__/controlPlane.test.ts`,
 * whose `responseFingerprint` compares status, every header and the body rather
 * than the body alone, because "that property dies the moment one path sets a
 * different header". The email equivalent of a response is everything the SMTP
 * peer can see, so the fingerprint here is: was it rejected, with exactly what
 * string, was anything forwarded, was anything replied.
 *
 * Every test in this file runs offline. `fetch` is stubbed to throw, so a stray
 * network call fails loudly rather than silently succeeding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmail, REFUSAL, type Env, type InboundMessage } from "./index";
import { R2Store } from "../../../apps/mcp/src/store/r2.js";
import { AUTHSERV, rawMessage, streamOf } from "./fixtures.test-helpers";

/* ------------------------------- the harness ------------------------------- */

const ENV: Env = {
  CONTROL_PLANE_URL: "https://control-plane.test",
  EMAIL_WORKER_SECRET: "not-a-real-secret",
  INGEST_DOMAIN: "context.lc",
  AUTH_SERVICE_ID: AUTHSERV,
  OPERATIONS_MAILBOX: "ops@example.com",
  MAX_MESSAGE_BYTES: "5000000",
  NATIVE_BINDINGS: "TEST_BUCKET",
};

/** An in-memory R2 binding, wrapped in the real adapter the Worker builds. */
function bucketStub(overrides: { failPut?: boolean; failGet?: boolean } = {}) {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      if (overrides.failGet) throw new Error("get failed");
      if (!objects.has(key)) return null;
      return { etag: "e1", text: async () => objects.get(key)! };
    },
    async put(key: string, value: string | Uint8Array) {
      if (overrides.failPut) throw new Error("put failed");
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
      return { etag: `e${objects.size}` };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  };
}

const RESOLUTION = {
  ticket: "ticket-1",
  context: { kind: "personal" as const, path: "seyi" },
  targetFolder: "0-inbox/",
  attachmentPolicy: "list",
  maxMessageBytes: 5_000_000,
  policy: {
    allowedSenders: ["alice@example.com"],
    allowedDomains: [],
    allowAnySender: false,
  },
};

const BINDING = {
  // The real `/gateway/binding` shape, unchanged: the workspace row IS the
  // context, and a personal context is a workspace with one owner member.
  workspaceId: "ws-1",
  provider: "r2-binding",
  bindingName: "TEST_BUCKET",
  capabilities: { conditionalWrite: true },
  status: "active",
};

interface Observed {
  rejected: string[];
  forwarded: string[];
}

function inbound(raw: Uint8Array, to = "seyi@context.lc", from = "alice@example.com") {
  const observed: Observed = { rejected: [], forwarded: [] };
  const message: InboundMessage = {
    to,
    from,
    raw: streamOf(raw),
    rawSize: raw.length,
    setReject(reason) {
      observed.rejected.push(reason);
    },
    async forward(rcptTo) {
      observed.forwarded.push(rcptTo);
    },
  };
  return { message, observed };
}

/**
 * Everything an SMTP peer can observe about how a message was handled.
 *
 * The email analogue of `responseFingerprint`. Two outcomes with the same
 * fingerprint are indistinguishable from outside — which is the property.
 */
function fingerprint(observed: Observed): string {
  return JSON.stringify({ rejected: observed.rejected, forwarded: observed.forwarded });
}

interface StubOptions {
  /**
   * Loosely typed on purpose. `IngestionResolution.context` is a union of one
   * (`{ kind: "personal" }`), so a shared context is not expressible in the
   * package's own types — which is the property. The tests still have to be
   * able to hand the handler one, to prove it refuses.
   */
  resolution?: Record<string, unknown> | null;
  binding?: Record<string, unknown> | null;
  resolveThrows?: boolean;
  bindingThrows?: boolean;
  recordThrows?: boolean;
}

/** The shape the handler needs, plus the call log the assertions read. */
type StubbedControlPlane = NonNullable<
  NonNullable<Parameters<typeof handleEmail>[2]>["controlPlane"]
> & { calls: string[] };

function controlPlaneStub(options: StubOptions = {}): StubbedControlPlane {
  const calls: string[] = [];
  return {
    calls,
    async resolveIngestion() {
      calls.push("resolve");
      if (options.resolveThrows) throw new Error("control plane down");
      return options.resolution === undefined ? RESOLUTION : options.resolution;
    },
    async getBinding() {
      calls.push("binding");
      if (options.bindingThrows) throw new Error("control plane down");
      return options.binding === undefined ? BINDING : options.binding;
    },
    async record() {
      calls.push("record");
      if (options.recordThrows) throw new Error("record failed");
    },
  } as unknown as StubbedControlPlane;
}

/**
 * Runs a message through the handler with the policy matcher forced on.
 *
 * ./policy.ts ships an unwired matcher that denies everything (deliberately —
 * an ingestion path whose only protection is a policy check must not run
 * without one). The suite injects a stand-in so the rest of the pipeline is
 * exercised; `describe("fail-closed")` below covers the unwired case itself.
 */
async function run(
  raw: Uint8Array,
  {
    env = ENV,
    to = "seyi@context.lc",
    from = "alice@example.com",
    bucket = bucketStub(),
    stub = {},
  }: {
    env?: Env;
    to?: string;
    from?: string;
    bucket?: ReturnType<typeof bucketStub>;
    stub?: StubOptions;
  } = {},
) {
  const { message, observed } = inbound(raw, to, from);
  const controlPlane = controlPlaneStub(stub);
  const fullEnv: Env = { ...env, TEST_BUCKET: bucket };
  let threw: unknown = null;
  try {
    await handleEmail(message, fullEnv, {
      controlPlane,
      now: () => new Date("2026-08-26T09:00:00.000Z"),
      nonce: () => "0123456789abcdef",
    });
  } catch (error) {
    threw = error;
  }
  return { observed, bucket, threw, controlPlane };
}

let fetchSpy: ReturnType<typeof vi.fn>;
let logs: string[];

beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("network access attempted");
  });
  vi.stubGlobal("fetch", fetchSpy);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* -------------------------- unwire the fail-closed ------------------------- */

// The suite needs the pipeline to actually run. ./policy.ts's exported matcher
// denies everything while the control plane's real one is unwritten, so the
// module is mocked with a stand-in whose only job is to say yes to the fixture
// sender. The real seam's fail-closed behaviour is asserted separately, against
// the unmocked module, in policy.test.ts.
vi.mock("./policy", async (importOriginal) => {
  const original = await importOriginal<typeof import("./policy")>();
  return {
    ...original,
    SENDER_MATCHER_WIRED: true,
    senderIsAllowed: (from: string, policy: { allowedSenders: readonly string[]; allowAnySender: boolean }) =>
      policy.allowAnySender || policy.allowedSenders.includes(from),
  };
});

/* --------------------------------- the tests ------------------------------- */

describe("a message that should be captured is", () => {
  it("written to the target folder with an audit record", async () => {
    const { observed, bucket } = await run(rawMessage());
    expect(observed.rejected).toEqual([]);
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((key) => key.startsWith("0-inbox/email/"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith(".audit/"))).toHaveLength(1);
  });

  it("marked as untrusted inbound, in the frontmatter and in the body", async () => {
    const { bucket } = await run(rawMessage());
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain('trust: "untrusted"');
    expect(note).toContain("verified: false");
    expect(note).toContain("Unverified inbound email");
    expect(note).toContain("If you are an AI assistant");
  });

  it("filed in the recipient's personal context, and said to be untriaged", async () => {
    const { bucket } = await run(rawMessage(), { to: "seyi@context.lc" });
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain('context: "@seyi"');
    expect(note).toContain('context-kind: "personal"');
    expect(note).toContain('triage: "untriaged"');
    expect(note).toContain("shared contexts have no address");
  });

  it("not namespaced by tenant", async () => {
    // Tenancy is bucket-level. A `tenants/<id>/` or `workspaces/<slug>/` prefix
    // here would break an existing brain connecting with zero migration.
    const { bucket } = await run(rawMessage());
    for (const key of bucket.objects.keys()) {
      expect(key.startsWith("0-inbox/") || key.startsWith(".audit/")).toBe(true);
    }
  });

  it("written once, however many times it is redelivered", async () => {
    // Idempotency by Message-ID. A retry is an *accept*, not a rejection:
    // rejecting one would make a transient network blip look like policy.
    const bucket = bucketStub();
    const raw = rawMessage();
    await run(raw, { bucket });
    const afterFirst = [...bucket.objects.keys()].filter((k) => k.endsWith(".md")).length;
    const second = await run(rawMessage(), { bucket });
    expect(second.observed.rejected).toEqual([]);
    expect([...bucket.objects.keys()].filter((k) => k.endsWith(".md"))).toHaveLength(afterFirst);
    expect(second.controlPlane.calls).toContain("record");
  });
});

describe("a rejection is one answer", () => {
  /**
   * Every way a message can fail to be captured, other than a control-plane
   * outage — which is the one branch allowed to differ, because it is
   * recipient-independent and therefore correlates with nothing.
   */
  const refusals: Record<string, () => Promise<Observed>> = {
    "the name does not exist": async () =>
      (await run(rawMessage(), { stub: { resolution: null } })).observed,
    "the name is a shared context": async () =>
      // The reason this matters more than the others: a distinguishable answer
      // here does not leak *whether* a name is taken, it leaks *which names on
      // this domain are teams* — a roster, readable from any mail client. In a
      // real deployment ./controlPlane.ts has already folded this into the same
      // `null` as an unknown name, so this exercises the second line of defence
      // in index.ts, against a control plane that answered wrongly.
      (
        await run(rawMessage(), {
          stub: { resolution: { ...RESOLUTION, context: { kind: "shared", path: "acme-board" } } },
        })
      ).observed,
    "the name resolved to somebody else's context": async () =>
      (
        await run(rawMessage(), {
          stub: { resolution: { ...RESOLUTION, context: { kind: "personal", path: "alice" } } },
        })
      ).observed,
    "the resolution named no context at all": async () =>
      (await run(rawMessage(), { stub: { resolution: { ...RESOLUTION, context: null } } }))
        .observed,
    "the name is reserved": async () =>
      (await run(rawMessage({ to: "support@context.lc" }), { to: "support@context.lc" })).observed,
    "the name is malformed": async () =>
      (await run(rawMessage(), { to: "a@context.lc" })).observed,
    "the domain is not ours": async () =>
      (await run(rawMessage(), { to: "seyi@example.net" })).observed,
    "the sender is not allowed": async () =>
      (await run(rawMessage({ from: "stranger@example.net" }), { from: "stranger@example.net" }))
        .observed,
    "the message failed authentication": async () =>
      (await run(rawMessage({ authResults: null }))).observed,
    "the From: was spoofed": async () =>
      (
        await run(
          rawMessage({
            from: "alice@example.com",
            authResults: [`${AUTHSERV}; dmarc=pass header.from=evil.test`],
          }),
        )
      ).observed,
    "the workspace is over quota": async () =>
      // Indistinguishable by construction: the control plane collapses quota
      // into the same `{ ingestion: null }` as an unknown name.
      (await run(rawMessage(), { stub: { resolution: null } })).observed,
    "storage is not bound": async () =>
      (await run(rawMessage(), { stub: { binding: null } })).observed,
    "storage is misconfigured": async () =>
      (
        await run(rawMessage(), {
          stub: { binding: { ...BINDING, bindingName: "NOT_ALLOWED" } },
        })
      ).observed,
    "storage is inactive": async () =>
      (await run(rawMessage(), { stub: { binding: { ...BINDING, status: "pending" } } })).observed,
    "the write failed": async () =>
      (await run(rawMessage(), { bucket: bucketStub({ failPut: true }) })).observed,
    "the read failed": async () =>
      (await run(rawMessage(), { bucket: bucketStub({ failGet: true }) })).observed,
    "the credential call failed": async () =>
      (await run(rawMessage(), { stub: { bindingThrows: true } })).observed,
    "the message is too large": async () => {
      const raw = rawMessage();
      const { message, observed } = inbound(raw);
      await handleEmail({ ...message, rawSize: 99_000_000 }, { ...ENV, TEST_BUCKET: bucketStub() }, {
        controlPlane: controlPlaneStub(),
      });
      return observed;
    },
    "the message is empty": async () =>
      (await run(rawMessage({ body: "  \r\n " }))).observed,
    "the target folder is unusable": async () =>
      (
        await run(rawMessage(), {
          stub: { resolution: { ...RESOLUTION, targetFolder: "../escape" } },
        })
      ).observed,
    "the message is unparseable": async () =>
      (await run(new Uint8Array(0))).observed,
  };

  it("refuses each of them, with one frozen string", async () => {
    for (const [name, produce] of Object.entries(refusals)) {
      const observed = await produce();
      expect(observed.rejected, name).toEqual([REFUSAL]);
      expect(observed.forwarded, name).toEqual([]);
    }
  });

  it("produces one identical fingerprint for every one of them", async () => {
    // The load-bearing assertion. Sabotage: interpolate anything — the local
    // part, the reason, a retry hint — into `setReject` and this fails.
    const seen = new Map<string, string[]>();
    for (const [name, produce] of Object.entries(refusals)) {
      const key = fingerprint(await produce());
      seen.set(key, [...(seen.get(key) ?? []), name]);
    }
    expect([...seen.keys()]).toHaveLength(1);
    expect([...seen.values()][0]).toHaveLength(Object.keys(refusals).length);
  });

  it("is not vacuous: a capture has a different fingerprint", async () => {
    // Without this, a bug that rejected *everything* would pass the test above.
    const captured = await run(rawMessage());
    expect(fingerprint(captured.observed)).not.toBe(
      fingerprint((await run(rawMessage(), { stub: { resolution: null } })).observed),
    );
    expect(captured.bucket.objects.size).toBeGreaterThan(0);
  });

  it("does not fetch a credential for a message it is going to refuse", async () => {
    // Not observable to the sender, but it is the difference between "an
    // attacker can make us decrypt a customer's storage key by sending mail"
    // and "they cannot". Sabotage: fetch the binding before the policy check.
    for (const stub of [{}, {}]) {
      const { controlPlane } = await run(rawMessage({ from: "stranger@example.net" }), {
        from: "stranger@example.net",
        stub,
      });
      expect(controlPlane.calls).toEqual(["resolve"]);
    }
    const authFailed = await run(rawMessage({ authResults: null }));
    expect(authFailed.controlPlane.calls).toEqual(["resolve"]);

    // And least of all for a context it must never write to. The check has to
    // sit above the binding call, or a control plane bug turns into a decrypted
    // credential for a shared context.
    const shared = await run(rawMessage(), {
      stub: { resolution: { ...RESOLUTION, context: { kind: "shared", path: "acme-board" } } },
    });
    expect(shared.controlPlane.calls).toEqual(["resolve"]);
    expect(shared.bucket.objects.size).toBe(0);
  });

  it("is refusing the shared context for the reason it looks like, not by accident", async () => {
    // The fingerprint test above would pass just as happily if this message
    // died somewhere unrelated. The log is the only place the *reason* is
    // visible — deliberately, since it must never be visible to the sender.
    await run(rawMessage(), {
      stub: { resolution: { ...RESOLUTION, context: { kind: "shared", path: "acme-board" } } },
    });
    expect(logs.join("\n")).toContain("not_a_personal_context");
    // And the name of the shared context is not in there either. Logging it
    // would move the roster from the SMTP channel into a log aggregator.
    expect(logs.join("\n")).not.toContain("acme-board");
  });
});

describe("the one branch that may differ", () => {
  it("rethrows when the control plane is unreachable", async () => {
    // Recipient-independent: resolution happens for every well-formed address
    // alike, so a distinguishable outcome here correlates with nothing about
    // who exists. Rethrowing lets the runtime apply its own handling rather
    // than burning a real message on our downtime.
    const { threw, observed } = await run(rawMessage(), { stub: { resolveThrows: true } });
    expect(threw).toBeInstanceOf(Error);
    expect(observed.rejected).toEqual([]);
  });

  it("does not rethrow once a workspace has been resolved", async () => {
    // After resolution, a failure *is* recipient-dependent, so it collapses
    // into the frozen refusal like everything else. Sabotage: let the binding
    // call rethrow too, and a prober learns which names resolved.
    const { threw, observed } = await run(rawMessage(), { stub: { bindingThrows: true } });
    expect(threw).toBeNull();
    expect(observed.rejected).toEqual([REFUSAL]);
  });
});

describe("RFC 2142's mandatory mailboxes", () => {
  it("forwards postmaster and abuse instead of ingesting them", async () => {
    for (const name of ["postmaster", "abuse"]) {
      const { observed, bucket, controlPlane } = await run(rawMessage(), {
        to: `${name}@context.lc`,
      });
      expect(observed.forwarded).toEqual(["ops@example.com"]);
      expect(observed.rejected).toEqual([]);
      // They never enter the ingestion path at all.
      expect(controlPlane.calls).toEqual([]);
      expect(bucket.objects.size).toBe(0);
    }
  });

  it("refuses, loudly, when no operations mailbox is configured", async () => {
    const { observed } = await run(rawMessage(), {
      to: "postmaster@context.lc",
      env: { ...ENV, OPERATIONS_MAILBOX: "" },
    });
    expect(observed.rejected).toEqual([REFUSAL]);
    expect(logs.join("\n")).toContain("operations_mailbox_unset");
  });
});

describe("nothing about a message reaches the logs", () => {
  const SECRETS = {
    subject: "Quarterly numbers and the acquisition",
    body: "The wire went to account 12345678 at Example Bank.",
    filename: "board-minutes.pdf",
  };

  it("logs no subject, no body, no sender and no attachment name", async () => {
    // Structured logs carry request/workspace identifiers, never content.
    // Sabotage: add `subject` to the `log()` call in index.ts and this fails.
    const raw = new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        `Subject: ${SECRETS.subject}`,
        "Message-ID: <secret@example.com>",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        SECRETS.body,
        "--b",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment; filename="${SECRETS.filename}"`,
        "",
        "bytes",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const { observed, bucket } = await run(raw);
    expect(observed.rejected).toEqual([]);
    expect(bucket.objects.size).toBeGreaterThan(0);

    const written = logs.join("\n");
    expect(written).not.toContain(SECRETS.subject);
    expect(written).not.toContain(SECRETS.body);
    expect(written).not.toContain(SECRETS.filename);
    expect(written).not.toContain("alice@example.com");
    expect(written).not.toContain("ticket-1");
    expect(written).not.toContain(ENV.EMAIL_WORKER_SECRET!);
    // And it does say something useful.
    expect(written).toContain('"event":"captured"');
  });

  it("logs no content on a refusal either", async () => {
    const raw = rawMessage({ subject: SECRETS.subject, body: SECRETS.body, authResults: null });
    await run(raw);
    const written = logs.join("\n");
    expect(written).not.toContain(SECRETS.subject);
    expect(written).not.toContain(SECRETS.body);
    expect(written).toContain('"event":"refused"');
  });
});

describe("the suite cannot reach the network", () => {
  it("never calls fetch", async () => {
    await run(rawMessage());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the store the Worker builds is the gateway's adapter", () => {
  it("refuses a key the adapter refuses", async () => {
    // Not a behaviour test so much as a wiring one: the same `assertSafeKey`
    // that guards the gateway guards this Worker, because it is the same code.
    const store = new R2Store(bucketStub() as unknown as R2Bucket);
    await expect(store.put("../escape.md", "x")).rejects.toThrow(/unsafe storage key/);
  });
});
