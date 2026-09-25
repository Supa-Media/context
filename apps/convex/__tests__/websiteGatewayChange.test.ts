/**
 * Two processes write a customer's bucket, and only one of them used to say so.
 *
 * `runFileOperation` marks the route index stale after a write under
 * `website/` (`websites/changes.ts`). The gateway writes the same bucket
 * itself — an MCP client saving a page, a live editing session flushing one —
 * and its only channels back carried audiences and a boolean, no way to say
 * "the published folder moved".
 *
 * That mattered beyond freshness. The resolver re-reads the page it serves and
 * compares the effective etag, so a restricted page's *body* was never served
 * stale. Its **menu entry** was: `navigation` is built from index rows and
 * returned on every answer, including to a caller with no session asking for a
 * path that does not exist. So a page an owner had just made members-only kept
 * its title and its working URL in the public menu until the quarter-hourly
 * sweep.
 *
 * `/gateway/website` is the missing sentence. It carries a workspace id and
 * nothing else.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  gatewayPost,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 0\n---\n\n# Atlas\n";
const PUBLIC_NOTES =
  "---\ntitle: Board notes\nnav: 1\n---\n\nAnyone may read.\n";
const RESTRICTED_NOTES =
  "---\ntitle: Board notes\nnav: 1\naudience: members\n---\n\nMembers only.\n";

async function liveSite() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Atlas\n");
  backend.seed("website/index.md", HOME);
  backend.seed("website/notes.md", PUBLIC_NOTES);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  await asUser(t, owner).action(api.functions.workspaces.enableWebsite, {
    workspaceId,
  });
  await drainScheduled(t);
  return { t, owner, workspaceId, backend };
}

/** The queued rebuild, run now rather than after its debounce. */
async function pendingRebuilds(t: ReturnType<typeof setupTest>) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter(
    (job) =>
      job.name.includes("reconcileWorkspace") && job.state.kind === "pending",
  );
}

/** The menu a caller with no session is handed, whatever they asked for. */
async function publicMenu(t: ReturnType<typeof setupTest>, routePath: string) {
  const answer = await t.action(api.functions.websites.resolvePage, {
    handle: "atlas",
    routePath,
  });
  return (answer as { navigation: { routePath: string; title: string }[] })
    .navigation;
}

describe("a bucket change the console did not make", () => {
  test("drops a restricted page from the public menu once the gateway says the site moved", async () => {
    const f = await liveSite();
    expect(await publicMenu(f.t, "/")).toContainEqual({
      routePath: "/notes",
      title: "Board notes",
    });

    // The owner restricts the page from an AI client. The gateway writes the
    // object itself, so no Convex file operation runs and nothing has yet
    // told the control plane that its derivative is out of date.
    f.backend.seed("website/notes.md", RESTRICTED_NOTES);

    // Asking for a path that does not exist is enough to be handed the menu,
    // and it never touches the restricted page's own source, so the page-level
    // etag re-check that protects the body cannot help here.
    expect(await publicMenu(f.t, "/no-such-page")).toContainEqual({
      routePath: "/notes",
      title: "Board notes",
    });

    const response = await gatewayPost(f.t, "/gateway/website", {
      workspaceId: f.workspaceId,
    });
    expect(response.status).toBe(200);
    expect(await pendingRebuilds(f.t)).toHaveLength(1);
    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });

    for (const asked of ["/", "/no-such-page"]) {
      expect(await publicMenu(f.t, asked)).not.toContainEqual(
        expect.objectContaining({ title: "Board notes" }),
      );
    }
  }, 20_000);

  test("keeps serving the pages that are still public", async () => {
    const f = await liveSite();
    f.backend.seed("website/notes.md", RESTRICTED_NOTES);
    await gatewayPost(f.t, "/gateway/website", { workspaceId: f.workspaceId });
    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({ kind: "page", title: "Home" });
  }, 20_000);

  test("answers the same to a caller without the gateway secret, and changes nothing", async () => {
    const f = await liveSite();
    f.backend.seed("website/notes.md", RESTRICTED_NOTES);

    const refused = await gatewayPost(
      f.t,
      "/gateway/website",
      { workspaceId: f.workspaceId },
      { secret: null },
    );
    expect(refused.status).not.toBe(200);
    expect(await pendingRebuilds(f.t)).toHaveLength(0);

    // Unauthorised means untouched: the index is still the one it was.
    expect(await publicMenu(f.t, "/")).toContainEqual({
      routePath: "/notes",
      title: "Board notes",
    });
  }, 20_000);

  test("a workspace with no site answers ok and schedules nothing", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "quiet");
    const backend = memoryS3(FAKE_STORAGE.bucket);
    backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    vi.stubGlobal("fetch", backend.fetchImpl);
    await seedStorageBinding(t, { workspaceId, boundBy: owner });

    const response = await gatewayPost(t, "/gateway/website", { workspaceId });
    expect(response.status).toBe(200);
    expect(await pendingRebuilds(t)).toHaveLength(0);
  }, 20_000);
});
