/**
 * A whole-bucket move copies a file past the whole-object cap in parts,
 * instead of failing the move for good (project file `move-engine/plan.md`,
 * step D; `lib/managedMigration.ts` `reconcileListedPage`,
 * `mcp/src/store/s3Stream.js`).
 *
 * The real `S3Store` on both sides, each over its own S3 wire stub.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop `if-match` from a ranged read and the edited-source case lands a
 *    file stitched from two versions;
 *  - skip the stamp check in `reconcileLargeObject` and the re-run case
 *    uploads again;
 *  - skip `abortOpenUploads` and the dead-worker case leaves an upload open;
 *  - drop the envelope check and the sealed case lands sealed bytes.
 */

import { describe, expect, test } from "vitest";
import {
  ObjectsTooLarge,
  PageContinues,
  STREAM_MAX_BYTES,
  reconcileListedPage,
  type MigrationStore,
} from "../../functions/lib/managedMigration";
import { memoryStore } from "../storeStub.helpers";
import { pattern, s3CopyStub } from "./s3CopyStub.helpers";

const MB = 1024 * 1024;
const CAP = 1 * MB;
const BIG = 20 * MB;

function buckets(hooks: Parameters<typeof s3CopyStub>[0] = {}) {
  const from = s3CopyStub(hooks, "old");
  const to = s3CopyStub({}, "new");
  return { from, to, source: from.s3() as unknown as MigrationStore, target: to.s3() as unknown as MigrationStore };
}

const page = (b: ReturnType<typeof buckets>, keys: string[], extra: Partial<Parameters<typeof reconcileListedPage>[0]> = {}) =>
  reconcileListedPage({
    source: b.source,
    target: b.target,
    objects: keys.map((key) => ({ key, size: b.from.base.objects.get(key)?.bytes.length ?? 0 })),
    listedFromTarget: false,
    byteCap: CAP,
    maxWidth: 16,
    byteBudget: 32 * MB,
    ...extra,
  });

const same = (left: Uint8Array | null | undefined, right: Uint8Array) => left != null && Buffer.from(left).equals(Buffer.from(right));
const wholeReads = (stub: ReturnType<typeof s3CopyStub>, key: string) =>
  stub.log.filter((entry) => entry.method === "GET" && entry.key === key && !entry.query.includes("uploads")).length;

