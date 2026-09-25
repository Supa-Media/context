/**
 * `/gateway/ingest/binding` carries the free managed tier's note cap.
 *
 * The email worker enforces it through the gateway's own store factory
 * (`infra/email-worker`, "a personal context on the free tier that is full");
 * this proves the control plane sends it — beside the binding, for the
 * workspace the ticket names, and for nobody else.
 *
 * Sabotage: the route not reading the cap fails the first.
 */

import { describe, expect, test } from "vitest";
import { createUser, createWorkspace, ingestPost, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP } from "../../functions/lib/premium";
import { BINDING, OWNER_EMAIL, ready, resolvedTicket } from "./fixtures.helpers";

describe("the ingestion credential and the note cap", () => {
  test("a free personal context on our bucket is sent its cap, beside the binding", async () => {
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

    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding).toMatchObject({ workspaceId });
    expect(body.noteCap).toBe(FREE_MANAGED_NOTE_CAP);
    expect(body.binding.noteCap).toBeUndefined();
  });

  test("an ordinary personal context is sent none", async () => {
    const { t } = await ready();
    const body = await (await ingestPost(t, BINDING, { ticket: await resolvedTicket(t, "seyi") })).json();
    expect(body.binding).toBeTruthy();
    expect("noteCap" in body).toBe(false);
  });
});
