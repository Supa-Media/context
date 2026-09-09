const { describe, expect, test } = require("@jest/globals");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { hasExactAppGroup, validateInfoPlistXml, validateIpa, validateZipEntries } = require("../../../scripts/validate-ios-ipa.cjs");

const hostPlist = ({ bundle = "lc.context.mobile", audio = true, live = true } = {}) =>
  `<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0</string>` +
  `<key>CFBundleIdentifier</key><string>${bundle}</string>` +
  `<key>UIBackgroundModes</key><array>${audio ? "<string>audio</string>" : ""}</array>` +
  `<key>NSSupportsLiveActivities</key><${live ? "true" : "false"}/></dict></plist>`;

const extensionPlist = ({ bundle = "lc.context.mobile.widgets", point = "com.apple.widgetkit-extension" } = {}) =>
  `<plist><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>NSExtension</key>` +
  `<dict><key>NSExtensionPointIdentifier</key><string>${point}</string></dict></dict></plist>`;

function ipaFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-live-ipa-"));
  const app = path.join(root, "Payload", "Context.app");
  const extension = path.join(app, "PlugIns", "ContextWidgets.appex");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(app, "Info.plist"), hostPlist(options.host));
  fs.writeFileSync(path.join(extension, "Info.plist"), extensionPlist(options.extension));
  const ipa = path.join(root, "Context.ipa");
  execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: root });
  return ipa;
}

describe("iOS Live Activity IPA validator", () => {
  test("accepts the exact host and embedded widget contract without a version gate", () => {
    expect(validateInfoPlistXml(hostPlist())).toEqual(expect.objectContaining({ version: "1.0.0", audio: true }));
    expect(validateIpa(ipaFixture(), { verifySignatures: false })).toEqual({
      version: "1.0.0", audio: true, extension: "lc.context.mobile.widgets",
    });
  });

  test.each([
    [{ audio: false }, /background|audio/i],
    [{ live: false }, /Live Activity capable/i],
    [{ bundle: "evil.example" }, /bundle=evil\.example/],
  ])("rejects an invalid host contract", (host, message) => {
    expect(() => validateInfoPlistXml(hostPlist(host))).toThrow(message);
  });

  test.each([
    [{ bundle: "evil.widgets" }, /wrong bundle id/],
    [{ point: "evil.extension" }, /extension point/],
  ])("rejects an invalid widget contract", (extension, message) => {
    expect(() => validateIpa(ipaFixture({ extension }), { verifySignatures: false })).toThrow(message);
  });

  test("rejects missing and duplicate embedded widget extensions", () => {
    const missing = ipaFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-missing-widget-"));
    execFileSync("unzip", ["-q", missing, "-d", root]);
    fs.rmSync(path.join(root, "Payload", "Context.app", "PlugIns"), { recursive: true });
    const noWidget = path.join(root, "missing.ipa");
    execFileSync("zip", ["-q", "-r", noWidget, "Payload"], { cwd: root });
    expect(() => validateIpa(noWidget, { verifySignatures: false })).toThrow(/exactly one embedded/);
  });

  test("requires the exact shared App Group and no broader entitlement set", () => {
    expect(hasExactAppGroup(["group.lc.context.mobile"])).toBe(true);
    expect(hasExactAppGroup([])).toBe(false);
    expect(hasExactAppGroup(["group.lc.context.mobile", "group.other"])).toBe(false);
    expect(hasExactAppGroup(["group.other"])).toBe(false);
  });

  test.each(["Payload/../evil", "/Payload/Context.app/Info.plist", "Payload\\Context.app\\Info.plist", "Payload/./Context.app/Info.plist"])(
    "rejects unsafe ZIP path %s", (entry) => expect(() => validateZipEntries([entry])).toThrow(/unsafe/),
  );
});