describe("a file past the whole-object cap", () => {
  test("is copied in parts, stamped with its version, and the small files beside it as before", async () => {
    const b = buckets();
    b.from.seed("3-resources/talk.mp4", pattern(BIG), "video/mp4");
    b.from.seed("1-projects/plan.md", "# Plan\n");
    const etag = b.from.base.objects.get("3-resources/talk.mp4")!.etag;
    const result = await page(b, ["1-projects/plan.md", "3-resources/talk.mp4"]);

    expect(result).toEqual({ copied: 2, changes: 2 });
    expect(same(b.to.base.bytesOf("3-resources/talk.mp4"), pattern(BIG))).toBe(true);
    expect(b.to.meta.get("3-resources/talk.mp4")).toEqual({ "x-amz-meta-context-copy-of": etag });
    expect(b.to.base.snapshot()["1-projects/plan.md"]).toBe("# Plan\n");
    expect(b.to.uploads.size).toBe(0);
    // Read in ranges only: never the whole video at once.
    const reads = b.from.log.filter((entry) => entry.method === "GET" && entry.key === "3-resources/talk.mp4");
    expect(reads.length).toBe(3);
  });

  test("a re-run recognises its own copy and uploads nothing", async () => {
    const b = buckets();
    b.from.seed("3-resources/talk.mp4", pattern(BIG));
    await page(b, ["3-resources/talk.mp4"]);
    const before = b.to.log.length;
    expect(await page(b, ["3-resources/talk.mp4"])).toEqual({ copied: 1, changes: 0 });
    expect(b.to.log.slice(before).every((entry) => entry.method === "HEAD")).toBe(true);
    expect(wholeReads(b.from, "3-resources/talk.mp4")).toBe(3);
  });

  test("a file edited mid-copy is never stitched: nothing lands, the upload is aborted, the next run copies the new one", async () => {
    let reads = 0;
    const b = buckets({
      beforeRange: () => {
        reads += 1;
        if (reads === 2) b.from.seed("3-resources/talk.mp4", pattern(BIG + 5));
      },
    });
    b.from.seed("3-resources/talk.mp4", pattern(BIG));
    await expect(page(b, ["3-resources/talk.mp4"])).rejects.toThrow("SOURCE_CHANGED");
    expect(b.to.base.objects.has("3-resources/talk.mp4")).toBe(false);
    expect(b.to.uploads.size).toBe(0);
    await page(b, ["3-resources/talk.mp4"]);
    expect(same(b.to.base.bytesOf("3-resources/talk.mp4"), pattern(BIG + 5))).toBe(true);
  });

  test("an upload a dead worker left open is aborted before the next starts", async () => {
    const b = buckets();
    b.from.seed("3-resources/talk.mp4", pattern(BIG));
    b.to.uploads.set("left-over", { key: "3-resources/talk.mp4", meta: {}, parts: new Map() });
    await page(b, ["3-resources/talk.mp4"]);
    expect(b.to.uploads.size).toBe(0);
    expect(same(b.to.base.bytesOf("3-resources/talk.mp4"), pattern(BIG))).toBe(true);
  });

  test("a sealed managed file is one encrypted piece: named as too large, nothing lands", async () => {
    const b = buckets();
    const sealed = pattern(BIG);
    sealed.set([0x43, 0x54, 0x58, 0x45, 0x4e, 0x43, 0x01], 0);
    b.from.seed("3-resources/talk.mp4", sealed);
    const error = await page(b, ["3-resources/talk.mp4"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ObjectsTooLarge);
    expect((error as ObjectsTooLarge).keys).toEqual(["3-resources/talk.mp4"]);
    expect(b.to.base.objects.has("3-resources/talk.mp4")).toBe(false);
    expect(b.to.uploads.size).toBe(0);
  });

  test("past what one action can stream, the page fails named before anything on it is written", async () => {
    const b = buckets();
    b.from.seed("1-projects/plan.md", "# Plan\n");
    const error = await reconcileListedPage({
      source: b.source,
      target: b.target,
      objects: [{ key: "1-projects/plan.md", size: 7 }, { key: "huge.mov", size: STREAM_MAX_BYTES + 1 }],
      listedFromTarget: false,
      byteCap: CAP,
      maxWidth: 16,
      byteBudget: 32 * MB,
    }).catch((caught: unknown) => caught);
    expect((error as ObjectsTooLarge).keys).toEqual(["huge.mov"]);
    expect(b.to.base.objects.size).toBe(0);
  });

  test("a store that cannot stream fails as it always did", async () => {
    const source = memoryStore();
    await source.put("talk.mp4", new Uint8Array(2 * CAP));
    const target = memoryStore();
    const error = await reconcileListedPage({
      source: source as unknown as MigrationStore,
      target: target as unknown as MigrationStore,
      objects: [{ key: "talk.mp4", size: 2 * CAP }],
      listedFromTarget: false,
      byteCap: CAP,
      maxWidth: 16,
      byteBudget: 32 * MB,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ObjectsTooLarge);
  });

  test("merging, a different large file of theirs at the name is kept beside it first", async () => {
    const b = buckets();
    b.from.seed("talk.mp4", pattern(BIG));
    b.to.seed("talk.mp4", pattern(2 * MB + 3));
    await page(b, ["talk.mp4"], { keepTargetConflicts: true });
    expect(same(b.to.base.bytesOf("talk (from your bucket).mp4"), pattern(2 * MB + 3))).toBe(true);
    expect(same(b.to.base.bytesOf("talk.mp4"), pattern(BIG))).toBe(true);
  });

  test("out of time between two large files, the page runs again and skips what it finished", async () => {
    const b = buckets();
    b.from.seed("a.mp4", pattern(BIG));
    b.from.seed("b.mp4", pattern(BIG + 1));
    // Every look at the clock finds seven more minutes gone: no second file starts.
    let clock = 0;
    const first = page(b, ["a.mp4", "b.mp4"], { startedAt: 0, now: () => (clock += 7 * 60 * 1000) });
    await expect(first).rejects.toBeInstanceOf(PageContinues);
    expect(same(b.to.base.bytesOf("a.mp4"), pattern(BIG))).toBe(true);
    expect(b.to.base.objects.has("b.mp4")).toBe(false);
    expect(await page(b, ["a.mp4", "b.mp4"])).toEqual({ copied: 2, changes: 1 });
    expect(same(b.to.base.bytesOf("b.mp4"), pattern(BIG + 1))).toBe(true);
  });
});
