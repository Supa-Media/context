/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { resolvePersonalContextForIngestion } from "../../functions/lib/ingestionStore";
import {
  createUser,
  createWorkspace,
  gatewayPost,
  ingestPost,
  responseFingerprint,
  seedStorageBinding,
  setupTest,
  TEST_EMAIL_WORKER_SECRET,
  TEST_GATEWAY_SECRET,
} from "../fixtures.helpers";
import {
  OWNER_EMAIL,
  RESOLVE,
  BINDING,
  RECORD,
  ready,
  resolve,
  resolvedTicket,
} from "./fixtures.helpers";

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

  /**
   * The capability object, on the route that carries a credential.
   *
   * `ready()` seeds `seedStorageBinding`'s default `{ conditionalWrite: true }`
   * — the shape a binding written before 2026-09-12 holds — so every test
   * above passed while this route's return validator still restated the
   * three-field capability object inline. Once `serverSideCopy` was written on
   * every probe and backfilled onto every row, `v.object` refused the answer
   * this route had just built, and inbound mail to every context bounced as
   * `storage_unavailable`. See `capabilityBackfill.test.ts` for the same fault
   * on `/gateway/binding`.
   */
  test("it carries every probed capability, not the three it used to", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "seyi", { kind: "personal" });
    const probed = {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
      serverSideCopy: true,
    };
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: ownerId,
      status: "connected",
      capabilities: probed,
    });

    const ticket = await resolvedTicket(t, "seyi");
    const response = await ingestPost(t, BINDING, { ticket });

    // A 200 is half of it: the validator throws after the handler returns, so
    // the route answers 500 and the worker bounces the message.
    expect(response.status).toBe(200);
    expect((await response.json()).binding.capabilities).toEqual(probed);
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

