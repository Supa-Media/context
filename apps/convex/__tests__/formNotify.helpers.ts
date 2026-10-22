/**
 * A second context for `formNotify.test.ts`'s cross-tenant limiter case: its
 * own bucket, served by the same fetch socket (each stub answers 404 for a
 * bucket that is not its own), keyed like every workspace, with `1-projects`
 * shared with the team so its member can answer its form.
 */
import { vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3 } from "./storeStub.helpers";
import { asUser, copyTree, drainDueScheduled, seedStorageBinding, type TestConvex } from "./fixtures.helpers";

export async function bindSecondContext(
  t: TestConvex,
  owner: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const bucket = memoryS3("second-bucket");
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", "# Another context\n");
  const firstSocket = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await firstSocket(input, init);
    return response.status === 404 ? await bucket.fetchImpl(input, init) : response;
  });
  await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "second-bucket" });
  await copyTree(t, workspaceId);
  await drainDueScheduled(t);
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, { workspaceId, path: "1-projects", visibility: "team" });
}
