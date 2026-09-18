/**
 * A capability that was probed, never stored, and therefore never had.
 *
 * `storageBindings.capabilities` held one boolean until 2026-09-12, when
 * `conditionalCreate` and `conditionalDelete` were added as optional fields.
 * Nothing went back for the rows that already existed, and the gateway reads
 * `declared && probed` (`store/factory.js`) — it cannot tell "probed false"
 * from "never asked", so it fails closed on both. That is the right rule and
 * it is not what changed here. What it meant in production is the subject of
 * this file: every binding older than that date reported no conditional
 * delete, `moveSafetyRefusal` turned every move into a refusal naming the
 * storage provider, and the bucket underneath was R2, which has supported all
 * of it the whole time.
 *
 * Nothing re-asked. There was no storage job in `crons.ts`, and
 * `reverifyStorage` needs an owner to press a button for a fault they cannot
 * see. `serverSideCopy` was worse: probed since #374 and absent from the
 * schema entirely, so no amount of re-verifying would ever have filled it in.
 *
 * What is proved here:
 *
 *  1. a legacy row is found and re-probed, and the fields arrive;
 *  2. a row that already carries every field is not re-probed — the sweep
 *     terminates instead of re-listing somebody's bucket hourly forever;
 *  3. a row that is not `connected` is left to its owner;
 *  4. the batch is bounded, and the filter runs before the bound, so a
 *     deployment whose first rows are already repaired still reaches the rest.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
  FAKE_STORAGE,
  createUser,
  createWorkspace,
  drainScheduled,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";
import { memoryS3 } from "./storeStub.helpers";
import { CAPABILITY_SWEEP_BATCH } from "../functions/storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Exactly what a row written before 2026-09-12 carries, and nothing more. */
const LEGACY_CAPABILITIES = { conditionalWrite: true };

/** What a row written after this change carries once it has been probed. */
const PROBED_CAPABILITIES = {
  conditionalWrite: true,
  conditionalCreate: true,
  conditionalDelete: true,
  serverSideCopy: true,
};

/**
 * A deployment holding `bindings` workspaces, one owner each.
 *
 * One owner per workspace rather than one owner for all of them: creating
 * contexts is rate limited per user (`WORKSPACE_CREATE_LIMIT`), and a test
 * that needs more than a batch of them would otherwise be measuring that
 * limit instead of the sweep.
 */
async function deployment(bindings: number) {
  const t: TestConvex = setupTest();
  const backend = memoryS3(FAKE_STORAGE.bucket);
  vi.stubGlobal("fetch", backend.fetchImpl);
  const owners: Id<"users">[] = [];
  const workspaceIds: Id<"workspaces">[] = [];
  for (let index = 0; index < bindings; index += 1) {
    const owner = await createUser(t, `owner-${index}@example.invalid`);
    owners.push(owner);
    workspaceIds.push(await createWorkspace(t, owner, `atlas-${index}`));
  }
  return { t, owner: owners[0], owners, backend, workspaceIds };
}

function sweep(t: TestConvex) {
  return t.mutation(internal.functions.storage.sweepUnprobedCapabilities, {});
}

function capabilitiesOf(t: TestConvex, workspaceId: Id<"workspaces">) {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return row?.capabilities;
  });
}

describe("a binding older than the capability fields", () => {
  /**
   * The repair, and the customer-visible fault it answers. A managed R2
   * workspace on the paid plan could not archive or move a note, and the
   * refusal blamed the storage provider.
   */
  test("is re-probed, and the missing fields arrive", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: LEGACY_CAPABILITIES,
    });

    // The fault, stated as the gateway sees it: the field is not `false`, it
    // is absent, and `store/factory.js` has no way to tell those apart.
    expect(await capabilitiesOf(t, workspaceIds[0])).toEqual(
      LEGACY_CAPABILITIES,
    );

    expect(await sweep(t)).toEqual({ queued: 1 });
    await drainScheduled(t);

    expect(await capabilitiesOf(t, workspaceIds[0])).toEqual(
      PROBED_CAPABILITIES,
    );
  });

  /**
   * Non-vacuity for the test above. Without the sweep the row stays legacy
   * forever — nothing else in the deployment ever asks.
   */
  test("stays broken if nothing sweeps", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: LEGACY_CAPABILITIES,
    });

    await drainScheduled(t);

    expect(await capabilitiesOf(t, workspaceIds[0])).toEqual(
      LEGACY_CAPABILITIES,
    );
  });
});

