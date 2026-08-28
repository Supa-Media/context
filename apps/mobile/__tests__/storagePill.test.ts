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
    expect(storagePillLabel({ provider: "Cloudflare R2", bucket: "brain" })).toBe("R2 · brain");
    expect(storagePillLabel({ provider: "Amazon S3", bucket: "public-worship-brain" })).toBe(
      "S3 · public-worship-brain",
    );
    // A bucket wins over a root prefix — the prefix is an adapter detail
    // there, and the bucket is the name the person knows.
    expect(
      storagePillLabel({ provider: "r2", bucket: "brain", rootPrefix: "notes/" }),
    ).toBe("R2 · brain");
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
