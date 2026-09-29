/**
 * SCAFFOLDING INTO A SEALED BUCKET — the layout a person picks is written
 * through the same encryption every reader uses.
 *
 * A managed workspace is enrolled when its bucket is bound, and an empty
 * bucket reaches `encrypted` in one walk. The layout is chosen later, so the
 * scaffolder is a writer that arrives *after* the mode is set — and it builds
 * its own store rather than the gateway's. Written plain, its `index.md` and
 * `privacy.md` are refused on every read that follows, and the walk does not
 * come back for them.
 *
 * The probe keeps the bare store deliberately: it writes and deletes its own
 * object under `.context/probes/` with that same store, and nothing reads a
 * probe object through the gateway.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   scaffold store built without `managedEncryption`                 1
 *   `probeCapabilities` returning before the encryption wrapper      1
 *   the option passed for a workspace with no encryption row         1
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { asUser, drainScheduled } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

const PARA = { template: "para" as const, folders: [], kind: "personal" as const };

/** Everything the scaffolder wrote, which is every key that is not a probe. */
function scaffolded(backend: { objects: Map<string, unknown> }): string[] {
  return [...backend.objects.keys()].filter((key) => !key.startsWith(".context/probes/"));
}

describe("a layout applied to a sealed bucket", () => {
  test("is written sealed, and reads back through the product", async () => {
    const { t, staff, ours, backend } = await fixture();
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });

    // The bucket a newly provisioned workspace starts with: empty, and already
    // through the walk, because a walk over nothing finishes in one pass.
    backend.objects.clear();

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId: ours,
      actorUserId: staff,
      structure: PARA,
    });

    const written = scaffolded(backend);
    expect(written).toContain(PRIVACY_KEY);
    expect(written).toContain("index.md");
    for (const key of written) {
      expect(isSealed(backend.bytesOf(key)), `${key} was written in the clear`).toBe(true);
    }

    const note = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "index.md",
    });
    expect(note.text.length).toBeGreaterThan(0);
  });

  test("a bucket nobody enrolled is still written plain", async () => {
    // Same workspace, same bucket — but no rollout, so no encryption row. The
    // fix must not start sealing buckets that were never enrolled.
    const { t, staff, ours, backend } = await fixture();
    expect(await row(t, ours)).toBeNull();
    backend.objects.clear();

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId: ours,
      actorUserId: staff,
      structure: PARA,
    });

    const written = scaffolded(backend);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(isSealed(backend.bytesOf(key)), `${key} was sealed without a rollout`).toBe(false);
    }
  });
});
