/**
 * Ingestion settings: authorization, validation, seeding, and the audit trail.
 *
 * The policy *rules* are proved in `ingestionPolicy.test.ts` against the pure
 * evaluator. This file is about the control plane around them: who may read,
 * who may write, what a hostile argument does, what the row looks like the
 * instant a workspace is created, and what the audit row does and does not say.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  MAX_ALLOWED_DOMAINS,
  MAX_ALLOWED_SENDERS,
  senderIsAllowed,
} from "../functions/lib/ingestion";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

const OWNER_EMAIL = "owner@example.test";

async function scenario(): Promise<{
  t: TestConvex;
  ownerId: Id<"users">;
  workspaceId: Id<"workspaces">;
}> {
  const t = setupTest();
  const ownerId = await createUser(t, OWNER_EMAIL);
  const workspaceId = await createWorkspace(t, ownerId, "seyi");
  return { t, ownerId, workspaceId };
}

function get(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return asUser(t, userId).query(api.functions.ingestion.getIngestionSettings, {
    workspaceId,
  });
}

/* -------------------------------------------------------------------------- */

describe("the seeded default", () => {
  test("a new workspace starts closed except for the owner's account email", async () => {
    const { t, ownerId, workspaceId } = await scenario();

    const settings = await get(t, ownerId, workspaceId);

    expect(settings).toEqual({
      address: "seyi@context.lc",
      targetFolder: "0-inbox/",
      allowedSenders: [OWNER_EMAIL],
      allowedDomains: [],
      allowAnySender: false,
    });
  });

  test("the seeded policy accepts the owner and refuses everyone else", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const settings = await get(t, ownerId, workspaceId);
    expect(settings).not.toBeNull();

    expect(senderIsAllowed(OWNER_EMAIL, settings!)).toBe(true);
    // The whole point of the default: an address that is merely *plausible*
    // gets nothing, and neither does anything on the owner's own domain.
    for (const from of [
      "attacker@evil.test",
      "someone-else@example.test",
      "owner@evil.example.test",
      "owner@notexample.test",
    ]) {
      expect(senderIsAllowed(from, settings!)).toBe(false);
    }
  });

  test("the seeded address is normalized, not stored as typed", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "Owner+Signup@Example.TEST");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const settings = await get(t, ownerId, workspaceId);
    expect(settings?.allowedSenders).toEqual(["owner+signup@example.test"]);
  });

  test("an account with no usable email seeds an empty list, not an open one", async () => {
    const t = setupTest();
    const ownerId = await t.run((ctx) =>
      ctx.db.insert("users", { createdAt: Date.now() }),
    );
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const settings = await get(t, ownerId, workspaceId);
    expect(settings?.allowedSenders).toEqual([]);
    expect(settings?.allowAnySender).toBe(false);
    expect(senderIsAllowed("anyone@anywhere.test", settings!)).toBe(false);
  });

  test("the capture address follows the slug, on the apex", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "ignite-2026");
    expect((await get(t, ownerId, workspaceId))?.address).toBe("ignite-2026@context.lc");
  });

  test("seeding is part of the creation transaction, not a follow-up", async () => {
    // If the seed were scheduled or deferred, a workspace would be addressable
    // before it had a policy. Nothing is queued, and the row is already there.
    const { t, workspaceId } = await scenario();
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toEqual([]);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("ingestionSettings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("a workspace with no row at all reads as null, which is closed", async () => {
    // Only workspaces created before this table existed can be here. `null`
    // must read as "accepts nothing", never as "not configured, so open".
    const { t, ownerId, workspaceId } = await scenario();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("ingestionSettings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    });

    expect(await get(t, ownerId, workspaceId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("who may read", () => {
  test("any member can read the policy", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const memberId = await createUser(t, "member@example.test");
    await addMember(t, workspaceId, memberId, "member", ownerId);

    expect((await get(t, memberId, workspaceId))?.targetFolder).toBe("0-inbox/");
  });

  test("a non-member gets WORKSPACE_NOT_FOUND, not a forbidden", async () => {
    const { t, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.test");

    const error = await captureError(() => get(t, stranger, workspaceId));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a signed-out caller cannot read", async () => {
    const { t, workspaceId } = await scenario();
    await expect(
      t.query(api.functions.ingestion.getIngestionSettings, { workspaceId }),
    ).rejects.toThrow();
  });
});

describe("who may write", () => {
  test("an owner can", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const result = await asUser(t, ownerId).mutation(
      api.functions.ingestion.updateIngestionSettings,
      { workspaceId, targetFolder: "2-areas/mail" },
    );
    expect(result.targetFolder).toBe("2-areas/mail/");
  });

  test("an editor cannot — writing notes is not the same grant as letting others write", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const editorId = await createUser(t, "editor@example.test");
    await addMember(t, workspaceId, editorId, "editor", ownerId);

    const error = await captureError(() =>
      asUser(t, editorId).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowAnySender: true,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a member cannot", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const memberId = await createUser(t, "member@example.test");
    await addMember(t, workspaceId, memberId, "member", ownerId);

    const error = await captureError(() =>
      asUser(t, memberId).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowAnySender: true,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a non-member cannot, and learns nothing from trying", async () => {
    const { t, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.test");

    const error = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowAnySender: true,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a refused write changes nothing", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.test");
    await captureError(() =>
      asUser(t, stranger).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowAnySender: true,
        allowedDomains: ["evil.test"],
      }),
    );

    expect(await get(t, ownerId, workspaceId)).toMatchObject({
      allowAnySender: false,
      allowedDomains: [],
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("updating", () => {
  test("omitted fields are left alone", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const owner = asUser(t, ownerId);

    await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedDomains: ["publicworship.life"],
    });
    // A client that does not know about `allowedSenders` must not blank it.
    await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      targetFolder: "2-areas/mail",
    });

    expect(await get(t, ownerId, workspaceId)).toEqual({
      address: "seyi@context.lc",
      targetFolder: "2-areas/mail/",
      allowedSenders: [OWNER_EMAIL],
      allowedDomains: ["publicworship.life"],
      allowAnySender: false,
    });
  });

  test("entries are normalized and deduplicated on the way in", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const result = await asUser(t, ownerId).mutation(
      api.functions.ingestion.updateIngestionSettings,
      {
        workspaceId,
        allowedSenders: [
          "Seyi <SEYI@Example.TEST>",
          "seyi@example.test",
          "  other@example.test  ",
        ],
        allowedDomains: ["Publicworship.LIFE", "@publicworship.life", "other.test."],
      },
    );

    expect(result.allowedSenders).toEqual(["seyi@example.test", "other@example.test"]);
    expect(result.allowedDomains).toEqual(["publicworship.life", "other.test"]);
  });

  test("an empty list is a real instruction, and it closes the door", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const settings = await asUser(t, ownerId).mutation(
      api.functions.ingestion.updateIngestionSettings,
      { workspaceId, allowedSenders: [], allowedDomains: [] },
    );

    expect(settings.allowedSenders).toEqual([]);
    expect(senderIsAllowed(OWNER_EMAIL, settings)).toBe(false);
  });

  test("a malformed address is refused, never silently dropped", async () => {
    const { t, ownerId, workspaceId } = await scenario();

    for (const entry of [
      "not-an-address",
      "seyi@@example.test",
      "seyi@localhost",
      "seyi@example.test, attacker@evil.test",
      '"seyi@example.test" <attacker@evil.test>, more@evil.test',
      "",
    ]) {
      const error = await captureError(() =>
        asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
          workspaceId,
          allowedSenders: ["good@example.test", entry],
        }),
      );
      expect(errorCode(error)).toBe("INVALID_SENDER_ADDRESS");
    }

    // …and none of those attempts partially applied.
    expect((await get(t, ownerId, workspaceId))?.allowedSenders).toEqual([OWNER_EMAIL]);
  });

  test("`*` is a legal local part, and it is stored as a literal, not a wildcard", async () => {
    // RFC 5322 atext includes `*`, so `*@example.test` is a real address and
    // refusing it would be wrong. What matters is that storing it admits that
    // one mailbox and nobody else — a matcher that treated it as a pattern
    // would hand an owner a domain-wide opening they did not ask for.
    const { t, ownerId, workspaceId } = await scenario();
    const settings = await asUser(t, ownerId).mutation(
      api.functions.ingestion.updateIngestionSettings,
      { workspaceId, allowedSenders: ["*@example.test"] },
    );

    expect(settings.allowedSenders).toEqual(["*@example.test"]);
    expect(senderIsAllowed("*@example.test", settings)).toBe(true);
    expect(senderIsAllowed("anyone@example.test", settings)).toBe(false);
  });

  test("a malformed domain is refused, including an address in the domain list", async () => {
    const { t, ownerId, workspaceId } = await scenario();

    for (const entry of ["*.example.test", "seyi@example.test", "localhost", "", "  "]) {
      const error = await captureError(() =>
        asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
          workspaceId,
          allowedDomains: [entry],
        }),
      );
      expect(errorCode(error)).toBe("INVALID_SENDER_DOMAIN");
    }
  });

  test("a bad target folder is refused with an actionable code", async () => {
    const { t, ownerId, workspaceId } = await scenario();

    for (const folder of ["../secrets", ".history", "", "0-inbox/../..", "a".repeat(2000)]) {
      const error = await captureError(() =>
        asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
          workspaceId,
          targetFolder: folder,
        }),
      );
      expect(errorCode(error)).toBe("INVALID_TARGET_FOLDER");
    }

    expect((await get(t, ownerId, workspaceId))?.targetFolder).toBe("0-inbox/");
  });

  test("the lists are capped", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const owner = asUser(t, ownerId);

    const tooManySenders = await captureError(() =>
      owner.mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowedSenders: Array.from(
          { length: MAX_ALLOWED_SENDERS + 1 },
          (_, i) => `person${i}@example.test`,
        ),
      }),
    );
    expect(errorCode(tooManySenders)).toBe("TOO_MANY_ALLOWED_SENDERS");

    const tooManyDomains = await captureError(() =>
      owner.mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowedDomains: Array.from(
          { length: MAX_ALLOWED_DOMAINS + 1 },
          (_, i) => `domain${i}.test`,
        ),
      }),
    );
    expect(errorCode(tooManyDomains)).toBe("TOO_MANY_ALLOWED_DOMAINS");

    // Exactly the cap is fine.
    const atCap = await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedSenders: Array.from(
        { length: MAX_ALLOWED_SENDERS },
        (_, i) => `person${i}@example.test`,
      ),
    });
    expect(atCap.allowedSenders).toHaveLength(MAX_ALLOWED_SENDERS);
  });

  test("what the console reads back is what the evaluator enforces", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedSenders: ["Seyi <SEYI@Example.test>"],
      allowedDomains: ["Publicworship.LIFE"],
    });

    const settings = await get(t, ownerId, workspaceId);
    expect(settings).not.toBeNull();
    expect(senderIsAllowed("seyi@example.test", settings!)).toBe(true);
    expect(senderIsAllowed("anyone@publicworship.life", settings!)).toBe(true);
    expect(senderIsAllowed("anyone@evil.publicworship.life", settings!)).toBe(false);
    expect(senderIsAllowed("anyone@notpublicworship.life", settings!)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("isolation", () => {
  test("one workspace's settings never leak into another's", async () => {
    const t = setupTest();
    const aliceId = await createUser(t, "alice@example.test");
    const bobId = await createUser(t, "bob@example.test");
    const alice = await createWorkspace(t, aliceId, "alice-ws");
    const bob = await createWorkspace(t, bobId, "bob-ws");

    await asUser(t, aliceId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId: alice,
      allowedDomains: ["publicworship.life"],
      targetFolder: "2-areas/alice",
    });

    expect(await get(t, bobId, bob)).toEqual({
      address: "bob-ws@context.lc",
      targetFolder: "0-inbox/",
      allowedSenders: ["bob@example.test"],
      allowedDomains: [],
      allowAnySender: false,
    });

    const error = await captureError(() => get(t, bobId, alice));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

/* -------------------------------------------------------------------------- */

describe("the audit trail", () => {
  async function events(t: TestConvex, workspaceId: Id<"workspaces">) {
    return await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
  }

  test("a change is recorded against the acting identity", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedDomains: ["publicworship.life"],
    });

    const rows = await events(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "ingestion.settings.updated",
      actorUserId: ownerId,
      paths: ["0-inbox/"],
    });
  });

  test("widening is flagged, whichever way it was widened", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    const owner = asUser(t, ownerId);

    await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedDomains: ["publicworship.life"],
    });
    await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedSenders: [OWNER_EMAIL, "colleague@example.test"],
    });
    await owner.mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowAnySender: true,
    });

    const rows = await events(t, workspaceId);
    expect(rows.map((row) => row.details?.widened)).toEqual([true, true, true]);
    expect(rows[2]?.details).toMatchObject({
      allowAnySenderBefore: false,
      allowAnySenderAfter: true,
    });
  });

  test("narrowing is recorded but not flagged as widening", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedSenders: [],
    });

    const rows = await events(t, workspaceId);
    expect(rows[0]?.details).toMatchObject({
      widened: false,
      sendersRemoved: 1,
      sendersAdded: 0,
      allowedSendersBefore: 1,
      allowedSendersAfter: 0,
    });
  });

  test("the audit row records counts, never the addresses", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowedSenders: [OWNER_EMAIL, "secret-correspondent@example.test"],
      allowedDomains: ["confidential-client.test"],
      targetFolder: "2-areas/mail",
    });

    const rows = await events(t, workspaceId);
    const serialized = JSON.stringify(rows);
    // An allowlist is a list of who somebody corresponds with. It must not end
    // up in an append-only trail that every member of a shared context reads.
    expect(serialized).not.toContain("secret-correspondent");
    expect(serialized).not.toContain("confidential-client");
    expect(serialized).not.toContain(OWNER_EMAIL);
    // What it does carry: the shape of the change, and the folder path.
    expect(rows[0]?.details).toMatchObject({
      allowedSendersBefore: 1,
      allowedSendersAfter: 2,
      allowedDomainsAfter: 1,
      targetFolderChanged: true,
      widened: true,
    });
    expect(rows[0]?.paths).toEqual(["2-areas/mail/"]);
  });

  test("a rejected change writes no audit row", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await captureError(() =>
      asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
        workspaceId,
        allowedSenders: ["nonsense"],
      }),
    );
    expect(await events(t, workspaceId)).toEqual([]);
  });

  test("the trail is readable by members through the audit query", async () => {
    const { t, ownerId, workspaceId } = await scenario();
    await asUser(t, ownerId).mutation(api.functions.ingestion.updateIngestionSettings, {
      workspaceId,
      allowAnySender: true,
    });

    const rows = await asUser(t, ownerId).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(rows.map((event) => event.action)).toContain("ingestion.settings.updated");
  });
});
