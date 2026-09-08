const { describe, expect, test } = require("@jest/globals");
const { parseBuildResult, parseDownloadResult } = require("../../../scripts/eas-build-artifact.cjs");

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
});
