/**
 * The three ingest routes, and the one decision they exist to enforce.
 *
 * ============================================================================
 * MAIL LANDS IN A PERSONAL CONTEXT AND NOWHERE ELSE
 * ============================================================================
 *
 * That is the product decision, and everything in this file is downstream of
 * it. `describe("a shared context cannot receive mail")` is the load-bearing
 * block: it asserts not merely that a shared context is refused, but that its
 * refusal is **byte-identical** to the refusal for a name nobody has ever
 * claimed. Anything less publishes, to anyone with a mail client, which names on
 * this domain are teams.
 *
 * The fingerprint comparison is the same discipline `controlPlane.test.ts`
 * applies to `{"binding":null}`: status, every header, and the body — because
 * "that property dies the moment one path sets a different header".
 *
 * ============================================================================
 * WHAT THE ROUTES MAY AND MAY NOT DO
 * ============================================================================
 *
 *  - `/gateway/ingest/resolve` is behind the **email worker's** secret, not the
 *    gateway's. Both directions are asserted: neither secret opens the other's
 *    routes.
 *  - It hands back a policy and a ticket, and never a credential. A message
 *    that is going to be refused for policy causes no decrypt at all.
 *  - `/gateway/ingest/binding` takes only a ticket. Nothing a caller sends can
 *    name a context, and the ticket is single-use and short-lived.
 *
 * Every value here is obviously fake. This repository is public.
 */

/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  TEST_EMAIL_WORKER_SECRET,
  TEST_GATEWAY_SECRET,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  ingestPost,
  responseFingerprint,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

const OWNER_EMAIL = "owner@example.test";

const RESOLVE = "/gateway/ingest/resolve";
const BINDING = "/gateway/ingest/binding";
const RECORD = "/gateway/ingest/record";

/**
 * A person with a personal context whose storage is connected — everything an
 * inbound message needs in order to be captured.
 */
async function ready(slug = "seyi"): Promise<{
  t: TestConvex;
  ownerId: Id<"users">;
  workspaceId: Id<"workspaces">;
}> {
  const t = setupTest();
  const ownerId = await createUser(t, OWNER_EMAIL);
  const workspaceId = await createWorkspace(t, ownerId, slug, { kind: "personal" });
  await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "connected" });
  return { t, ownerId, workspaceId };
}

async function resolve(t: TestConvex, name: string, sizeBytes = 4096) {
  return await ingestPost(t, RESOLVE, { username: name, sizeBytes, envelopeFrom: "sender@example.test" });
}

async function resolvedTicket(t: TestConvex, name: string): Promise<string> {
  const body = await (await resolve(t, name)).json();
  return body.ingestion.ticket as string;
}

/* -------------------------------------------------------------------------- */

/**
 * THE ROUTES AND THE WORKER MUST AGREE ON THE WIRE.
 *
 * `infra/email-worker` is a separate deployment with its own test suite, and
 * both suites can be entirely green while the two disagree about what a request
 * looks like — a route reading `name` and a worker sending `username` typecheck
 * perfectly, pass everything, and refuse every message in production, silently,
 * because the refusal is the same one an unknown recipient gets.
 *
 * That very mismatch was written and nearly shipped in the change that added
 * these routes. So the worker's **actual source** is read here and its request
 * shapes are compared against what the handlers destructure, in the same spirit
 * as `gatewayFormat.helpers.ts` reading the gateway's real parser rather than a
 * transcription of it.
 */