describe("a probe nobody asked for is still on the record", () => {
  /**
   * `verifyStorageBinding` audits nothing of its own — `reverifyStorage` is
   * what records a probe somebody requested. Without a row here the owner
   * would find probe objects appearing and disappearing under `.context/` in
   * a bucket they are told they own, and nothing in their trail accounting
   * for it. The actor is absent because there is not one, which is the honest
   * record of a system action rather than a missing one.
   */
  test("the sweep audits the workspace it re-probes, with no actor", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: LEGACY_CAPABILITIES,
    });

    await sweep(t);

    const events = await t.run(async (ctx) =>
      await ctx.db
        .query("auditEvents")
        .filter((q) =>
          q.eq(q.field("action"), "storage.capability_reprobe_queued"),
        )
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].workspaceId).toEqual(workspaceIds[0]);
    expect(events[0].actorUserId).toBeUndefined();
    expect(events[0].details).toEqual({ fromStatus: "connected" });
  });

  test("a sweep that queues nothing audits nothing", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: PROBED_CAPABILITIES,
    });

    await sweep(t);

    const events = await t.run(async (ctx) =>
      await ctx.db
        .query("auditEvents")
        .filter((q) =>
          q.eq(q.field("action"), "storage.capability_reprobe_queued"),
        )
        .collect(),
    );
    expect(events).toHaveLength(0);
  });
});

describe("the sweep terminates", () => {
  test("a fully probed binding is not re-probed", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: PROBED_CAPABILITIES,
    });

    expect(await sweep(t)).toEqual({ queued: 0 });
  });

  /** Two runs, one repair: the second finds nothing left to do. */
  test("a repaired binding is not swept twice", async () => {
    const { t, owner, workspaceIds } = await deployment(1);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "connected",
      capabilities: LEGACY_CAPABILITIES,
    });

    expect(await sweep(t)).toEqual({ queued: 1 });
    await drainScheduled(t);
    expect(await sweep(t)).toEqual({ queued: 0 });
  });

  /**
   * An `error` or `unverified` row has an owner already being told to act, and
   * re-probing a credential the provider has revoked on an hourly clock is
   * noise against somebody else's endpoint.
   */
  test("a binding that is not connected is left to its owner", async () => {
    const { t, owner, owners, workspaceIds } = await deployment(2);
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[0],
      boundBy: owner,
      status: "error",
      capabilities: LEGACY_CAPABILITIES,
    });
    await seedStorageBinding(t, {
      workspaceId: workspaceIds[1],
      boundBy: owners[1],
      status: "unverified",
      capabilities: LEGACY_CAPABILITIES,
    });

    expect(await sweep(t)).toEqual({ queued: 0 });
  });
});

describe("the batch is bounded", () => {
  /**
   * The bound is on the transaction, not on the backlog: a deployment with
   * more legacy rows than one batch drains over several runs.
   *
   * The ordering matters as much as the count. `.filter()` runs before
   * `.take()`, so a deployment whose oldest rows are already repaired does not
   * spend every run re-examining them and never reach the ones that are not —
   * which is what a bare `.take()` over the table would have done.
   */
  test("more legacy rows than one batch drain over several runs", async () => {
    const extra = 3;
    const { t, owners, workspaceIds } = await deployment(
      CAPABILITY_SWEEP_BATCH + extra,
    );
    for (const [index, workspaceId] of workspaceIds.entries()) {
      await seedStorageBinding(t, {
        workspaceId,
        boundBy: owners[index],
        status: "connected",
        capabilities: LEGACY_CAPABILITIES,
      });
    }

    expect(await sweep(t)).toEqual({ queued: CAPABILITY_SWEEP_BATCH });
    await drainScheduled(t);

    expect(await sweep(t)).toEqual({ queued: extra });
    await drainScheduled(t);

    expect(await sweep(t)).toEqual({ queued: 0 });
    for (const workspaceId of workspaceIds) {
      expect(await capabilitiesOf(t, workspaceId)).toEqual(
        PROBED_CAPABILITIES,
      );
    }
  });
});
