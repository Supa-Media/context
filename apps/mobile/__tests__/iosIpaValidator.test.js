const { describe, expect, test } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateInfoPlistXml, validateIpa, validateZipEntries } = require("../../../scripts/validate-ios-ipa.cjs");

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

  test.each(["0.9.9", "1.0.0", "1.0.0.0", "1.evil", "", "1.2.3.4"]) ("rejects downgrade or malformed version %s", (version) => {
    expect(() => validateInfoPlistXml(plist(version, ["audio"]))).toThrow();
  });

  test.each(["2.0.0", "10.1", "999999999999999999999999.2.3", "1.000000000000000000000000.1"]) ("accepts future numeric version %s", (version) => {
    expect(validateInfoPlistXml(plist(version, ["audio"])).audio).toBe(true);
  });

  test.each([null, 1, ["1.0.1"]])("rejects non-string version %#", (version) => {
    const value = `<plist><dict><key>CFBundleShortVersionString</key><${version === null ? "null" : "integer"}>${version ?? ""}</${version === null ? "null" : "integer"}></dict></plist>`;
    expect(() => validateInfoPlistXml(value)).toThrow();
  });

  test.each(["Payload/../evil", "/Payload/Context.app/Info.plist", "Payload\\Context.app\\Info.plist", "Payload/./Context.app/Info.plist", "Payload/Context.app/Info\0.plist"]) ("rejects unsafe ZIP path %s", (entry) => {
    expect(() => validateZipEntries([entry])).toThrow(/unsafe/);
  });

  test.each([["multiple", ["Payload/One.app/Info.plist", "Payload/Two.app/Info.plist"]], ["single", ["Payload/One.app/Info.plist"]], ["empty", []]])("requires one app root %s", (kind, entries) => {
    if (kind === "single") expect(() => validateZipEntries(entries)).not.toThrow();
    else expect(() => validateZipEntries(entries)).toThrow(/exactly one/);
  });

  test("accepts a future binary-plist version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "binary-ipa-")); const app = path.join(root, "Payload", "Context.app"); fs.mkdirSync(app, { recursive: true });
    const xml = path.join(root, "Info.xml"); fs.writeFileSync(xml, plist("3.4.5", ["audio"]));
    execFileSync("plutil", ["-convert", "binary1", "-o", path.join(app, "Info.plist"), xml]);
    const ipa = path.join(root, "binary.ipa"); execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: root });
    expect(validateIpa(ipa).version).toBe("3.4.5");
  });
});
