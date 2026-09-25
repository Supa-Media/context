/**
 * A stale route index drops the site's menu, so the site must not wait for the
 * quarter-hourly sweep to become fresh again. Turning a site on indexes its
 * homepage at once, and every invalidation (a save under `website/`, or a
 * source mismatch the resolver noticed) queues one rebuild shortly after.
 *
 * Without this, the Settings card said Live while the site said "Nothing
 * here" for up to fifteen minutes after enabling and after every edit.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { RECONCILE_AFTER_CHANGE_MS } from "../functions/lib/websites/routes";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Atlas\n");
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId };
}

const reconcileJobs = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("reconcileWorkspace") && job.state.kind === "pending",
  );

describe("website index freshness", () => {
  test("turning a site on serves its homepage without waiting for the sweep", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    await drainScheduled(f.t);

    const page = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(page).toMatchObject({ kind: "page", title: "Home" });
  }, 15_000);

  test("an invalidation queues one rebuild shortly after, and a burst shares it", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    await drainScheduled(f.t);

    const before = Date.now();
    await f.t.mutation(internal.functions.websites.invalidateRouteIndex, { workspaceId: f.workspaceId });
    await f.t.mutation(internal.functions.websites.invalidateRouteIndex, { workspaceId: f.workspaceId });
    const jobs = await reconcileJobs(f);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.scheduledTime).toBeGreaterThanOrEqual(before + RECONCILE_AFTER_CHANGE_MS - 50);

    // What that job does: the index is fresh again and the page is served.
    await f.t.action(internal.functions.websites.reconcileWorkspace, { workspaceId: f.workspaceId });
    const page = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(page).toMatchObject({ kind: "page", title: "Home" });
  }, 15_000);

  test("an open page can watch its site's revision, and a save moves it", async () => {
    const f = await fixture();
    const revision = () => f.t.query(api.functions.websites.siteRevision, { handle: "@Atlas" });
    await expect(revision()).resolves.toBeNull();
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    await drainScheduled(f.t);

    const before = await revision();
    expect(before).toEqual(expect.any(String));
    await f.t.mutation(internal.functions.websites.invalidateRouteIndex, { workspaceId: f.workspaceId });
    expect(await revision()).not.toBe(before);
    await expect(f.t.query(api.functions.websites.siteRevision, { handle: "nobody" })).resolves.toBeNull();
  }, 15_000);
});
