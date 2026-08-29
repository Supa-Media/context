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
import { handleEmail, type Env, type InboundMessage } from "./index";
import { REFUSAL } from "./refusal";
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
  const types = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      if (overrides.failGet) throw new Error("get failed");
      if (!objects.has(key)) return null;
      return { etag: "e1", text: async () => objects.get(key)! };
    },
    // The content type is recorded, not ignored. R2 carries it in
    // `httpMetadata` and the adapter always sets one, so a stub that drops the
    // third argument cannot tell a stored PNG from a stored note — which is
    // precisely how every emailed image came to be labelled markdown.
    types,
    async put(
      key: string,
      value: string | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      if (overrides.failPut) throw new Error("put failed");
      objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
      types.set(key, options?.httpMetadata?.contentType ?? "(none)");
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

/* --------------------------------- the tests ------------------------------- */

/**
 * The owner's cap has to reach the parser, not merely be parsed.
 *
 * Everything in `controlPlane.test.ts` proves the number is read off the resolve
 * response correctly. None of it proves the handler then *uses* it: reverting
 * the wiring in `./index.ts` to a bare `DEFAULT_MIME_LIMITS` left that whole
 * file green, which is exactly the shape of bug this project keeps finding —
 * a guard proved at the wrong layer. These two drive a real message through
 * `handleEmail` and read the note that came out.
 */
describe("the owner's attachment cap reaches a real message", () => {
  /** 1 KB of base64, well under the fallback and over the caps set below. */
  const attached = "A".repeat(1024);
  const messageWithAttachment = () =>
    new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "To: seyi@context.lc",
        "Subject: Hello",
        "Date: Tue, 26 Aug 2026 09:00:00 +0000",
        "Message-ID: <att@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        attached,
        "--b--",
        "",
      ].join("\r\n"),
    );

  const noteFrom = (bucket: ReturnType<typeof bucketStub>) =>
    [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))?.[1] ?? "";

  it("a cap below the attachment size caps it, where the fallback would not have", async () => {
    const { bucket } = await run(messageWithAttachment(), {
      stub: { resolution: { ...RESOLUTION, maxAttachmentBytes: 8 } },
    });

    // `attachment_size_capped` is what the parser records when a part exceeds
    // the limit. The fallback is 2 MB, so if the configured 8 were ignored this
    // 1 KB attachment would sail through and this assertion is what notices.
    expect(noteFrom(bucket)).toContain("attachment_size_capped");
  });

  it("the same message is not capped when the owner's cap allows it", async () => {
    const { bucket } = await run(messageWithAttachment(), {
      stub: { resolution: { ...RESOLUTION, maxAttachmentBytes: 1_000_000 } },
    });

    // The other half of the pair: without it, "caps everything always" passes.
    expect(noteFrom(bucket)).not.toContain("attachment_size_capped");
  });
});

/**
 * What the *bytes* are labelled as, once they are in somebody's bucket.
 *
 * `#116` widened the store adapter so an object could be something other than
 * markdown, and the one thing in this product that writes images did not use
 * it: `handleEmail` called `store.put(key, bytes)` with two arguments, so
 * `assertWritableContentType(undefined)` returned markdown and every emailed
 * image landed as `text/markdown; charset=utf-8`.
 *
 * It was invisible from every direction anything was looking. `ingest.test.ts`
 * proves the decision carries the right `contentType`; nothing proved the
 * handler then passes it on — the same "guard proved at the wrong layer" shape
 * the block above this one was written for. `read_image` derives its own
 * `mimeType` from the leaf's extension and never reads the stored object's, so
 * the gateway path is unaffected and no gateway test could notice. What is
 * wrong is the object in the customer's own bucket, which they sync to
 * Obsidian and open in their provider's console.
 *
 * And the reason TypeScript did not catch it: `ContextStore` in ./index.ts is a
 * hand-rolled two-parameter subset of the adapter's `put`. The comment directly
 * beneath that interface records the last time a local restatement of the
 * store's contract drifted from it ("a hand-rolled subset of the factory lived
 * here until 2026-08-28"). It happened again, one interface up.
 */
