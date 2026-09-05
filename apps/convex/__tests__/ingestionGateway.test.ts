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

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolvePersonalContextForIngestion } from "../functions/lib/ingestionStore";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_CEILING,
} from "../functions/lib/ingestion";
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

  test("the attachment policy is the owner's stored one, not a constant", async () => {
    const { t, ownerId, workspaceId } = await ready();

    // The seeded default, which is what the hardcoded constant used to return.
    const seeded = await (await resolve(t, "seyi")).json();
    expect(seeded.ingestion.attachmentPolicy).toBe("list");
    expect(seeded.ingestion.maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);

    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      attachmentPolicy: "store",
      maxAttachmentBytes: 1_500_000,
    });

    // If this still said "list" the setting would be decorative: the console
    // would show storing enabled and the worker would keep describing only.
    const stored = await (await resolve(t, "seyi")).json();
    expect(stored.ingestion.attachmentPolicy).toBe("store");
    expect(stored.ingestion.maxAttachmentBytes).toBe(1_500_000);
  });

  test("the configurable ceiling never exceeds what the gateway will serve back", async () => {
    // Storing an attachment larger than `read_image` will return puts bytes in
    // the customer's bucket that nothing in Context can ever read — the
    // broken-link failure this feature exists to avoid. The two numbers live in
    // different packages, because the gateway is dependency-free on purpose, so
    // this check is the only thing keeping them honest.
    const gateway = readFileSync(resolvePath(__dirname, "../../mcp/src/index.js"), "utf8");
    const declared = gateway.match(/const MAX_INLINE_IMAGE_BYTES = ([\d_]+);/);
    expect(declared, "MAX_INLINE_IMAGE_BYTES is no longer declared in apps/mcp").not.toBeNull();

    const servable = Number(declared![1]!.replace(/_/g, ""));
    expect(MAX_ATTACHMENT_BYTES_CEILING).toBeLessThanOrEqual(servable);
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

});

/* -------------------------------------------------------------------------- */

/**
 * THE OTHER HALF OF THE DECISION.
 *
 * Sharing a personal context must not kill its capture address. The rule used
 * to be "exactly one member", which meant inviting a colleague into your own
 * context silently bounced your mail from that moment on — and because every
 * refusal is byte-identical to an unclaimed name, nobody was told. That was
 * never the product intent: it punished exactly the flow sharing exists for.
 *
 * What keeps the flip safe is that the *owner* stays the boundary. The
 * allow-list and target folder are owner-only in both directions
 * (`ingestion.test.ts`, "who may read" / "who may write"), and every capture
 * is attributed to the sole owner — so everything from outside still passes
 * through one accountable owner's hands, however many people can read the
 * context it lands in.
 */
describe("a personal context that has been shared keeps its capture address", () => {
  test("mail still resolves after a member is added", async () => {
    const { t, ownerId, workspaceId } = await ready();
    expect((await (await resolve(t, "seyi")).json()).ingestion).not.toBeNull();

    const colleague = await createUser(t, "colleague@example.test");
    await addMember(t, workspaceId, colleague, "member", ownerId);

    const body = await (await resolve(t, "seyi")).json();
    expect(body.ingestion).not.toBeNull();
    expect(body.ingestion.context).toEqual({ kind: "personal", path: "seyi" });
  });

  test("and the capture is attributed to the owner, never a newcomer", async () => {
    const { t, ownerId, workspaceId } = await ready();
    const colleague = await createUser(t, "colleague@example.test");
    await addMember(t, workspaceId, colleague, "editor", ownerId);

    const resolved = await t.run((ctx) =>
      resolvePersonalContextForIngestion(ctx, "seyi"),
    );
    expect(resolved?.ownerUserId).toBe(ownerId);
  });

  test("a personal context with no owner row is refused, byte-identically", async () => {
    // The zero-owner half of `owners.length !== 1`. The two-owner half is the
    // describe block immediately below, and neither covers the other.
    // The fail-closed floor of the new rule. The sole owner is what makes a
    // personal context accountable — whose allow-list, whose inbox — so a
    // membership set with no resolvable owner, reachable only by data damage
    // since `removeMember` refuses to delete an owner, refuses like any other
    // no. A colleague remains a member on purpose: with the member rows
    // otherwise empty, a resolver that returned the first row *whatever its
    // role* would still refuse here and this test would prove nothing — the
    // sabotage that found that gap resolved the colleague as "the owner".
    const { t, ownerId, workspaceId } = await ready();
    const colleague = await createUser(t, "colleague@example.test");
    await addMember(t, workspaceId, colleague, "editor", ownerId);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      for (const row of rows) {
        if (row.role === "owner") await ctx.db.delete(row._id);
      }
    });

    expect(await responseFingerprint(await resolve(t, "seyi"))).toBe(
      await responseFingerprint(await resolve(t, "nobody-has-this-name")),
    );
  });
});

