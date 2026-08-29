/**
 * The control-plane client, and the one rule that only exists here.
 *
 * ============================================================================
 * A SHARED CONTEXT IS FOLDED INTO `null` BEFORE ANYONE CAN BRANCH ON IT
 * ============================================================================
 *
 * `index.ts` treats a resolve *failure* differently from a resolve *`null`*:
 * a failure rethrows (a control-plane outage is recipient-independent, so a
 * distinguishable outcome correlates with nothing), while a `null` becomes the
 * frozen 550. That asymmetry is correct, and it is exactly why the shared-
 * context case has to be settled in this file rather than passed upwards.
 *
 * If a non-personal answer arrived as a thrown `ControlPlaneError`, then
 * mailing `acme-board@context.lc` would produce whatever the runtime does with
 * an exception, and mailing `nobody-at-all@context.lc` would produce a 550 —
 * and anyone with a mail client could read off which names on this domain are
 * teams. So it is folded into the *same* `null` here, at the parser, before the
 * handler ever sees a difference to act on.
 *
 * The line the tests below draw is precise, and it is the only place in the
 * package where "throw" and "null" mean genuinely different things:
 *
 *   - the `context` **key is missing**  → throw. Nobody has a `context`; this
 *     is a control plane that does not implement the contract, true for every
 *     recipient alike, and it should be loud.
 *   - the `context` **value is not this user's personal one** → `null`. This
 *     varies per recipient, so it must be indistinguishable.
 *
 * Every test here runs offline against a stubbed `fetch`.
 */
import { describe, expect, it, test, vi } from "vitest";
import {
  assertPersonalContext,
  ControlPlaneError,
  createIngestControlPlane,
  type ControlPlaneEnv,
} from "./controlPlane";
import { DEFAULT_MIME_LIMITS, MAX_ATTACHMENT_BYTES_HARD_CAP } from "./mime";

const ENV: ControlPlaneEnv = {
  CONTROL_PLANE_URL: "https://control-plane.test",
  EMAIL_WORKER_SECRET: "not-a-real-secret",
};

const PERSONAL = { kind: "personal", path: "seyi" };

function ingestion(overrides: Record<string, unknown> = {}) {
  return {
    ticket: "ticket-1",
    context: PERSONAL,
    targetFolder: "0-inbox/",
    attachmentPolicy: "list",
    maxMessageBytes: 5_000_000,
    policy: { allowedSenders: ["alice@example.com"], allowedDomains: [], allowAnySender: false },
    ...overrides,
  };
}

