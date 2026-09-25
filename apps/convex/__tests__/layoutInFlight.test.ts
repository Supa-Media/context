import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import {
  FAKE_STORAGE,
  asUser,
  bindFakeStorage,
  createUser,
  createWorkspace,
  drainScheduled,
  setupTest,
} from "./fixtures.helpers";
import { memoryS3 } from "./storeStub.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A layout on its way, as the binding reports it.
 *
 * `applyStructure` queues the layout and returns; the job writes it a few
 * seconds later. In between, the bucket has no `privacy.md` — and the first
 * person to sign up after the first-run rebuild was shown a fails-closed
 * privacy warning for exactly that window. `scaffoldQueuedAt` is how the
 * console and `/welcome` tell "on its way" from "missing".
 */
describe("a layout in flight", () => {
  test("is visible as one, and stops being once it lands", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const backend = memoryS3(FAKE_STORAGE.bucket);
    vi.stubGlobal("fetch", backend.fetchImpl);
    await bindFakeStorage(t, owner, workspaceId);
    await drainScheduled(t);

    const binding = () =>
      asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId });
    expect((await binding())?.scaffoldQueuedAt).toBeUndefined();

    await asUser(t, owner).mutation(api.functions.workspaces.applyStructure, {
      workspaceId,
      template: "para",
    });
    const queued = await binding();
    expect(typeof queued?.scaffoldQueuedAt).toBe("number");
    expect(queued?.scaffoldReason).not.toBe("created");

    await drainScheduled(t);
    const landed = await binding();
    expect(landed?.scaffoldReason).toBe("created");
    expect(landed?.scaffoldQueuedAt).toBeUndefined();
  });
});
