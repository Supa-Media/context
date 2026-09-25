/**
 * `/gateway/binding` carries the free managed tier's note cap, as a sibling.
 *
 * The gateway enforces the cap (`apps/mcp/src/store/noteCap.js`); this proves
 * the control plane sends it — only for a free context on a bucket we run and
 * not paying, never inside the binding, and absent for everybody else. An
 * absent cap is the ordinary state and costs nothing.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  gatewayPost,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP } from "../../functions/lib/premium";
import { CLIENT_A, bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

async function connected(
  t: TestConvex,
  slug: string,
  plan: { freeManaged?: boolean; status?: "none" | "active" } | null,
  managed: boolean,
) {
  const user = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, user, slug);
  await seedStorageBinding(t, {
    workspaceId,
    boundBy: user,
    ...(managed ? { bucket: managedBucketName(workspaceId) } : {}),
  });
  if (plan !== null) {
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
        status: plan.status ?? "none",
        freeManaged: plan.freeManaged,
        createdAt: 0,
        updatedAt: 0,
      }),
    );
  }
  await registerClient(t, CLIENT_A);
  const accessToken = token(`${slug}_owner`);
  await seedConnectedClient(t, { workspaceId, userId: user, clientId: CLIENT_A, accessToken });
  return { workspaceId: workspaceId as Id<"workspaces">, accessToken };
}

async function open(t: TestConvex, accessToken: string) {
  return await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken, expectedWorkspaceId: null }));
}

describe("/gateway/binding and the note cap", () => {
  test("a free context on our bucket is sent its cap, beside the binding", async () => {
    const t = setupTest();
    const { accessToken } = await connected(t, "capfree", { freeManaged: true }, true);
    const body = await open(t, accessToken);
    expect(body.noteCap).toBe(FREE_MANAGED_NOTE_CAP);
    expect((body.binding as Record<string, unknown>).noteCap).toBeUndefined();
  });

  test("paying lifts it", async () => {
    const t = setupTest();
    const { accessToken } = await connected(t, "cappaid", { freeManaged: true, status: "active" }, true);
    expect("noteCap" in (await open(t, accessToken))).toBe(false);
  });

  test("a bucket the customer owns is never capped by us", async () => {
    const t = setupTest();
    const { accessToken } = await connected(t, "capowned", { freeManaged: true }, false);
    expect("noteCap" in (await open(t, accessToken))).toBe(false);
  });

  test("an ordinary context has no cap at all", async () => {
    const t = setupTest();
    const { accessToken } = await connected(t, "capnone", null, false);
    const body = await open(t, accessToken);
    expect(body.binding).toBeTruthy();
    expect("noteCap" in body).toBe(false);
  });
});