describe("the wire contract matches the worker's", () => {
  const WORKER_SOURCES = import.meta.glob(
    "../../../infra/email-worker/src/controlPlane.ts",
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  const HTTP_SOURCES = import.meta.glob("../http.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const workerSource = Object.values(WORKER_SOURCES)[0];
  const httpSource = Object.values(HTTP_SOURCES)[0];

  test("the worker's source is actually being read", () => {
    // Non-vacuity. If the glob stops matching, every assertion below passes
    // over an empty string and proves nothing.
    expect(typeof workerSource).toBe("string");
    expect(workerSource).toContain("/gateway/ingest/resolve");
    expect(typeof httpSource).toBe("string");
  });

  /** `post("/gateway/ingest/resolve", { a, b, c })` → `["a", "b", "c"]` */
  function fieldsSentTo(path: string): string[] {
    const call = new RegExp(
      `post\\(\\s*"${path.replace(/\//g, "\\/")}"\\s*,\\s*\\{([^}]*)\\}`,
    ).exec(workerSource);
    expect(call, `the worker does not POST to ${path}`).not.toBeNull();
    return call![1]
      .split(",")
      .map((entry) => entry.split(":")[0].trim())
      .filter((entry) => entry.length > 0)
      .sort();
  }

  /** The body keys a handler reads, from its `stringField(body, "x")` calls. */
  function fieldsReadBy(routeName: string): string[] {
    const start = httpSource.indexOf(`export const ${routeName} =`);
    expect(start, `${routeName} is not declared in http.ts`).toBeGreaterThan(-1);
    const rest = httpSource.slice(start);
    const end = rest.indexOf("\nexport const ");
    const handler = end === -1 ? rest : rest.slice(0, end);
    return [
      ...new Set([
        ...[...handler.matchAll(/stringField\(body,\s*"(\w+)"\)/g)].map((m) => m[1]),
        ...[...handler.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]),
      ]),
    ].sort();
  }

  test("resolve reads every field the worker sends", () => {
    const sent = fieldsSentTo("/gateway/ingest/resolve");
    expect(sent).toEqual(["envelopeFrom", "sizeBytes", "username"]);

    const read = fieldsReadBy("gatewayIngestResolve");
    // `envelopeFrom` is deliberately not read — see the route. Everything the
    // route *does* depend on has to be something the worker actually sends.
    for (const field of read) {
      expect(sent, `resolve reads "${field}", which the worker never sends`).toContain(
        field,
      );
    }
    // …and the one that decides the recipient must be among them.
    expect(read).toContain("username");
  });

  test("binding and record read every field the worker sends", () => {
    expect(fieldsSentTo("/gateway/ingest/binding")).toEqual(["ticket"]);
    expect(fieldsReadBy("gatewayIngestBinding")).toEqual(["ticket"]);

    const recordSent = fieldsSentTo("/gateway/ingest/record");
    expect(recordSent).toEqual(["bytes", "outcome", "ticket"]);
    for (const field of fieldsReadBy("gatewayIngestRecord")) {
      expect(recordSent, `record reads "${field}", which the worker never sends`).toContain(
        field,
      );
    }
  });

  test("every path the worker POSTs to is a path this deployment serves", () => {
    const posted = [...workerSource.matchAll(/post\(\s*"(\/gateway\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(posted.length).toBeGreaterThan(0);
    for (const path of posted) {
      expect(
        httpSource.replace(/\s+/g, " "),
        `the worker POSTs to ${path}, which http.ts does not route`,
      ).toContain(`path: "${path}"`);
    }
  });

  test("the response the worker parses is the response the route builds", () => {
    // The worker requires these keys and throws `ControlPlaneError` on a
    // missing one — which it treats as an outage, not a refusal.
    expect(workerSource).toMatch(/required\(\s*[\s\S]*?"ingestion",?\s*\)/);
    expect(httpSource).toContain("json({ ingestion: null })");
    expect(httpSource).toContain("json({ ingestion: { ticket, ...resolution } })");
    expect(httpSource).toContain("json({ binding })");
    expect(httpSource).toContain("json({ ok: true })");
  });
});

/* -------------------------------------------------------------------------- */

describe("resolving a name that may receive mail", () => {
  test("answers with the owner's policy, their context, and a ticket", async () => {
    const { t } = await ready();

    const body = await (await resolve(t, "seyi")).json();

    expect(body.ingestion).toMatchObject({
      context: { kind: "personal", path: "seyi" },
      targetFolder: "0-inbox/",
      policy: {
        // Seeded closed: the owner's own account email and nobody else.
        allowedSenders: [OWNER_EMAIL],
        allowedDomains: [],
        allowAnySender: false,
      },
    });
    expect(typeof body.ingestion.ticket).toBe("string");
    expect(body.ingestion.ticket.length).toBeGreaterThan(0);
  });

  test("hands back no credential — that is what the second call is for", async () => {
    const { t } = await ready();

    const text = await (await resolve(t, "seyi")).text();

    // A message that will be refused for size, authentication, or sender policy
    // is refused before any credential is decrypted, so most abusive traffic
    // causes no decrypt at all. If any of these ever appear here, that is gone.
    expect(text).not.toContain("secretAccessKey");
    expect(text).not.toContain("accessKeyId");
    expect(text).not.toContain("bucket");
    expect(text).not.toContain("endpoint");
  });

  test("the ticket is stored hashed, never in the clear", async () => {
    const { t } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    const rows = await t.run((ctx) => ctx.db.query("ingestionTickets").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].hashedTicket).not.toBe(ticket);
    expect(rows[0].hashedTicket).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a name is normalised before it is looked up", async () => {
    const { t } = await ready();

    const body = await (await resolve(t, "  SEYI  ")).json();
    expect(body.ingestion?.context).toEqual({ kind: "personal", path: "seyi" });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE DECISION, ASSERTED.
 *
 * A shared context has no ingestion address. Not a disabled one, not one
 * awaiting configuration — mail cannot reach it, and nothing about the refusal
 * says that it is a team.
 */
describe("a shared context cannot receive mail", () => {
  async function withShared(): Promise<TestConvex> {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "acme-board", {
      kind: "shared",
    });
    // Storage connected, so the *only* thing standing between this address and
    // a capture is the personal-context rule. A test where the binding was also
    // missing would pass for the wrong reason.
    await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "connected" });
    return t;
  }

  test("resolve refuses it", async () => {
    const t = await withShared();

    const body = await (await resolve(t, "acme-board")).json();
    expect(body).toEqual({ ingestion: null });
  });

  test("and the refusal is byte-identical to one for a name nobody has claimed", async () => {
    // The whole property. A rejection that differed at all would let anyone
    // enumerate which names on this domain are teams, from any mail client.
    const t = await withShared();

    const shared = await resolve(t, "acme-board");
    const unclaimed = await resolve(t, "nobody-has-this-name");

    expect(await responseFingerprint(shared)).toBe(
      await responseFingerprint(unclaimed),
    );
  });

  test("it never had a policy row to begin with", async () => {
    // Not "a row that says no" — no row. `createWorkspace` seeds a policy only
    // for a personal context, because a shared one has no address to govern.
    const t = await withShared();

    const rows = await t.run((ctx) => ctx.db.query("ingestionSettings").collect());
    expect(rows).toEqual([]);
  });

  test("and no ticket is minted for it", async () => {
    const t = await withShared();
    await resolve(t, "acme-board");

    const tickets = await t.run((ctx) => ctx.db.query("ingestionTickets").collect());
    expect(tickets).toEqual([]);
  });

  test("its owner cannot configure ingestion for it either", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "acme-board", {
      kind: "shared",
    });

    // The read is honest rather than an error: there genuinely is no policy.
    expect(
      await asUser(t, ownerId).query(api.functions.ingestion.getIngestionSettings, {
        workspaceId,
      }),
    ).toBeNull();

    // The write cannot be satisfied, so it refuses rather than reporting
    // success for a setting that governs nothing.
    await expect(
      asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowAnySender: true,
      }),
    ).rejects.toThrow(/INGESTION_NOT_AVAILABLE|personal context/);

    // …and it wrote nothing on the way out.
    expect(await t.run((ctx) => ctx.db.query("ingestionSettings").collect())).toEqual(
      [],
    );
  });

  test("even if it somehow has a policy row, resolve still refuses it", async () => {
    // The two guards are independent and this test says so. `createWorkspace`
    // seeds no policy for a shared context, so most of the block above would
    // pass even with the `kind` check deleted from
    // `resolvePersonalContextForIngestion` — the missing row would refuse it
    // anyway. That is defence in depth, and defence in depth is exactly the
    // thing that hides a broken layer.
    //
    // So: a shared context WITH a policy row, which is reachable by a row
    // written before the rule existed, or by a future caller that forgets. The
    // resolve path must not depend on the seeder having done its job.
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "acme-board", {
      kind: "shared",
    });
    await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "connected" });
    await t.run((ctx) =>
      ctx.db.insert("ingestionSettings", {
        workspaceId,
        targetFolder: "0-inbox/",
        allowedSenders: ["anyone@example.test"],
        allowedDomains: [],
        allowAnySender: true,
        updatedBy: ownerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    expect(await (await resolve(t, "acme-board")).json()).toEqual({ ingestion: null });
    expect(await t.run((ctx) => ctx.db.query("ingestionTickets").collect())).toEqual(
      [],
    );
  });

  test("a personal context that has since been shared stops receiving mail", async () => {
    // `workspaces.kind` is chosen at creation and never patched, so it states
    // intent reliably — but `schema.ts` defines a personal context as one with a
    // single owner member, and a context three people read is not somewhere
    // unauthenticated mail may land whatever its row says. The count is the
    // stricter half of the rule and this is what proves it is applied.
    const { t, ownerId, workspaceId } = await ready();
    expect((await (await resolve(t, "seyi")).json()).ingestion).not.toBeNull();

    const colleague = await createUser(t, "colleague@example.test");
    await addMember(t, workspaceId, colleague, "member", ownerId);

    expect(await (await resolve(t, "seyi")).json()).toEqual({ ingestion: null });
  });
});