describe("the ticket table does not grow forever", () => {
  test("the sweep deletes rows dead for over an hour and leaves live ones", async () => {
    // Every inbound message that resolves writes a row here, and the arrival
    // rate is set by whoever is sending mail rather than by our own customers.
    // Without the cron this table is unbounded and a stranger sets the pace.
    const { t } = await ready();
    await resolvedTicket(t, "seyi");
    await resolvedTicket(t, "seyi");

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("ingestionTickets").collect();
      await ctx.db.patch(rows[0]._id, { expiresAt: Date.now() - 2 * 60 * 60 * 1000 });
    });

    const result = await t.mutation(
      internal.functions.ingestionGateway.purgeExpiredIngestionTickets,
      {},
    );
    expect(result).toEqual({ deleted: 1, moreRemaining: false });
    expect(await t.run((ctx) => ctx.db.query("ingestionTickets").collect())).toHaveLength(
      1,
    );
  });

  test("a row that expired a moment ago is left alone", async () => {
    // Not zero retention: deleting a row the instant it expires would race a
    // worker that is mid-transaction, and the hour costs nothing because every
    // reader checks `expiresAt` anyway.
    const { t } = await ready();
    await resolvedTicket(t, "seyi");
    await t.run(async (ctx) => {
      const row = await ctx.db.query("ingestionTickets").first();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1000 });
    });

    const result = await t.mutation(
      internal.functions.ingestionGateway.purgeExpiredIngestionTickets,
      {},
    );
    expect(result.deleted).toBe(0);
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

  test("a name that resolves to nothing leaves no counter row behind", async () => {
    // The keyspace is a name a stranger typed. If the limit were counted before
    // the lookup, anyone able to send mail could mint an unbounded number of
    // `rateLimits` rows by addressing invented names — a write amplification on
    // a table nothing sweeps. Counting after resolution bounds the keyspace to
    // real personal contexts.
    //
    // Sabotage: move the `consumeRateLimit` call above
    // `resolvePersonalContextForIngestion` and this goes red.
    const { t } = await ready();

    for (const invented of ["nobody-a", "nobody-b", "nobody-c"]) {
      await resolve(t, invented);
    }

    const keys = (await t.run((ctx) => ctx.db.query("rateLimits").collect())).map(
      (row) => row.key,
    );
    expect(keys.filter((key) => key.startsWith("ingest.resolve:"))).toEqual([]);
  });

  test("a name that does resolve is counted", async () => {
    // Non-vacuity for the test above: if the limit stopped being consumed at
    // all, that one would pass and this one would not.
    const { t } = await ready();
    await resolve(t, "seyi");

    const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(rows.map((row) => row.key)).toContain("ingest.resolve:seyi");
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

/* -------------------------------------------------------------------------- */

/**
 * AN OPERATOR CAN LEARN WHY. A SENDER STILL CANNOT.
 *
 * The refusals above are byte-identical on purpose, and that must not change.
 * The cost of it was paid in full once: ingestion resolved to nothing in
 * production and there was no way, from either side of the wire, to learn which
 * refusal had fired. Cloudflare's Email Routing activity log said "worker script
 * threw an exception"; this deployment said nothing at all, because a route that
 * answers 401 and a route that answers `null` both complete successfully and
 * write no line anywhere.
 *
 * So the reason is now recorded here — in the deployment's own logs, which only
 * an operator can read — and `infra/email-worker/src/controlPlane.ts` says in as
 * many words that this is the side that can safely record it.
 *
 * Every test below is paired: the log distinguishes, and the response does not.
 */
describe("an operator can learn why, without the sender learning anything", () => {
  /** The ingest lines this deployment wrote while `fn` ran, parsed. */
  async function ingestLogsDuring(
    fn: () => Promise<unknown>,
  ): Promise<Record<string, unknown>[]> {
    // Assigned rather than `vi.spyOn`ed: these functions run inside vitest's
    // edge-runtime VM, whose `console` the spy helper does not reach.
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(typeof args[0] === "string" ? args[0] : "");
    };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && entry.controlPlane === "ingest",
      );
  }

  const reasonsOf = (entries: Record<string, unknown>[]) =>
    entries.map((entry) => `${entry.event}:${entry.reason ?? ""}`);

  /**
   * THE ONE THAT WOULD HAVE ENDED THE INVESTIGATION IN A MINUTE.
   *
   * A Worker holding a secret this deployment does not accept is answered 401,
   * which becomes `ControlPlaneError("status 401")`, which `index.ts` rethrows,
   * which Cloudflare reports as "worker script threw an exception". The two
   * halves of this secret are set from two different places and nothing compares
   * them, so this is the failure mode a misconfigured deploy actually produces.
   */
  test("a caller presenting the wrong secret is recorded", async () => {
    const { t } = await ready();

    const entries = await ingestLogsDuring(() =>
      ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
        secret: "not-the-email-worker-secret",
      }),
    );

    expect(reasonsOf(entries)).toContain("unauthorized:");
  });

  test("…and the 401 it gets back is still identical to the one for no secret at all", async () => {
    const { t } = await ready();

    const wrong = await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
      secret: "not-the-email-worker-secret",
    });
    const absent = await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
      secret: null,
    });

    expect(await responseFingerprint(wrong)).toBe(await responseFingerprint(absent));
  });

  /**
   * THE OTHER ONE. An operator probing this route by hand with `{"name": …}`
   * instead of `{"username": …}` gets a perfectly ordinary `{"ingestion":null}`
   * that never touches the database — and reads it as evidence about their data.
   * That happened, and it sent the investigation to the wrong half of the system.
   */
  test("a request that names no username is recorded as such, not as an unknown name", async () => {
    const { t } = await ready();

    const malformed = await ingestLogsDuring(() =>
      ingestPost(t, RESOLVE, { name: "seyi", sizeBytes: 1 }),
    );
    const unknown = await ingestLogsDuring(() => resolve(t, "nobody-has-this-name"));

    expect(reasonsOf(malformed)).toEqual(["resolve_refused:missing_username"]);
    expect(reasonsOf(unknown)).toEqual(["resolve_refused:no_personal_context"]);
  });

  test("every kind of refusal writes a different reason", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);

    // A personal context with no storage at all.
    await createWorkspace(t, ownerId, "unbound", { kind: "personal" });
    // A personal context whose storage is bound but broken.
    const brokenId = await createWorkspace(t, ownerId, "broken", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: brokenId, boundBy: ownerId, status: "error" });
    // A shared context.
    await createWorkspace(t, ownerId, "acme-board", { kind: "shared" });
    // A personal context whose policy row is gone. `createWorkspace` seeds one
    // for every personal context, so this state is only reachable by deleting
    // it — which is the point: `no_ingestion_policy` is the fail-closed floor,
    // and an operator who ever sees it is looking at a corrupted row rather
    // than at anything a user did.
    const policylessId = await createWorkspace(t, ownerId, "policyless", {
      kind: "personal",
    });
    await seedStorageBinding(t, {
      workspaceId: policylessId,
      boundBy: ownerId,
      status: "connected",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("ingestionSettings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", policylessId))
        .unique();
      await ctx.db.delete(row!._id);
    });

    const entries = await ingestLogsDuring(async () => {
      await resolve(t, "nobody-has-this-name");
      await resolve(t, "acme-board");
      await resolve(t, "support");
      await resolve(t, "not a name");
      await resolve(t, "unbound");
      await resolve(t, "broken");
      await resolve(t, "policyless");
      await ingestPost(t, RESOLVE, { sizeBytes: 1 });
    });

    expect(reasonsOf(entries)).toEqual([
      "resolve_refused:no_personal_context",
      // A shared context is NOT distinguished from an unclaimed name, even
      // here: `resolvePersonalContextForIngestion` is the single definition of
      // "may receive mail" and folds them on purpose. Splitting them in a log
      // would rebuild, for an operator, the distinction the function exists to
      // erase.
      "resolve_refused:no_personal_context",
      // `support` is refused by `validateName` — which checks `RESERVED_NAMES`
      // itself — so it never reaches the deliberate redundancy after it. That
      // ordering is exactly what the `reserved_name` code exists to make
      // visible: seeing it in a log means `validateName` stopped refusing
      // reserved names, which is a mail-interception control failing silently.
      "resolve_refused:invalid_name:reserved",
      "resolve_refused:invalid_name:invalid_characters",
      "resolve_refused:storage_unbound",
      "resolve_refused:storage_error",
      "resolve_refused:no_ingestion_policy",
      "resolve_refused:missing_username",
    ]);
  });

  test("…while every one of those answers the sender identically", async () => {
    // Non-vacuity for the test above: the reasons differ, so the responses had
    // better not. This is the property the reasons must never cost.
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    await createWorkspace(t, ownerId, "unbound", { kind: "personal" });
    await createWorkspace(t, ownerId, "acme-board", { kind: "shared" });

    const fingerprints = await Promise.all(
      [
        await resolve(t, "nobody-has-this-name"),
        await resolve(t, "acme-board"),
        await resolve(t, "support"),
        await resolve(t, "not a name"),
        await resolve(t, "unbound"),
        await ingestPost(t, RESOLVE, { sizeBytes: 1 }),
      ].map(responseFingerprint),
    );

    expect(new Set(fingerprints).size).toBe(1);
  });

  test("a capture that resolves says so, so 'the worker has never called' is answerable", async () => {
    const { t } = await ready();

    const entries = await ingestLogsDuring(() => resolve(t, "seyi"));

    expect(reasonsOf(entries)).toEqual(["resolve_ok:"]);
    expect(entries[0].name).toBe("seyi");
  });

  /**
   * THE FIELD SET IS CLOSED, AND THE CHARSET WITH IT.
   *
   * `lib/ingestLog.ts` takes three fields for the same reason the Worker's
   * `LogFields` does: "just add the envelope-from while debugging" should be a
   * type error rather than a stranger's address in a log aggregator. And the one
   * attacker-influenced field may only carry a name `validateName` accepted, so
   * nothing a stranger types can put a newline or a quote into a log line.
   */
  test("no log line carries a secret, a ticket, a sender, or an id", async () => {
    const { t } = await ready();

    const entries = await ingestLogsDuring(async () => {
      await resolve(t, "seyi");
      await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
        secret: TEST_EMAIL_WORKER_SECRET,
      });
      await ingestPost(t, RESOLVE, { username: "seyi", sizeBytes: 1 }, {
        secret: TEST_GATEWAY_SECRET,
      });
    });

    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(TEST_EMAIL_WORKER_SECRET);
    expect(serialized).not.toContain(TEST_GATEWAY_SECRET);
    expect(serialized).not.toContain("sender@example.test");
    expect(serialized).not.toContain(OWNER_EMAIL);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        Object.keys(entry)
          .filter((key) => ["controlPlane", "event", "reason", "name"].includes(key))
          .sort(),
      );
    }
  });

  test("a name that failed validation is never echoed into a log", async () => {
    const { t } = await ready();

    const entries = await ingestLogsDuring(() =>
      resolve(t, 'evil"\n{"controlPlane":"ingest","event":"resolve_ok'),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBeUndefined();
    expect(JSON.stringify(entries)).not.toContain("evil");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE UI SWITCH IS NOT A KILL SWITCH.
 *
 * `INGESTION_RECEIVER` is what the console reads to decide whether to claim
 * that mail is being delivered. It is *description*, not control: the Worker
 * calls these three routes over HTTP and never asks this deployment whether it
 * considers itself live, so leaving the variable unset makes the console say
 * "no delivery claims" while mail is captured perfectly well.
 *
 * That asymmetry is fine, and it is deliberate — but only while it stays
 * visible. Someone reading `receiving: false` in the console and concluding
 * "ingestion is off" would be wrong, and someone who "fixed" that by gating the
 * routes on it would have built a kill switch out of a label, in a file whose
 * own comment says a second way to express "off" is a second thing to check.
 */
describe("the console's receiver flag gates the console and nothing else", () => {
  const SOURCES = import.meta.glob(
    [
      "../../http.ts",
      "../../functions/ingestionGateway.ts",
      "../../functions/lib/ingestionStore.ts",
      "../../functions/lib/ingestLog.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  test("the sources are actually being read", () => {
    // Non-vacuity: an empty glob would pass every assertion below.
    const paths = Object.keys(SOURCES);
    expect(paths).toHaveLength(4);
    expect(Object.values(SOURCES).every((s) => s.length > 0)).toBe(true);
  });

  test("no part of the inbound-mail path reads INGESTION_RECEIVER", () => {
    for (const [path, source] of Object.entries(SOURCES)) {
      expect(
        source,
        `${path} reads INGESTION_RECEIVER — the console's flag must not decide whether mail is accepted`,
      ).not.toContain("INGESTION_RECEIVER");
      expect(source, `${path} calls ingestionIsReceiving`).not.toContain(
        "ingestionIsReceiving",
      );
    }
  });

  test("and mail resolves with the flag unset, which is how production is configured", async () => {
    const original = process.env.INGESTION_RECEIVER;
    delete process.env.INGESTION_RECEIVER;
    try {
      const { t } = await ready();
      expect((await (await resolve(t, "seyi")).json()).ingestion).not.toBeNull();
    } finally {
      if (original === undefined) delete process.env.INGESTION_RECEIVER;
      else process.env.INGESTION_RECEIVER = original;
    }
  });
});