/* -------------------------------------------------------------------------- */

/**
 * THE OTHER HALF OF THE SOLE-OWNER RULE, WHICH NOTHING WAS ASSERTING.
 *
 * The zero-owner case is the test directly above. This is the two-owner case,
 * and it was uncovered: degrading `owners.length !== 1` to `owners.length < 1`
 * reddened **nothing**, because `0 < 1` is still true and the test above still
 * passed. The two halves belong together and each names the other.
 *
 * WHAT THE GUARD ACTUALLY PREVENTS. Not a misattributed capture: the resolver's
 * `ownerUserId` has no production consumer downstream of resolution, the
 * ingestion policy is read by workspace (`getIngestionSettingsRow(ctx,
 * personal.workspace._id)`), and the note's owner label is the workspace slug
 * (`owner: resolution.context.path`). What it prevents is larger. A personal
 * context whose sole-owner invariant has broken keeps a **live capture
 * address**: resolve answers with an ingestion object and writes an
 * `ingestionTickets` row, and spending that ticket at
 * `/gateway/ingest/binding` returns the decrypted storage credential. That is
 * the second internet-facing path to a credential that `http.ts` names, and
 * `owners.length !== 1` is one of the things holding it shut. Hence the
 * no-ticket assertion below, which is the one that names the harm.
 *
 * WHY TEST A STATE THE PRODUCT CANNOT REACH. It cannot reach it *today*, and
 * that is the argument for the test rather than against it. The whole
 * OWNER-CREATING write surface for `workspaceMembers` is two inserts and one
 * role patch — the two deletes cannot mint one — and none of the three can: `createWorkspace` writes the single owner,
 * `invitations` and `setMemberRole` both validate the role as
 * `editor | member`, and `setMemberRole`'s own refusal says ownership transfer
 * "is a separate step, and is not built yet". **The day it is built is the day
 * this guard starts mattering, and an unproved guard is one nobody notices has
 * stopped working.**
 *
 * SABOTAGE: `!== 1` → `< 1` reddens this block and not the one above; deleting
 * the check reddens both.
 */
describe("a personal context with two owners cannot receive mail either", () => {
  async function withTwoOwners() {
    const { t, ownerId, workspaceId } = await ready();
    const intruder = await createUser(t, "second-owner@example.test");
    await addMember(t, workspaceId, intruder, "owner", ownerId);
    return { t, ownerId, workspaceId };
  }

  test("it is refused, and refused indistinguishably", async () => {
    const { t } = await withTwoOwners();

    expect(await (await resolve(t, "seyi")).json()).toEqual({ ingestion: null });
    // A rejection that differed at all would let anyone enumerate which names
    // on this domain are damaged, from any mail client.
    expect(await responseFingerprint(await resolve(t, "seyi"))).toBe(
      await responseFingerprint(await resolve(t, "nobody-has-this-name")),
    );
  });

  test("and no ticket is minted, so nothing can be spent for a credential", async () => {
    const { t } = await withTwoOwners();
    await resolve(t, "seyi");

    const tickets = await t.run((ctx) => ctx.db.query("ingestionTickets").collect());
    expect(tickets).toEqual([]);
  });

  test("one owner still resolves, so the refusal above is the rule and not the fixture", async () => {
    const { t } = await ready();

    // Asserted on the shape rather than `not.toBeNull()`: an error body has no
    // `ingestion` key at all, and `undefined` would satisfy the looser form.
    const body = await (await resolve(t, "seyi")).json();
    expect(body.ingestion.context).toEqual({ kind: "personal", path: "seyi" });
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
      "../http.ts",
      "../functions/ingestionGateway.ts",
      "../functions/lib/ingestionStore.ts",
      "../functions/lib/ingestLog.ts",
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