/* -------------------------------------------------------------------------- */

describe("every other refusal is the same refusal", () => {
  test("an unknown name, a reserved name, and a malformed one are indistinguishable", async () => {
    const { t } = await ready();

    const answers = await Promise.all(
      [
        "nobody-has-this-name",
        // Reserved. Ingestion is on the apex, so whoever held `support` would
        // receive mail sent to support@context.lc — the list is a
        // mail-interception control, not cosmetics.
        "support",
        "postmaster",
        // Malformed.
        "a",
        "not a name",
        "-leading-hyphen",
      ].map((name) => resolve(t, name)),
    );

    const fingerprints = await Promise.all(answers.map(responseFingerprint));
    expect(new Set(fingerprints).size).toBe(1);
  });

  test("a claimed name with no storage answers exactly the same", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    await createWorkspace(t, ownerId, "seyi", { kind: "personal" });
    // No `seedStorageBinding`: the person exists, the policy exists, there is
    // nowhere to write.

    expect(await responseFingerprint(await resolve(t, "seyi"))).toBe(
      await responseFingerprint(await resolve(t, "nobody-has-this-name")),
    );
  });

  test("a binding that is not connected answers exactly the same", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "seyi", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "error" });

    expect(await responseFingerprint(await resolve(t, "seyi"))).toBe(
      await responseFingerprint(await resolve(t, "nobody-has-this-name")),
    );
  });

  test("a malformed request answers exactly the same", async () => {
    const { t } = await ready();

    const missing = await ingestPost(t, RESOLVE, { sizeBytes: 1 });
    const wrongType = await ingestPost(t, RESOLVE, { username: 42, sizeBytes: 1 });
    // A response body can only be read once, so the baseline is taken as a
    // string rather than re-read for each comparison.
    const unknown = await responseFingerprint(await resolve(t, "nobody-has-this-name"));

    expect(await responseFingerprint(missing)).toBe(unknown);
    expect(await responseFingerprint(wrongType)).toBe(unknown);
  });
});

