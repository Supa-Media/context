/**
 * One enabled website over an in-memory bucket, shared by the resolution
 * suites: an owner, a member, a stranger with a workspace of their own, and a
 * site whose route index has been built once.
 */

import { vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

export interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: ReturnType<typeof memoryS3>;
}

export async function fixture(slug = "atlas"): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const member = await createUser(t, `${slug}-member@example.invalid`);
  const stranger = await createUser(t, `${slug}-stranger@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug, {
    displayName: slug === "atlas" ? "Atlas Studio" : slug,
  });
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, `${slug}-elsewhere`);
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", `# ${slug}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, member, stranger, workspaceId, backend };
}

/**
 * What turning a website on writes to `privacy.md`: the `website/` folder at
 * `team`, which is the only thing that lets the site serve a page.
 */
export async function publishWebsiteFolder(
  t: TestConvex,
  owner: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "website",
    visibility: "team",
  });
}

export async function publish(f: Fixture): Promise<void> {
  await publishWebsiteFolder(f.t, f.owner, f.workspaceId);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("websiteStates", {
      workspaceId: f.workspaceId,
      state: "enabled",
      enabledAt: Date.now(),
      enabledBy: f.owner,
      publicationRuleEnsuredAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  await asUser(f.t, f.owner).action(
    api.functions.websites.refreshRouteStatuses,
    { workspaceId: f.workspaceId },
  );
}

/** Someone pressing Publish: what the folder holds now becomes the site. */
export async function pressPublish(f: Fixture, as: Id<"users"> = f.owner) {
  return await asUser(f.t, as).action(api.functions.websites.publish, {
    workspaceId: f.workspaceId,
  });
}
