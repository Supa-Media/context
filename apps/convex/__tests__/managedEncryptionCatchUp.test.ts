/**
 * A move's catch-up passes (`functions/moveCatchUp.ts`) with an encrypted
 * managed bucket on either side.
 *
 * Moving out, the passes read the managed bucket the workspace has just left.
 * The binding is the customer's by then, so the ordinary mode lookup answers
 * plain; read that way, a late sealed file would be copied into the
 * customer's bucket as ciphertext. Moving back in, the passes write into the
 * managed bucket, which may already be encrypted again; a late file written
 * plain there would be refused as unreadable.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *  - The old-bucket store built without `keptManagedBucketOption`: 1 failure
 *    (ciphertext lands in the customer's bucket).
 *  - The old-bucket store built with `managedEncryptionOption` (follows the
 *    binding): 1 failure, the same one.
 *  - The new-bucket store built without `managedEncryptionOption`: 1 failure
 *    (a late file lands plain in an encrypted bucket and is refused).
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { managedBucketName } from "../functions/lib/managedStorage";
import { asUser, drainScheduled } from "./fixtures.helpers";
import {
  MANAGED_ENDPOINT,
  cancelLaterJobs,
  encryptedThenMovedOut,
  isSealed,
  readyMigration,
  resetAfterEach,
  row,
} from "./managedEncryption.helpers";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";

resetAfterEach();

const CUSTOMER_BUCKET = "customer-owned-context";

/** Two path-style buckets behind one `fetch`, routed by the path's first segment. */
function twoBuckets(managed: MemoryS3, customer: MemoryS3) {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const bucket = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    return bucket === CUSTOMER_BUCKET ? customer.fetchImpl(input, init) : managed.fetchImpl(input, init);
  });
}

describe("catch-up after moving out", () => {
  test("copies a late file from the kept, encrypted bucket as plain text", async () => {
    const { t, backend, catchUp } = await encryptedThenMovedOut();
    expect(catchUp).not.toBeNull();
    expect(isSealed(backend.bytesOf("1-projects/plan.md"))).toBe(true);
    const customer = memoryS3(CUSTOMER_BUCKET);
    twoBuckets(backend, customer);

    // Every file in the old bucket counts as late (the stub's listing is old).
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, { ...catchUp!, since: 0 });

    const copied = customer.bytesOf("1-projects/plan.md");
    expect(copied).not.toBeNull();
    expect(isSealed(copied)).toBe(false);
    expect(new TextDecoder().decode(copied!)).toBe("# Plan\n\nThe words people typed.\n");
    for (const [key] of customer.objects) expect(isSealed(customer.bytesOf(key)), key).toBe(false);
  });
});

describe("catch-up after switching back", () => {
  test("seals a late file on its way into a bucket that is encrypted again", async () => {
    const { t, staff, ours, backend } = await encryptedThenMovedOut();
    const customer = memoryS3(CUSTOMER_BUCKET);
    twoBuckets(backend, customer);

    await readyMigration(t, ours, staff, {
      direction: "to_managed",
      bucket: managedBucketName(ours),
      endpoint: MANAGED_ENDPOINT,
    });
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId: ours });
    const catchUp = await cancelLaterJobs(t);
    expect(catchUp).not.toBeNull();
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });

    // Saved into their own bucket after the move back's last check.
    customer.seed("0-inbox/late.md", "# Arrived late\n");
    await t.action(internal.functions.moveCatchUp.runMoveCatchUp, { ...catchUp!, since: 0 });

    expect(isSealed(backend.bytesOf("0-inbox/late.md"))).toBe(true);
    const note = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "0-inbox/late.md",
    });
    expect(note.text).toBe("# Arrived late\n");
  });
});