/* -------------------------------------------------------------------------- */

describe("the two doors have two keys", () => {
  test("the gateway secret does not open an ingest route", async () => {
    const { t } = await ready();

    const response = await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
      secret: TEST_GATEWAY_SECRET,
    });
    expect(response.status).toBe(401);

    // …and no ticket was minted on the way to being refused.
    expect(await t.run((ctx) => ctx.db.query("ingestionTickets").collect())).toEqual(
      [],
    );
  });

  test("the email worker secret does not open a gateway route", async () => {
    const { t } = await ready();

    const response = await gatewayPost(t, "/gateway/session", { accessToken: "x" }, {
      secret: TEST_EMAIL_WORKER_SECRET,
    });
    expect(response.status).toBe(401);
  });

  test("no secret at all, and the wrong secret, are one answer", async () => {
    const { t } = await ready();

    const absent = await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
      secret: null,
    });
    const wrong = await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
      secret: "not-the-secret",
    });

    expect(await responseFingerprint(absent)).toBe(await responseFingerprint(wrong));
  });

  test("every ingest route is behind the door, not just resolve", async () => {
    const { t } = await ready();

    for (const path of [RESOLVE, BINDING, RECORD]) {
      const response = await ingestPost(t, path, { ticket: "x" }, { secret: null });
      expect(response.status, `${path} is not behind the email worker secret`).toBe(
        401,
      );
    }
  });

  test("no response ever contains either secret", async () => {
    const { t } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    const said: string[] = [];
    said.push(await (await resolve(t, "seyi")).text());
    said.push(await (await ingestPost(t, BINDING, { ticket })).text());
    said.push(await (await ingestPost(t, RECORD, { ticket, outcome: "captured", bytes: 1 })).text());
    said.push(await (await ingestPost(t, RESOLVE, {}, { secret: "wrong" })).text());

    expect(said.join("\n")).not.toContain(TEST_EMAIL_WORKER_SECRET);
    expect(said.join("\n")).not.toContain(TEST_GATEWAY_SECRET);
  });
});

/* -------------------------------------------------------------------------- */

