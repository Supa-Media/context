const { describe, expect, test } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { downloadArtifact, parseBuildResult, parseDownloadResult } = require("../../../scripts/eas-build-artifact.cjs");

describe("EAS build artifact coupling", () => {
  test("takes id and URL from the same build result", () => {
    expect(parseBuildResult([{ id: "build-1", artifacts: { applicationArchiveUrl: "https://example.invalid/build.ipa", buildUrl: "https://example.invalid/legacy.ipa" } }])).toEqual({
      id: "build-1",
      url: "https://example.invalid/build.ipa",
    });
  });

  test("rejects incomplete build JSON", () => {
    expect(() => parseBuildResult({ id: "build-1" })).toThrow(/id and artifact URL/);
    expect(() => parseBuildResult({ id: "build-1", artifacts: { buildUrl: "https://example.invalid/legacy.ipa" } })).toThrow(/id and artifact URL/);
  });

  test("reads the exact local path returned by build download", () => {
    expect(parseDownloadResult({ path: "/tmp/capable.ipa" })).toBe("/tmp/capable.ipa");
    expect(() => parseDownloadResult({ path: "" })).toThrow(/local IPA path/);
  });

  test("downloads the archive URL coupled to the build id without exposing it", async () => {
    const originalFetch = global.fetch;
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]);
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => archive });
    try {
      const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eas-artifact-")), "build.ipa");
      await expect(downloadArtifact({ id: "build-1", artifacts: { applicationArchiveUrl: "https://example.invalid/signed" } }, destination)).resolves.toEqual({
        id: "build-1",
        path: destination,
      });
      expect(fs.readFileSync(destination)).toEqual(archive);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
