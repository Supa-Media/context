/**
 * Moving a file that is not a note costs the bucket's own copy, never a
 * download and upload through Convex (project file `move-engine/plan.md`,
 * step B), and a file past one copy's 5 GiB limit copies in parts.
 *
 * The real `S3Store` (signing, URLs, XML) and the real logical-delete view
 * over an S3 wire stub that speaks HEAD metadata and `UploadPartCopy`.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop `moveByServerCopy` and the no-download cases read the file;
 *  - drop the logical view's HEAD in `put` and the claim downloads it;
 *  - drop `x-amz-copy-source-if-match` from a part and the changed-source
 *    case stitches two versions together;
 *  - skip the abort and the failed copies leave an upload open;
 *  - drop the `copyOf` stamp check and a re-run after a dead pass is a clash.
 */

import { describe, expect, test } from "vitest";
import { MoveObjectConflict, moveObject } from "../../../mcp/src/moves/queued.js";
import { withLogicalDelete } from "../../../mcp/src/store/logicalDelete.js";
import { copyPartRanges } from "../../../mcp/src/store/s3Multipart.js";
import { pattern, s3CopyStub } from "./s3CopyStub.helpers";

type AnyStore = Parameters<typeof moveObject>[0];

const view = (store: unknown) => withLogicalDelete(store as never) as unknown as AnyStore;
const reads = (stub: ReturnType<typeof s3CopyStub>, key: string) =>
  stub.log.filter((entry) => entry.method === "GET" && entry.key === key).length;
const live = (stub: ReturnType<typeof s3CopyStub>, key: string) => {
  const value = stub.base.objects.get(key);
  return value !== undefined && value.bytes.length !== 0 && !value.body.startsWith("context.logical-delete");
};

