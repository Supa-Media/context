/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { resolvePersonalContextForIngestion } from "../../functions/lib/ingestionStore";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_CEILING,
} from "../../functions/lib/ingestion";
import {
  asUser,
  createUser,
  createWorkspace,
  addMember,
  ingestPost,
  responseFingerprint,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  OWNER_EMAIL,
  RESOLVE,
  ready,
  resolve,
  resolvedTicket,
} from "./fixtures.helpers";

describe("the wire contract matches the worker's", () => {
  const WORKER_SOURCES = import.meta.glob(
    "../../../../infra/email-worker/src/controlPlane.ts",
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  const HTTP_SOURCES = import.meta.glob("../../http.ts", {
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
    const gateway = readFileSync(
      resolvePath(__dirname, "../../../mcp/src/tools/readImage.js"),
      "utf8",
    );
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