/** Records what was sent, answers with whatever the test names. */
function stubFetch(payload: unknown) {
  const sent: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function client(payload: unknown) {
  const { sent, fetchImpl } = stubFetch(payload);
  return { sent, plane: createIngestControlPlane(ENV, { fetchImpl }) };
}

/**
 * The per-attachment cap is the owner's, not the worker's.
 *
 * `DEFAULT_MIME_LIMITS` is a floor to fall back to when the control plane says
 * nothing — a deployment that ignored the configured value would make the
 * console's attachment setting decorative in the direction that matters,
 * writing more of a stranger's bytes into the customer's bucket than they
 * agreed to.
 */
describe("the attachment size cap", () => {
  test("an owner's cap is read from the resolve response", async () => {
    const { plane } = client({ ingestion: ingestion({ maxAttachmentBytes: 1_234_567 }) });

    const resolved = await plane.resolveIngestion("seyi", 4096, "alice@example.com");

    expect(resolved?.maxAttachmentBytes).toBe(1_234_567);
  });

  test("a control plane that says nothing falls back to the worker's own limit", async () => {
    const { plane } = client({ ingestion: ingestion() });

    const resolved = await plane.resolveIngestion("seyi", 4096, "alice@example.com");

    expect(resolved?.maxAttachmentBytes).toBe(DEFAULT_MIME_LIMITS.maxAttachmentBytes);
  });

  test("an owner may raise the cap above the fallback, up to the hard ceiling", async () => {
    // The fallback is what a worker uses when nobody has said anything; it is
    // not a ceiling. Clamping the owner's value to it would make the setting
    // able only to lower, so a console offering 5 MB would quietly deliver 2.
    const { plane } = client({
      ingestion: ingestion({ maxAttachmentBytes: MAX_ATTACHMENT_BYTES_HARD_CAP }),
    });

    const resolved = await plane.resolveIngestion("seyi", 4096, "alice@example.com");

    expect(MAX_ATTACHMENT_BYTES_HARD_CAP).toBeGreaterThan(
      DEFAULT_MIME_LIMITS.maxAttachmentBytes,
    );
    expect(resolved?.maxAttachmentBytes).toBe(MAX_ATTACHMENT_BYTES_HARD_CAP);
  });

  test("a cap beyond the worker's hard ceiling is clamped, not honoured", async () => {
    // The control plane validates this too, and the worker does not take that
    // on faith: this is the allocation that actually happens, so a wrong or
    // compromised control-plane answer must not turn one message into an
    // unbounded buffer here.
    const { plane } = client({
      ingestion: ingestion({ maxAttachmentBytes: MAX_ATTACHMENT_BYTES_HARD_CAP * 100 }),
    });

    const resolved = await plane.resolveIngestion("seyi", 4096, "alice@example.com");

    expect(resolved?.maxAttachmentBytes).toBe(MAX_ATTACHMENT_BYTES_HARD_CAP);
  });

  test("a nonsense cap is refused rather than trusted", async () => {
    for (const bad of [0, -1, "2000000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { plane } = client({ ingestion: ingestion({ maxAttachmentBytes: bad }) });

      const resolved = await plane.resolveIngestion("seyi", 4096, "alice@example.com");

      // Fail to the worker's own floor, never to "unbounded".
      expect(resolved?.maxAttachmentBytes).toBe(DEFAULT_MIME_LIMITS.maxAttachmentBytes);
    }
  });
});

/* --------------------------- what goes over the wire ----------------------- */

describe("the request cannot name a context", () => {
  it("sends a username and two rate-limiting values, and nothing else", async () => {
    // The load-bearing one. This is not "the control plane rejects a request
    // that names a context" — it is "there is no field in which to name one".
    // Sabotage: add a `workspaceId`, a `slug`, or a `path` here for some future
    // convenience and this fails, which is the point at which somebody has to
    // argue for it.
    const { sent, plane } = client({ ingestion: ingestion() });
    await plane.resolveIngestion("seyi", 1234, "alice@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://control-plane.test/gateway/ingest/resolve");
    expect(sent[0]!.body).toEqual({
      username: "seyi",
      sizeBytes: 1234,
      envelopeFrom: "alice@example.com",
    });
  });

  it("asks for a credential with a ticket and nothing else", async () => {
    const { sent, plane } = client({ binding: { status: "active" } });
    await plane.getBinding("ticket-1");
    expect(sent[0]!.url).toBe("https://control-plane.test/gateway/ingest/binding");
    expect(sent[0]!.body).toEqual({ ticket: "ticket-1" });
  });

  it("carries its own secret, not the gateway's", async () => {
    const { sent, plane } = client({ ingestion: null });
    await plane.resolveIngestion("seyi", 1, "a@b.test");
    expect(sent[0]!.headers.Authorization).toBe("Bearer not-a-real-secret");
  });
});

/* -------------------------- the personal-only fold ------------------------- */

describe("anything that is not this user's personal context becomes null", () => {
  const nonPersonal: Record<string, unknown> = {
    "a shared context": { kind: "shared", path: "acme-board" },
    "a shared context wearing the right path": { kind: "shared", path: "seyi" },
    "somebody else's personal context": { kind: "personal", path: "alice" },
    "a personal context with no path": { kind: "personal", path: "" },
    "a personal context with a non-string path": { kind: "personal", path: 7 },
    "a kind nobody has heard of": { kind: "team", path: "seyi" },
    "a missing kind": { path: "seyi" },
    "a null context": null,
    "an array": [{ kind: "personal", path: "seyi" }],
    "a string": "personal",
    "a near-miss on the literal": { kind: "Personal", path: "seyi" },
  };

  it.each(Object.entries(nonPersonal))("%s resolves to null", async (_name, context) => {
    const { plane } = client({ ingestion: ingestion({ context }) });
    await expect(plane.resolveIngestion("seyi", 1, "a@b.test")).resolves.toBeNull();
  });

  it("is the same null an unknown name produces", async () => {
    // Not "also null" — the *same* value, arrived at by the same return. There
    // is nothing for `index.ts` to tell apart, so there is nothing it could
    // leak. Sabotage: return a `{ refused: "shared" }` marker for the shared
    // case, even one only the logs read, and the two stop being one answer.
    const unknown = await client({ ingestion: null }).plane.resolveIngestion("nobody", 1, "a@b.t");
    const shared = await client({
      ingestion: ingestion({ context: { kind: "shared", path: "acme-board" } }),
    }).plane.resolveIngestion("acme-board", 1, "a@b.t");
    expect(unknown).toBeNull();
    expect(shared).toBeNull();
    expect(shared).toBe(unknown);
  });

  it("does not throw, because a throw is observably different", async () => {
    // `index.ts` rethrows a resolve failure and lets the runtime handle it,
    // but turns a null into the frozen 550. Throwing here would therefore make
    // "that name is a team" the one refusal in the whole Worker that looks
    // different from every other.
    const { plane } = client({
      ingestion: ingestion({ context: { kind: "shared", path: "acme-board" } }),
    });
    await expect(plane.resolveIngestion("acme-board", 1, "a@b.test")).resolves.toBeNull();
  });

  it("accepts the one shape it is supposed to", async () => {
    // Guards against the fold above being vacuously true.
    const { plane } = client({ ingestion: ingestion() });
    const resolved = await plane.resolveIngestion("seyi", 1, "a@b.test");
    expect(resolved).not.toBeNull();
    expect(resolved!.context).toEqual({ kind: "personal", path: "seyi" });
    expect(resolved!.ticket).toBe("ticket-1");
  });
});

describe("a control plane that does not implement the contract is loud", () => {
  it("throws when the context key is absent entirely", async () => {
    // The one non-fold. A missing key is a version skew — no recipient has a
    // `context` — so it is recipient-*independent*, correlates with nothing,
    // and deserves to be seen rather than silently swallowed as "no such name".
    const payload = ingestion();
    delete (payload as Record<string, unknown>).context;
    const { plane } = client({ ingestion: payload });
    await expect(plane.resolveIngestion("seyi", 1, "a@b.test")).rejects.toThrow(ControlPlaneError);
  });

  it("still throws on the malformations it threw on before", async () => {
    for (const payload of [{ ingestion: ingestion({ ticket: "" }) }, { ingestion: ingestion({ policy: null }) }, {}]) {
      const { plane } = client(payload);
      await expect(plane.resolveIngestion("seyi", 1, "a@b.test")).rejects.toThrow(
        ControlPlaneError,
      );
    }
  });

  it("never puts the secret or the response body in the error", async () => {
    const { plane } = client({});
    await expect(plane.resolveIngestion("seyi", 1, "a@b.test")).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes("not-a-real-secret"),
    );
  });
});

/* ------------------------------ the bare check ----------------------------- */

describe("assertPersonalContext", () => {
  it("requires the literal kind and the exact name that was asked about", () => {
    expect(assertPersonalContext({ kind: "personal", path: "seyi" }, "seyi")).toBe(true);
    expect(assertPersonalContext({ kind: "personal", path: "alice" }, "seyi")).toBe(false);
    expect(assertPersonalContext(null, "seyi")).toBe(false);
    expect(assertPersonalContext(undefined, "seyi")).toBe(false);
  });

  it("does not accept a path that merely contains the username", () => {
    // The same class of mistake as a suffix test on a domain in ./policy.ts:
    // `endsWith`/`includes` on a name is how `evil-seyi` becomes `seyi`.
    for (const path of ["seyi ", " seyi", "seyi/", "@seyi", "seyi2", "not-seyi", "SEYI"]) {
      expect(
        assertPersonalContext({ kind: "personal", path }, "seyi"),
        path,
      ).toBe(false);
    }
  });
});
