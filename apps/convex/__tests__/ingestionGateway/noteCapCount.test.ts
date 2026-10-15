/**
 * `/gateway/ingest/binding` sends the note count beside the cap.
 *
 * Since #1613 the cap counts the Convex tree, never the bucket, and a store
 * with no count admits every create. The email worker cannot ask the tree
 * itself, so this route sends the count with the cap, read from the tree's
 * rows for the workspace the ticket names (`lib/nodes/servedCount.ts`). Its
 * worker half is `infra/email-worker`, "counts what the tree says".
 *
 * The tree's read is stubbed here; `nodes/servedNoteCount.test.ts` proves
 * what it counts.
 *
 * Sabotage: the route not sending the count fails the first.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const counted = vi.hoisted(() => ({ value: null as { notes: number; truncated: false } | null, calls: 0 }));
vi.mock("../../functions/lib/nodes/servedCount", () => ({
  servedNoteCount: async () => {
    counted.calls += 1;
    return counted.value;
  },
}));

import { createUser, createWorkspace, ingestPost, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { BINDING, OWNER_EMAIL, ready, resolvedTicket } from "./fixtures.helpers";

afterEach(() => {
  counted.value = null;
  counted.calls = 0;
});

async function freeManaged() {
  const t = setupTest();
  const ownerId = await createUser(t, OWNER_EMAIL);
  const workspaceId = await createWorkspace(t, ownerId, "seyi", { kind: "personal" });
  await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "connected", bucket: managedBucketName(workspaceId) });
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "none",
      freeManaged: true,
      createdAt: 0,
      updatedAt: 0,
    }),
  );
  return t;
}

describe("the note count beside the cap", () => {
  test("a capped context is sent the tree's count", async () => {
    counted.value = { notes: 912, truncated: false };
    const t = await freeManaged();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.noteCount).toBe(912);
    expect(body.binding.noteCount).toBeUndefined();
  });

  test("a tree that cannot count sends none, and the cap still goes", async () => {
    const t = await freeManaged();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(typeof body.noteCap).toBe("number");
    expect("noteCount" in body).toBe(false);
  });

  test("an uncapped context is never counted", async () => {
    counted.value = { notes: 912, truncated: false };
    const { t } = await ready();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect("noteCount" in body).toBe(false);
    expect(counted.calls).toBe(0);
  });
});
