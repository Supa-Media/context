const { describe, expect, test } = require("@jest/globals");
const { validateInfoPlistXml } = require("../../../scripts/validate-ios-ipa.cjs");

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
});
