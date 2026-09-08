const { describe, expect, test } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateInfoPlistXml, validateIpa } = require("../../../scripts/validate-ios-ipa.cjs");

const plist = (version, modes) => `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string><key>UIBackgroundModes</key><array>${modes.map((mode) => `<string>${mode}</string>`).join("")}</array></dict></plist>`;

describe("iOS capable IPA validator", () => {
  test("accepts the 1.0.1 binary with audio background mode", () => {
    expect(validateInfoPlistXml(plist("1.0.1", ["audio"]))).toEqual({ version: "1.0.1", audio: true });
  });

  test("rejects an old version or missing audio mode", () => {
    expect(() => validateInfoPlistXml(plist("1.0.0", ["audio"]))).toThrow(/version=1.0.0/);
    expect(() => validateInfoPlistXml(plist("1.0.1", []))).toThrow(/audio=false/);
  });

  test("accepts future native versions and rejects malformed plist", () => {
    expect(validateInfoPlistXml(plist("2.0.0", ["audio"])).audio).toBe(true);
    expect(() => validateInfoPlistXml("not a plist")).toThrow(/malformed/);
    expect(() => validateInfoPlistXml(plist("2.evil", ["audio"]))).toThrow(/version=2.evil/);
    expect(() => validateInfoPlistXml(plist("2.0.0.1", ["audio"]))).toThrow(/version=2.0.0.1/);
  });

  test("validates the downloaded IPA ZIP container and its sole app plist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipa-fixture-"));
    const app = path.join(root, "Payload", "Context.app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "Info.plist"), plist("1.0.1", ["audio"]));
    const ipa = path.join(root, "downloaded.ipa");
    execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: root });
    expect(validateIpa(ipa)).toEqual({ version: "1.0.1", audio: true });
  });

  test("rejects a tar/gzip download and an IPA with multiple app plists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipa-malformed-"));
    const gzip = path.join(root, "archive.ipa");
    fs.writeFileSync(gzip, Buffer.from("1f8b", "hex"));
    expect(() => validateIpa(gzip)).toThrow(/valid ZIP/);
    for (const name of ["One.app", "Two.app"]) {
      const app = path.join(root, "Payload", name);
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, "Info.plist"), plist("1.0.1", ["audio"]));
    }
    const ipa = path.join(root, "multiple.ipa");
    execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: root });
    expect(() => validateIpa(ipa)).toThrow(/exactly one/);
  });
});
