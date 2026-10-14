/**
 * `/gateway/ingest/binding` carries the free managed tier's note cap.
 *
 * The email worker enforces it through the gateway's own store factory
 * (`infra/email-worker`, "a personal context on the free tier that is full");
 * this proves the control plane sends it — beside the binding, for the
 * workspace the ticket names, and for nobody else.
 *
 * The count beside it comes from the Convex tree, never the bucket: the
 * worker's store has no tree of its own to ask.
 *
 * Sabotage: the route not reading the cap fails the first; not sending the
 * tree's count fails the first and the third.
 */

import { describe, expect, test } from "vitest";
import { createUser, createWorkspace, ingestPost, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP } from "../../functions/lib/premium";
import { BINDING, OWNER_EMAIL, ready, resolvedTicket } from "./fixtures.helpers";

describe("the ingestion credential and the note cap", () => {
  async function freeContext() {
    const t = setupTest();
    const ownerId = await createUser(t, OWNER_EMAIL);
    const workspaceId = await createWorkspace(t, ownerId, "seyi", { kind: "personal" });
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: ownerId,
      status: "connected",
      bucket: managedBucketName(workspaceId),
    });
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
    return { t, workspaceId };
  }

  test("a free personal context on our bucket is sent its cap and its count, beside the binding", async () => {
    const { t, workspaceId } = await freeContext();
    const paths = ["1-projects/a.md", "1-projects/b.md", "2-areas/picture.png", ".context/x.md"];
    await t.run(async (ctx) => {
      for (const path of paths) {
        await ctx.db.insert("nodes", { workspaceId, path, name: path.split("/").pop()!, kind: "file", observedAt: 1 });
      }
      await ctx.db.insert("nodeTrees", { workspaceId, status: "ready", dirty: false, files: paths.length, sweptAt: 1 });
    });

    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding).toMatchObject({ workspaceId });
    expect(body.noteCap).toBe(FREE_MANAGED_NOTE_CAP);
    expect(body.noteCount).toBe(2);
    expect(body.binding.noteCap).toBeUndefined();
  });

  test("while the tree is still loading the count is null, so the worker admits rather than guesses", async () => {
    const { t } = await freeContext();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.noteCap).toBe(FREE_MANAGED_NOTE_CAP);
    expect(body.noteCount).toBeNull();
  });

  test("an ordinary personal context is sent none", async () => {
    const { t } = await ready();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding).toBeTruthy();
    expect("noteCap" in body).toBe(false);
    expect("noteCount" in body).toBe(false);
  });
});
