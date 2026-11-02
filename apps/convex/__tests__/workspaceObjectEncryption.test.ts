/**
 * Every workspace object is told whether its workspace holds a data key, from the key rows
 * (`functions/workspaceObjectEncryption.ts`), so a workspace copied before the object knew (`encryption: null`) can
 * open its store from the object. Sabotage, each confirmed to fail a case here: answer `none` without reading the key
 * rows (the keyed workspace reads `none`), skip `dual` homes, write on a dry run.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createWorkspace } from "./fixtures.helpers";
import { setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const objectOf = (w: Awaited<ReturnType<typeof world>>, workspaceId: Id<"workspaces">) => w.stores.get(`workspace:${workspaceId}`);

describe("workspace objects learn whether their workspace is keyed", () => {
  test("an unkeyed and a keyed workspace, copied before either was recorded, are each told from their key rows", async () => {
    const w = await world();
    const keyedId = await createWorkspace(w.t, w.owner, "object-keyed", { kind: "shared" });
    const outside = await createWorkspace(w.t, w.owner, "object-outside", { kind: "shared" });
    await setHome(w.t, w.workspaceId, "object");
    await setHome(w.t, keyedId, "dual");
    await setHome(w.t, outside, "bucket");
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workspaceDataKeys", { workspaceId: keyedId, generation: "g1", encryptedDataKey: "sealed-fake", createdAt: Date.now() } as never);
    });

    const dry = await w.t.action(internal.functions.workspaceObjectEncryption.record, { dryRun: true });
    expect(dry).toEqual({ checked: 2, keyed: 1, none: 1, unreachable: 0, failed: 0 });
    expect(w.ops()).toEqual([]);

    const ran = await w.t.action(internal.functions.workspaceObjectEncryption.record, { dryRun: false });
    expect(ran).toEqual({ checked: 2, keyed: 1, none: 1, unreachable: 0, failed: 0 });
    expect(objectOf(w, w.workspaceId)!.rows.encryption()).toBe("none");
    expect(objectOf(w, keyedId)!.rows.encryption()).toBe("keyed");
    expect(objectOf(w, outside)).toBeUndefined();
  });

  test("a workspace keyed since stays keyed when the run read it before its key", async () => {
    const w = await world();
    await setHome(w.t, w.workspaceId, "object");
    await w.t.action(internal.functions.workspaceObjectEncryption.record, { dryRun: false });
    // The owner turned encryption on; the object was told `keyed` (`encryptionKeys.ts`), then a late run says `none`.
    objectOf(w, w.workspaceId)!.rows.setEncryption("keyed");
    await w.t.action(internal.functions.workspaceObjectEncryption.record, { dryRun: false });
    expect(objectOf(w, w.workspaceId)!.rows.encryption()).toBe("keyed");
  });
});