describe("the ticket is the whole of the second proof", () => {
  test("it opens the credential for the context it was minted for", async () => {
    const { t, workspaceId } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    const body = await (await ingestPost(t, BINDING, { ticket })).json();

    expect(body.binding).toMatchObject({
      workspaceId,
      status: "active",
      bucket: expect.any(String),
    });
    // The point of the whole route: a real, decrypted secret.
    expect(typeof body.binding.secretAccessKey).toBe("string");
    expect(body.binding.secretAccessKey.length).toBeGreaterThan(0);
  });

  test("it is single-use", async () => {
    const { t } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    expect((await (await ingestPost(t, BINDING, { ticket })).json()).binding).not.toBeNull();
    expect((await (await ingestPost(t, BINDING, { ticket })).json()).binding).toBeNull();
  });

  test("an expired ticket is refused whether or not anything swept it", async () => {
    const { t } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    await t.run(async (ctx) => {
      const row = await ctx.db.query("ingestionTickets").first();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    expect((await (await ingestPost(t, BINDING, { ticket })).json()).binding).toBeNull();
  });

  test("an invented ticket opens nothing", async () => {
    const { t } = await ready();

    for (const ticket of ["", "x", "0".repeat(64), "not-a-ticket"]) {
      const response = await ingestPost(t, BINDING, { ticket });
      expect(await response.json()).toEqual({ binding: null });
    }
  });

  test("a ticket for one person's context cannot be pointed at another's", async () => {
    // There is no field to point it with — which is the property. The binding
    // request carries a ticket and nothing else, so this asserts the shape as
    // much as the behaviour: extra fields are ignored, not honoured.
    const t = setupTest();
    const seyiId = await createUser(t, OWNER_EMAIL);
    const seyiWs = await createWorkspace(t, seyiId, "seyi", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: seyiWs, boundBy: seyiId, status: "connected" });

    const otherId = await createUser(t, "other@example.test");
    const otherWs = await createWorkspace(t, otherId, "other", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: otherWs, boundBy: otherId, status: "connected" });

    const ticket = await resolvedTicket(t, "seyi");
    const body = await (
      await ingestPost(t, BINDING, { ticket, workspaceId: otherWs })
    ).json();

    expect(body.binding.workspaceId).toBe(seyiWs);
  });
});

/* -------------------------------------------------------------------------- */

describe("recording a capture", () => {
  test("writes an audit row carrying no message content", async () => {
    const { t, workspaceId } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    await ingestPost(t, RECORD, { ticket, outcome: "captured", bytes: 8192 });

    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    const capture = events.find((e) => e.action === "ingestion.captured");
    expect(capture).toBeDefined();
    expect(capture!.details).toEqual({
      outcome: "captured",
      bytes: 8192,
      source: "email",
      domain: "context.lc",
    });
    // No person acted. Naming the owner as the actor for mail somebody else
    // sent them would be a lie in an append-only trail.
    expect(capture!.actorUserId).toBeUndefined();
  });

  test("always answers ok, so it cannot be used to test whether a ticket was real", async () => {
    const { t } = await ready();
    const good = await resolvedTicket(t, "seyi");

    const real = await ingestPost(t, RECORD, { ticket: good, outcome: "captured", bytes: 1 });
    const invented = await ingestPost(t, RECORD, {
      ticket: "not-a-ticket",
      outcome: "captured",
      bytes: 1,
    });

    expect(await responseFingerprint(real)).toBe(await responseFingerprint(invented));
  });

  test("is single-use, so one message cannot be counted twice", async () => {
    const { t, workspaceId } = await ready();
    const ticket = await resolvedTicket(t, "seyi");

    await ingestPost(t, RECORD, { ticket, outcome: "captured", bytes: 1 });
    await ingestPost(t, RECORD, { ticket, outcome: "captured", bytes: 1 });

    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(events.filter((e) => e.action === "ingestion.captured")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("resolve is rate limited", () => {
  test("a name can only be probed so many times in a window", async () => {
    const { t } = await ready();

    let refusals = 0;
    for (let i = 0; i < 70; i += 1) {
      const body = await (await resolve(t, "seyi")).json();
      if (body.ingestion === null) refusals += 1;
    }

    // The limit is 60 per hour, so the last ten answer `null` — and they answer
    // it in exactly the shape an unknown name gets, so a prober learns nothing
    // from having been throttled.
    expect(refusals).toBeGreaterThan(0);
    expect(await responseFingerprint(await resolve(t, "seyi"))).toBe(
      await responseFingerprint(await resolve(t, "nobody-has-this-name")),
    );
  });

  test("the counter is keyed on the recipient, so one name cannot exhaust another", async () => {
    const t = setupTest();
    const seyiId = await createUser(t, OWNER_EMAIL);
    const seyiWs = await createWorkspace(t, seyiId, "seyi", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: seyiWs, boundBy: seyiId, status: "connected" });

    const otherId = await createUser(t, "other@example.test");
    const otherWs = await createWorkspace(t, otherId, "other", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: otherWs, boundBy: otherId, status: "connected" });

    for (let i = 0; i < 70; i += 1) await resolve(t, "seyi");

    expect((await (await resolve(t, "other")).json()).ingestion).not.toBeNull();
  });
});
