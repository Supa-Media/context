import { describe, expect, test } from "@jest/globals";
import { providerLabel, storagePillLabel } from "../features/console/storage/pill";

/**
 * The storage pill's words.
 *
 * The reported bug, verbatim from the first live Dropbox connect: the top bar
 * read **"dropbox · undefined"**, because the chip interpolated
 * `provider · bucket` inline and a Dropbox binding has no bucket by design.
 * The label is a pure function now, and the case that shipped is pinned first.
 */

describe("storagePillLabel", () => {
  test("a Dropbox binding with no folder is just 'Dropbox'", () => {
    expect(storagePillLabel({ provider: "dropbox" })).toBe("Dropbox");
  });

  test("a Dropbox binding scoped to a folder names the folder", () => {
    expect(storagePillLabel({ provider: "dropbox", rootPrefix: "second/" })).toBe(
      "Dropbox · second/",
    );
  });

  test("the string 'undefined' is unmanufacturable", () => {
    // Every shape a binding can arrive in, including the dishonest ones a
    // newer control plane could send. None may leak a hole into the label.
    const shapes = [
      { provider: "dropbox" },
      { provider: "dropbox", bucket: undefined, rootPrefix: undefined },
      { provider: "dropbox", bucket: "", rootPrefix: "" },
      { provider: "s3" },
      { provider: "some-future-provider" },
    ];
    for (const shape of shapes) {
      expect(storagePillLabel(shape)).not.toContain("undefined");
    }
  });

  test("an S3-family binding keeps its provider · bucket shape", () => {
    expect(storagePillLabel({ provider: "Cloudflare R2", bucket: "notes-bucket" })).toBe("R2 · notes-bucket");
    expect(storagePillLabel({ provider: "Amazon S3", bucket: "public-worship-notes" })).toBe(
      "S3 · public-worship-notes",
    );
    // A bucket wins over a root prefix — the prefix is an adapter detail
    // there, and the bucket is the name the person knows.
    expect(
      storagePillLabel({ provider: "r2", bucket: "notes-bucket", rootPrefix: "notes/" }),
    ).toBe("R2 · notes-bucket");
  });

  test("no binding is no label — the warn copy belongs to the caller", () => {
    expect(storagePillLabel(null)).toBeNull();
  });
});

describe("providerLabel", () => {
  test("the known providers read as prose", () => {
    expect(providerLabel("dropbox")).toBe("Dropbox");
    expect(providerLabel("r2")).toBe("R2");
    expect(providerLabel("s3-compatible")).toBe("S3");
    expect(providerLabel("b2")).toBe("B2");
    expect(providerLabel("backblaze")).toBe("B2");
  });

  test("an unknown provider is printed raw rather than guessed at", () => {
    expect(providerLabel("wasabi-next")).toBe("wasabi-next");
  });
});

/**
 * A managed bucket's name is not a name anybody chose.
 *
 * `managedBucketName()` derives it from the workspace id — immutable, unique,
 * uncollidable, and unreadable: `ctx-j57a2m9qk4x1r8v6s3d0w7b5n2t8f4h6` — a
 * made-up id of the right shape, because this repository is public and a real
 * one names a real workspace. That
 * is the right bucket name and the wrong label, and it was being printed in
 * four places (the top bar's chip, the status bar, the tree's foot, and the
 * Connected card) because the pill had no reason to know the difference.
 *
 * It does now, and the location half says what is actually true of a managed
 * binding: the person did not pick this bucket, so there is nothing to
 * identify it *against*. The exact name is still one tap away in
 * Settings → Storage → Bucket, where somebody diagnosing a real problem is
 * already looking and where a 36-character id is the answer rather than noise.
 */
describe("storagePillLabel, managed storage", () => {
  const MANAGED = {
    provider: "Cloudflare R2",
    bucket: "ctx-j57a2m9qk4x1r8v6s3d0w7b5n2t8f4h6",
    managed: true,
  };

  test("the workspace id never reaches the label", () => {
    expect(storagePillLabel(MANAGED)).toBe("R2 · managed");
    expect(storagePillLabel(MANAGED)).not.toContain("ctx-");
  });

  test("the provider half survives — it is still R2, and that is still true", () => {
    expect(storagePillLabel({ ...MANAGED, provider: "r2" })).toBe("R2 · managed");
  });

  test("a root prefix cannot put the id back", () => {
    // Managed buckets are created empty at the root, so this shape should not
    // occur. If a future one does, the label must still not fall through to
    // the bucket name.
    expect(
      storagePillLabel({ ...MANAGED, rootPrefix: "notes/" }),
    ).toBe("R2 · managed");
  });

  test("only `managed: true` means managed — a BYO bucket keeps its own name", () => {
    // `managed` is optional on `ConsoleStorage`: a bundle talking to an older
    // control plane gets `undefined`, and the honest reading of that is "this
    // is an ordinary binding", which prints the name the person typed.
    expect(storagePillLabel({ provider: "r2", bucket: "notes-bucket" })).toBe("R2 · notes-bucket");
    expect(storagePillLabel({ provider: "r2", bucket: "notes-bucket", managed: false })).toBe(
      "R2 · notes-bucket",
    );
  });
});
