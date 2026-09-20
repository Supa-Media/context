const { describe, expect, test } = require("@jest/globals");
const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { downloadArtifact, parseBuildResult, parseDownloadResult } = require("../../../scripts/eas-build-artifact.cjs");

describe("EAS build artifact coupling", () => {
  test("takes id and URL from the same build result", () => {
    expect(parseBuildResult([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/build.ipa", buildUrl: "https://example.invalid/legacy.ipa" } }])).toEqual({
      id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056",
      url: "https://example.invalid/build.ipa",
    });
  });

  test("rejects incomplete build JSON", () => {
    expect(() => parseBuildResult({ id: "build-1" })).toThrow(/exactly one build/);
    expect(() => parseBuildResult([{ id: "hostile" , artifacts: { applicationArchiveUrl: "https://example.invalid/a" } }])).toThrow(/id and artifact URL/);
    expect(() => parseBuildResult([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { buildUrl: "https://example.invalid/legacy.ipa" } }])).toThrow(/id and artifact URL/);
    expect(() => parseBuildResult([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056" }, { id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056" }])).toThrow(/exactly one build/);
  });

  test("reads the exact local path returned by build download", () => {
    expect(parseDownloadResult({ path: "/tmp/capable.ipa" })).toBe("/tmp/capable.ipa");
    expect(() => parseDownloadResult({ path: "" })).toThrow(/local IPA path/);
  });

  test("downloads the archive URL coupled to the build id without exposing it", async () => {
    const originalFetch = global.fetch;
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]);
    global.fetch = async () => ({ ok: true, status: 200, headers: new Map([["content-length", String(archive.length)]]), body: require("node:stream").Readable.from([archive]) });
    try {
      const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eas-artifact-")), "build.ipa");
      await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/signed" } }], destination)).resolves.toEqual({
        id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056",
        path: destination,
      });
      expect(fs.readFileSync(destination)).toEqual(archive);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test.each([{}, [], [{ id: "x" }], [{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056" }, { id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056" }]])("rejects empty or non-singleton build JSON %#", (value) => {
    expect(() => parseBuildResult(value)).toThrow();
  });

  test.each(["http://example.invalid/a", "https://user:pass@example.invalid/a", "not a url"])('rejects hostile URL "%s"', async (url) => {
    await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: url } }], path.join(os.tmpdir(), `bad-${Date.now()}-${Math.random()}.ipa`))).rejects.toThrow(/HTTPS|invalid/);
  });

  test("sanitizes fetch failures", async () => {
    const old = global.fetch;
    global.fetch = async () => { throw new Error("signed-token-secret"); };
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/a?token=secret" } }], path.join(os.tmpdir(), `bad-${Date.now()}.ipa`))).rejects.toThrow("EAS artifact download failed"); }
    finally { global.fetch = old; }
  });

  test.each([301, 302, 303, 307, 308])("follows HTTPS redirect %s", async (status) => {
    const old = global.fetch; let n = 0;
    global.fetch = async () => n++ === 0 ? { status, headers: new Map([["location", "https://example.invalid/final"]]) } : { ok: true, status: 200, headers: new Map([["content-length", "4"]]), body: require("node:stream").Readable.from([Buffer.from([0x50, 0x4b, 3, 4])]) };
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/start" } }], path.join(os.tmpdir(), `redirect-${Date.now()}-${status}.ipa`))).resolves.toHaveProperty("id"); } finally { global.fetch = old; }
  });

  test("rejects redirect loops and credential redirects", async () => {
    const old = global.fetch; global.fetch = async () => ({ status: 302, headers: new Map([["location", "https://example.invalid/loop"]]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/loop" } }], path.join(os.tmpdir(), `loop-${Date.now()}.ipa`))).rejects.toThrow(/loop/); } finally { global.fetch = old; }
    global.fetch = async () => ({ status: 302, headers: new Map([["location", "https://user:pass@example.invalid/x"]]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/start" } }], path.join(os.tmpdir(), `cred-${Date.now()}.ipa`))).rejects.toThrow(/credentials/); } finally { global.fetch = old; }
  });

  test("rejects HTTPS downgrade and redirect limit", async () => {
    const old = global.fetch; global.fetch = async () => ({ status: 302, headers: new Map([["location", "http://example.invalid/x"]]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/x" } }], path.join(os.tmpdir(), `down-${Date.now()}.ipa`))).rejects.toThrow(/HTTPS/); } finally { global.fetch = old; }
    let calls = 0; global.fetch = async () => ({ status: 302, headers: new Map([["location", `https://example.invalid/${++calls}`]]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/start" } }], path.join(os.tmpdir(), `limit-${Date.now()}.ipa`))).rejects.toThrow(/limit/); } finally { global.fetch = old; }
  });

  test.each([[0, 4], [5, 4], [4, 3]])("rejects declared/actual size mismatch (%s/%s)", async (declared, actual) => {
    const old = global.fetch; global.fetch = async () => ({ ok: true, status: 200, headers: new Map([["content-length", String(declared)]]), body: require("node:stream").Readable.from([Buffer.alloc(actual, 0x50)]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/a" } }], path.join(os.tmpdir(), `size-${Date.now()}-${declared}.ipa`))).rejects.toThrow(); } finally { global.fetch = old; }
  });

  test("rejects maximum declared size", async () => {
    const old = global.fetch; global.fetch = async () => ({ ok: true, status: 200, headers: new Map([["content-length", String(300 * 1024 * 1024)]]), body: require("node:stream").Readable.from([]) });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/a" } }], path.join(os.tmpdir(), `max-${Date.now()}.ipa`))).rejects.toThrow(/Content-Length/); } finally { global.fetch = old; }
  });

  test("sanitizes stream failures and cleans output", async () => {
    const old = global.fetch; const destination = path.join(os.tmpdir(), `stream-${Date.now()}.ipa`);
    global.fetch = async () => ({ ok: true, status: 200, headers: new Map([["content-length", "4"]]), body: { async *[Symbol.asyncIterator]() { yield Buffer.from("PK\x03\x04"); throw new Error("signed-token-secret"); } } });
    try { await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/a" } }], destination)).rejects.toThrow("EAS artifact download failed"); expect(fs.existsSync(destination)).toBe(false); } finally { global.fetch = old; }
  });

  test("rejects an existing destination symlink", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-")); const destination = path.join(dir, "x.ipa"); fs.symlinkSync("target", destination);
    await expect(downloadArtifact([{ id: "e3fd3e28-4b9d-49ed-8fdd-83da2f454056", artifacts: { applicationArchiveUrl: "https://example.invalid/a" } }], destination)).rejects.toThrow(/already exists/);
  });
});