describe("a file that is not a note", () => {
  test("moves by the bucket's own copy: never downloaded, type kept, source retired", async () => {
    const stub = s3CopyStub();
    stub.seed("a/video.mp4", pattern(4_000), "video/mp4");
    const store = view(stub.s3());
    const answer = await moveObject(store, "a/video.mp4", "b/video.mp4");

    expect(answer).toMatchObject({ state: "moved", size: 4_000 });
    expect(stub.base.bytesOf("b/video.mp4")).toEqual(pattern(4_000));
    expect(stub.base.objects.get("b/video.mp4")?.contentType).toBe("video/mp4");
    expect(live(stub, "a/video.mp4")).toBe(false);
    expect(reads(stub, "a/video.mp4")).toBe(0);
    expect(reads(stub, "b/video.mp4")).toBe(0);
  });

  test("past one copy's limit copies in parts, in order, and is stamped with the version it came from", async () => {
    const stub = s3CopyStub();
    stub.seed("a/big.bin", pattern(2_500), "application/octet-stream");
    const sourceEtag = stub.base.objects.get("a/big.bin")!.etag;
    const store = view(stub.s3({ singleCopyMaxBytes: 1_000, copyPartBytes: 300 }));
    const answer = await moveObject(store, "a/big.bin", "b/big.bin");

    expect(answer.state).toBe("moved");
    expect(stub.base.bytesOf("b/big.bin")).toEqual(pattern(2_500));
    expect(stub.meta.get("b/big.bin")).toEqual({ "x-amz-meta-context-copy-of": sourceEtag });
    expect(stub.log.filter((entry) => entry.method === "PUT" && entry.query.includes("partNumber")).length).toBe(9);
    expect(reads(stub, "a/big.bin")).toBe(0);
    expect(stub.uploads.size).toBe(0);
  });

  test("part ranges cover every byte once, and never exceed 10,000 parts", () => {
    expect(copyPartRanges(2_500, 300)).toHaveLength(9);
    expect(copyPartRanges(2_500, 300).at(-1)).toEqual([2_400, 2_499]);
    expect(copyPartRanges(900, 300)).toEqual([[0, 299], [300, 599], [600, 899]]);
    const huge = copyPartRanges(5 * 1024 ** 4, 512 * 1024 ** 2);
    expect(huge.length).toBeLessThanOrEqual(10_000);
    expect(huge.at(-1)![1]).toBe(5 * 1024 ** 4 - 1);
  });

  test("a part that fails twice is retried, and the copy completes", async () => {
    const failures = new Map([[2, 2]]);
    const stub = s3CopyStub({
      beforePart: (part) => {
        const left = failures.get(part) ?? 0;
        if (left > 0) {
          failures.set(part, left - 1);
          return 500;
        }
      },
    });
    stub.seed("a/big.bin", pattern(2_500));
    const answer = await moveObject(view(stub.s3({ singleCopyMaxBytes: 1_000, copyPartBytes: 300 })), "a/big.bin", "b/big.bin");
    expect(answer.state).toBe("moved");
    expect(stub.base.bytesOf("b/big.bin")).toEqual(pattern(2_500));
  });

  test("a source edited mid-copy is never stitched: nothing lands, the upload is aborted, the move retries", async () => {
    let edited = false;
    const stub = s3CopyStub({
      beforePart: (part) => {
        if (part === 3 && !edited) {
          edited = true;
          stub.seed("a/big.bin", pattern(2_600));
        }
      },
    });
    stub.seed("a/big.bin", pattern(2_500));
    const store = view(stub.s3({ singleCopyMaxBytes: 1_000, copyPartBytes: 300 }));
    await expect(moveObject(store, "a/big.bin", "b/big.bin")).rejects.toBeInstanceOf(MoveObjectConflict);
    expect(stub.base.objects.has("b/big.bin")).toBe(false);
    expect(stub.uploads.size).toBe(0);
    expect(stub.base.bytesOf("a/big.bin")).toEqual(pattern(2_600));

    // The next try copies the version that is there now.
    const answer = await moveObject(store, "a/big.bin", "b/big.bin");
    expect(answer.state).toBe("moved");
    expect(stub.base.bytesOf("b/big.bin")).toEqual(pattern(2_600));
  });

  test("a stranger's file appearing at the destination mid-copy is kept, and nothing is overwritten", async () => {
    const stub = s3CopyStub({ beforeComplete: () => stub.seed("b/big.bin", "theirs") });
    stub.seed("a/big.bin", pattern(2_500));
    const store = view(stub.s3({ singleCopyMaxBytes: 1_000, copyPartBytes: 300 }));
    await expect(moveObject(store, "a/big.bin", "b/big.bin")).rejects.toBeInstanceOf(MoveObjectConflict);
    expect(stub.base.snapshot()["b/big.bin"]).toBe("theirs");
    expect(stub.uploads.size).toBe(0);
    expect(stub.base.bytesOf("a/big.bin")).toEqual(pattern(2_500));
  });

  test("a re-run after a pass died between copy and retire recognises its own parted copy", async () => {
    const stub = s3CopyStub();
    stub.seed("a/big.bin", pattern(2_500));
    const raw = stub.s3({ singleCopyMaxBytes: 1_000, copyPartBytes: 300 });
    const etag = stub.base.objects.get("a/big.bin")!.etag;
    // The copy landed; the pass died before retiring the source.
    await raw.copy("a/big.bin", "b/big.bin", { onlyIf: { absent: true }, sourceOnlyIf: { etagMatches: etag }, size: 2_500 });
    const answer = await moveObject(view(raw), "a/big.bin", "b/big.bin");
    expect(answer.state).toBe("moved");
    expect(live(stub, "a/big.bin")).toBe(false);
    expect(stub.base.bytesOf("b/big.bin")).toEqual(pattern(2_500));
  });

  test("a different large file already at the destination is a clash, never an overwrite", async () => {
    const stub = s3CopyStub();
    const size = 9 * 1024 * 1024;
    stub.seed("a/big.bin", pattern(size));
    stub.seed("b/big.bin", new Uint8Array(size));
    const error = await moveObject(view(stub.s3()), "a/big.bin", "b/big.bin").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MoveObjectConflict);
    expect((error as { clash?: boolean }).clash).toBe(true);
    expect(Buffer.from(stub.base.bytesOf("a/big.bin")!).equals(Buffer.from(pattern(size)))).toBe(true);
  });

  test("a deleted file's marker is not copied: the move reads it as already gone", async () => {
    const stub = s3CopyStub();
    const store = view(stub.s3());
    stub.seed("a/pic.png", pattern(100), "image/png");
    await (store as unknown as { delete(key: string): Promise<unknown> }).delete("a/pic.png");
    const answer = await moveObject(store, "a/pic.png", "b/pic.png");
    expect(answer.state).toBe("missing");
    expect(stub.base.objects.has("b/pic.png")).toBe(false);
  });

  test("a note still moves by read and write, so its history and stamp go with it", async () => {
    const stub = s3CopyStub();
    stub.seed("a/plan.md", "# Plan\n", "text/markdown; charset=utf-8");
    const answer = await moveObject(view(stub.s3()), "a/plan.md", "b/plan.md");
    expect(answer.state).toBe("moved");
    expect(reads(stub, "a/plan.md")).toBeGreaterThan(0);
    expect(stub.log.some((entry) => entry.method === "PUT" && entry.key === "b/plan.md")).toBe(true);
  });
});