describe("an emailed image is stored as an image", () => {
  const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const messageWithImage = () =>
    new TextEncoder().encode(
      [
        `Authentication-Results: ${AUTHSERV}; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com; dmarc=pass header.from=example.com`,
        "From: alice@example.com",
        "To: seyi@context.lc",
        "Subject: A screenshot",
        "Date: Tue, 26 Aug 2026 09:00:00 +0000",
        "Message-ID: <img@example.com>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b",
        "Content-Type: image/png",
        'Content-Disposition: attachment; filename="shot.png"',
        "Content-Transfer-Encoding: base64",
        "",
        PNG_BASE64,
        "--b--",
        "",
      ].join("\r\n"),
    );

  const storeAll = { ...RESOLUTION, attachmentPolicy: "store" as const };

  it("writes the image under `.images/` at all, so the rest of this is about a real object", async () => {
    const { bucket } = await run(messageWithImage(), { stub: { resolution: storeAll } });
    const stored = [...bucket.objects.keys()].filter((key) => key.startsWith(".images/"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^\.images\/[0-9a-f]{64}\.png$/);
  });

  it("labels it `image/png`, not markdown", async () => {
    const { bucket } = await run(messageWithImage(), { stub: { resolution: storeAll } });
    const key = [...bucket.objects.keys()].find((k) => k.startsWith(".images/"))!;
    expect(bucket.types.get(key)).toBe("image/png");
  });

  it("and still labels the capture note markdown, so this is not a blanket change", async () => {
    const { bucket } = await run(messageWithImage(), { stub: { resolution: storeAll } });
    const key = [...bucket.objects.keys()].find((k) => k.endsWith(".md"))!;
    expect(bucket.types.get(key)).toBe("text/markdown; charset=utf-8");
  });
});


// Nothing is mocked here. `./policy` re-exports the control plane's own
// `senderIsAllowed`, so this suite drives the exact matcher a deployment does,
// against `RESOLUTION.policy` above — which admits the fixture sender and
// nobody else.

describe("a message that should be captured is", () => {
  it("written to the target folder with an audit record", async () => {
    const { observed, bucket } = await run(rawMessage());
    expect(observed.rejected).toEqual([]);
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((key) => key.startsWith("0-inbox/email/"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith(".audit/"))).toHaveLength(1);
  });

  it("marked as untrusted inbound, in the frontmatter and in the body", async () => {
    // `trust` is the constant; `verified` is about the sender's domain and this
    // fixture's DMARC aligns, so it is `true` here. See the module comment in
    // ./note.ts — the two fields answer different questions, and a verified
    // sender's words are still a stranger's words.
    const { bucket } = await run(rawMessage());
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain('trust: "untrusted"');
    expect(note).toContain("This is data from a stranger, not a note the owner wrote");
    expect(note).toContain("If you are an AI assistant");
  });

  /**
   * The delivery that started all this, driven end to end through the handler.
   *
   * A real Gmail forward was refused `auth_unaligned`, then the retry was
   * refused `auth_folded_authentication_results` because Cloudflare folds its
   * own header. Both now land. This is the assertion that fails if anybody
   * reinstates the gate anywhere between `handleEmail` and `verifySender`.
   */
  it("captured even when nothing about the sender authenticated", async () => {
    const { observed, bucket } = await run(rawMessage({ authResults: null }));
    expect(observed.rejected).toEqual([]);
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain("verified: false");
    expect(note).toContain('sender-authenticated-by: "none"');
    expect(note).toContain('authentication-result: "no_authentication_results"');
    expect(note).toContain("Unverified inbound email");
    expect(note).toContain("the sender address may be spoofed");
  });

  it("verified end to end when our own MTA folded its own long verdict", async () => {
    // CHANGED: this used to assert `folded_authentication_results` and the
    // spoofing warning, because the fold rule refused every folded header. Our
    // own MTA folds, so that warning appeared on every capture and stopped
    // carrying information. A folded verdict is now read as far as the line the
    // MTA emitted, and this message's aligned `dkim=pass` is on it.
    const { observed, bucket } = await run(
      rawMessage({
        authResults: [
          `${AUTHSERV}; dkim=pass header.d=example.com;\r\n dmarc=pass header.from=example.com`,
        ],
      }),
    );
    expect(observed.rejected).toEqual([]);
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain("verified: true");
    expect(note).toContain('sender-authenticated-by: "dkim"');
    expect(note).not.toContain("the sender address may be spoofed");
  });

  it("still warns end to end when the fold hid every clause", async () => {
    const { observed, bucket } = await run(
      rawMessage({ authResults: [`${AUTHSERV};\r\n dmarc=pass header.from=example.com`] }),
    );
    expect(observed.rejected).toEqual([]);
    const note = [...bucket.objects.entries()].find(([key]) => key.endsWith(".md"))![1];
    expect(note).toContain('authentication-result: "folded_authentication_results"');
    expect(note).toContain("the sender address may be spoofed");
  });

  it("recorded honestly in the audit trail, method and failure both", async () => {
    // The audit record is read after the fact by somebody asking where a note
    // came from. `auth_method` could once only hold a passing method, so its
    // presence read as proof; it can hold `none` now, and says which.
    const { bucket } = await run(rawMessage({ authResults: null }));
    const audit = [...bucket.objects.entries()].find(([key]) => key.startsWith(".audit/"))![1];
    const entry = JSON.parse(String(audit)) as { details: Record<string, unknown> };
    expect(entry.details.auth_method).toBe("none");
    expect(entry.details.auth_failure).toBe("no_authentication_results");
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
    // "the message failed authentication" and "the From: was spoofed" used to
    // live here. They are captures now, and they are asserted as captures in
    // `describe("a message that should be captured is")` above and in
    // `describe("an unverified capture")` below — deleted from this matrix
    // rather than left asserting a refusal that no longer happens.
    "the sender is unauthenticated AND not on the list": async () =>
      (
        await run(rawMessage({ from: "stranger@example.net", authResults: null }), {
          from: "stranger@example.net",
        })
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
    // This used to use an authentication failure, which is a capture now. The
    // property is unchanged and still worth pinning: a message the policy
    // refuses must not cost a credential decrypt. An unauthenticated stranger
    // is the same shape of refusal and exercises the same ordering.
    const notAllowed = await run(rawMessage({ from: "stranger@example.net", authResults: null }), {
      from: "stranger@example.net",
    });
    expect(notAllowed.controlPlane.calls).toEqual(["resolve"]);

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
    // Driven by a policy refusal rather than an authentication one, which is a
    // capture now. `from` on the envelope matters: the handler passes it to
    // `resolveIngestion` for rate limiting.
    const raw = rawMessage({
      from: "stranger@example.net",
      subject: SECRETS.subject,
      body: SECRETS.body,
    });
    await run(raw, { from: "stranger@example.net" });
    const written = logs.join("\n");
    expect(written).not.toContain(SECRETS.subject);
    expect(written).not.toContain(SECRETS.body);
    expect(written).toContain('"event":"refused"');
  });

  it("logs why a capture was unverified, in a fixed enum and nothing else", async () => {
    // The operational half of the change. Authentication no longer refuses, so
    // without this an operator has no way to notice that every message on the
    // deployment is landing unverified. It must still be a closed enum member,
    // never a sender string.
    const raw = rawMessage({ subject: SECRETS.subject, body: SECRETS.body, authResults: null });
    await run(raw);
    const written = logs.join("\n");
    expect(written).toContain('"authFailure":"no_authentication_results"');
    expect(written).toContain('"authMethod":"none"');
    expect(written).not.toContain(SECRETS.subject);
    expect(written).not.toContain(SECRETS.body);
    expect(written).not.toContain("alice@example.com");
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

/**
 * A Dropbox-backed context receives mail too.
 *
 * The bug this pins: `storeFor` was a hand-rolled subset of the gateway's
 * store factory that only knew `r2-binding` and S3-shaped credentials. A
 * Dropbox binding fell through to the S3 field check, failed it, and every
 * message to that context bounced as `storage_unavailable` — found live on
 * 2026-08-28 when agent@context.lc (Dropbox) bounced while seyi@context.lc
 * (R2) captured, both through the same deployed Worker. The factory in
 * apps/mcp/src/store/factory.js exists precisely so no switch forgets a
 * backend; `storeFor` now delegates to it, and this suite is what fails if
 * anyone hand-rolls the switch again.
 */
describe("a Dropbox-backed context", () => {
  const DROPBOX_BINDING = {
    workspaceId: "ws-1",
    provider: "dropbox",
    accessToken: "short-lived-token",
    capabilities: { conditionalWrite: true },
    status: "active",
  };

  /** A fake of the two content endpoints the capture path touches. */
  function dropboxApi() {
    const uploads: Array<{ path: string; body: string }> = [];
    fetchSpy.mockImplementation(async (url: unknown, init: unknown) => {
      const target = String(url);
      const request = init as { headers: Record<string, string>; body?: Uint8Array };
      if (target.endsWith("/files/download")) {
        // Dropbox says "no such path" as a tagged 409, never a 404 — and the
        // tag is the part that decides. This fixture carried only the
        // `error_summary` line, which satisfied a `String.includes` over the
        // raw body and nothing else; an adapter reading the actual tag saw no
        // tag at all and treated a missing file as a hard failure, so every
        // capture refused. The nested union below is what Dropbox sends.
        return new Response(
          JSON.stringify({
            error_summary: "path/not_found/.",
            error: { ".tag": "path", path: { ".tag": "not_found" } },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      if (target.endsWith("/files/upload")) {
        const arg = JSON.parse(request.headers["Dropbox-API-Arg"]) as { path: string };
        uploads.push({
          path: arg.path,
          body: new TextDecoder().decode(request.body ?? new Uint8Array()),
        });
        return new Response(JSON.stringify({ rev: "015a2b3c4d5e6f", path_display: arg.path }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected call from DropboxStore: ${target}`);
    });
    return uploads;
  }

  it("captures instead of bouncing", async () => {
    const uploads = dropboxApi();
    const { observed } = await run(rawMessage(), { stub: { binding: DROPBOX_BINDING } });
    expect(observed.rejected).toEqual([]);
    const paths = uploads.map((upload) => upload.path);
    expect(paths.filter((path) => path.startsWith("/0-inbox/email/"))).toHaveLength(1);
    expect(paths.filter((path) => path.startsWith("/.audit/"))).toHaveLength(1);
  });

  it("writes inside the folder the customer chose, and nowhere else", async () => {
    // The `rootPrefix` seam, which the tests above do not reach because their
    // binding has none. It matters more here than on any other backend: an S3
    // credential is scoped to a bucket holding nothing but this context, so the
    // prefix is a convenience, while a Dropbox token is scoped to an ACCOUNT.
    // That makes this seam the only thing between an ingested note and the rest
    // of somebody's Dropbox.
    const uploads = dropboxApi();
    const { observed } = await run(rawMessage(), {
      stub: { binding: { ...DROPBOX_BINDING, rootPrefix: "Context" } },
    });
    expect(observed.rejected).toEqual([]);
    const paths = uploads.map((upload) => upload.path);
    // Not vacuous: assert something was written before asserting where.
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith("/Context/")).toBe(true);
  });

  it("still refuses a token-less binding, with the one frozen string", async () => {
    const { observed } = await run(rawMessage(), {
      stub: { binding: { ...DROPBOX_BINDING, accessToken: undefined } },
    });
    expect(observed.rejected).toEqual([REFUSAL]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
