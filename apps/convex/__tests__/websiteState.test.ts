/**
 * Turning a website on is a two-boundary operation: first ensure the starter
 * exists in the customer's bucket without overwriting it, then record the
 * control-plane lifecycle state. Turning it off does the reverse amount of
 * work: change only lifecycle state and leave every customer-owned file alone.
 *
 * The ordering is the safety property. A failed bucket write must leave the
 * site disabled, while a concurrent or repeated enable must accept an existing
 * homepage byte-for-byte instead of treating it as ours to rewrite.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { WEBSITE_STARTER_MARKDOWN } from "@context/shared";
import { memoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import type { Id } from "../_generated/dataModel";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: ReturnType<typeof memoryS3>;
}

async function fixture(options: MemoryS3Options = {}): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, options);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Atlas\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, editor, member, stranger, workspaceId, backend };
}

async function websiteAuditActions(f: Fixture): Promise<string[]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .collect();
    return rows
      .map((row) => row.action)
      .filter((action) => action.startsWith("website."));
  });
}

describe("website lifecycle state", () => {
  test("starts disabled and is visible without granting management", async () => {
    const f = await fixture();
    const owner = await asUser(f.t, f.owner).query(
      api.functions.workspaces.getWebsiteState,
      { workspaceId: f.workspaceId },
    );
    const member = await asUser(f.t, f.member).query(
      api.functions.workspaces.getWebsiteState,
      { workspaceId: f.workspaceId },
    );

    expect(owner).toEqual({
      contractVersion: 1,
      state: "disabled",
      root: "website",
      handlePath: "/@atlas/",
      canManage: true,
    });
    expect(member).toEqual({ ...owner, canManage: false });
  });

  test("a stranger learns no state or handle", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.stranger).query(api.functions.workspaces.getWebsiteState, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("enable creates the missing homepage, then records enabled state", async () => {
    const f = await fixture();
    const enabled = await asUser(f.t, f.owner).action(
      api.functions.workspaces.enableWebsite,
      { workspaceId: f.workspaceId },
    );

    expect(enabled).toMatchObject({
      contractVersion: 1,
      state: "enabled",
      root: "website",
      handlePath: "/@atlas/",
      canManage: true,
      starter: "created",
    });
    expect(enabled.enabledAt).toEqual(expect.any(Number));
    expect(f.backend.snapshot()["website/index.md"]).toBe(
      WEBSITE_STARTER_MARKDOWN,
    );
    expect(
      await asUser(f.t, f.member).query(
        api.functions.workspaces.getWebsiteState,
        { workspaceId: f.workspaceId },
      ),
    ).toMatchObject({ state: "enabled", canManage: false });
  });

  test("an existing homepage is authoritative and remains byte-identical", async () => {
    const f = await fixture();
    const existing = "---\ntitle: Kept\n---\n\n# Do not replace me\n";
    f.backend.seed("website/index.md", existing);

    const enabled = await asUser(f.t, f.owner).action(
      api.functions.workspaces.enableWebsite,
      { workspaceId: f.workspaceId },
    );
    expect(enabled).toMatchObject({ state: "enabled", starter: "existing" });
    expect(f.backend.snapshot()["website/index.md"]).toBe(existing);
  });

  test("enable is idempotent and does not touch the bucket twice", async () => {
    const f = await fixture();
    const first = await asUser(f.t, f.owner).action(
      api.functions.workspaces.enableWebsite,
      { workspaceId: f.workspaceId },
    );
    const requests = f.backend.requests.length;
    const second = await asUser(f.t, f.owner).action(
      api.functions.workspaces.enableWebsite,
      { workspaceId: f.workspaceId },
    );

    expect(second).toMatchObject({
      state: "enabled",
      enabledAt: first.enabledAt,
      starter: "existing",
    });
    expect(f.backend.requests).toHaveLength(requests);
    expect(await websiteAuditActions(f)).toEqual(["website.enabled"]);
  });

  test("a failed starter write leaves the lifecycle disabled", async () => {
    const f = await fixture({
      refuseWrite: (key) => key === "website/index.md",
    });
    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(failure)).toBe("STORAGE_FAILED");
    expect(
      await asUser(f.t, f.owner).query(
        api.functions.workspaces.getWebsiteState,
        { workspaceId: f.workspaceId },
      ),
    ).toMatchObject({ state: "disabled" });
  });

  test("only the role that manages Settings may enable or disable", async () => {
    const f = await fixture();
    const before = f.backend.requests.length;
    const editorEnable = await captureError(() =>
      asUser(f.t, f.editor).action(api.functions.workspaces.enableWebsite, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(editorEnable)).toBe("INSUFFICIENT_ROLE");
    expect(f.backend.requests).toHaveLength(before);

    const strangerEnable = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.workspaces.enableWebsite, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(strangerEnable)).toBe("WORKSPACE_NOT_FOUND");
    expect(f.backend.requests).toHaveLength(before);

    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    const editorDisable = await captureError(() =>
      asUser(f.t, f.editor).mutation(api.functions.workspaces.disableWebsite, {
        workspaceId: f.workspaceId,
      }),
    );
    expect(errorCode(editorDisable)).toBe("INSUFFICIENT_ROLE");
  });

  test("disable is idempotent and preserves every website file", async () => {
    const f = await fixture();
    f.backend.seed("website/about.md", "# About\n");
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    const before = f.backend.snapshot();

    const first = await asUser(f.t, f.owner).mutation(
      api.functions.workspaces.disableWebsite,
      { workspaceId: f.workspaceId },
    );
    const second = await asUser(f.t, f.owner).mutation(
      api.functions.workspaces.disableWebsite,
      { workspaceId: f.workspaceId },
    );

    expect(first).toMatchObject({ state: "disabled", canManage: true });
    expect(second).toEqual(first);
    expect(f.backend.snapshot()).toEqual(before);
    expect(await websiteAuditActions(f)).toEqual([
      "website.enabled",
      "website.disabled",
    ]);
  });

  test("state rows are tenant-scoped even when workspaces use the same route", async () => {
    const f = await fixture();
    const otherOwner = await createUser(f.t, "other@example.invalid");
    const otherWorkspaceId = await createWorkspace(
      f.t,
      otherOwner,
      "other-atlas",
    );

    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    expect(
      await asUser(f.t, otherOwner).query(
        api.functions.workspaces.getWebsiteState,
        { workspaceId: otherWorkspaceId },
      ),
    ).toMatchObject({ state: "disabled", handlePath: "/@other-atlas/" });
  });
});
