const fs = require("node:fs");
const { describe, expect, test } = require("@jest/globals");

describe("native release workflow artifact safety", () => {
  const source = fs.readFileSync(require("node:path").resolve(__dirname, "../../../.github/workflows/deploy-mobile-native.yml"), "utf8");
  test("submits the validated local IPA path", () => expect(source).toMatch(/eas submit --platform ios --path \/tmp\/context-build\.ipa/));
  test("does not submit iOS latest or ID", () => expect(source).not.toMatch(/eas submit --platform ios --(?:id|latest)/));
  test("uses restrictive umask", () => expect(source).toMatch(/umask 077/));
  test("cleans temporary build artifacts with a trap", () => expect(source).toMatch(/trap 'rm -f \/tmp\/context-build\.json/));
  test("uses the same IPA path for download, validation, and submit", () => {
    expect(source).toMatch(/download .*\$IPA_PATH/);
    expect(source).toMatch(/validate-ios-ipa\.cjs \"\$IPA_PATH\"/);
    expect(source).toMatch(/eas submit --platform ios --path \/tmp\/context-build\.ipa/);
  });
  test("build step sets restrictive umask before download", () => {
    const build = source.match(/- name: Build iOS[\s\S]*?- name: Build Android/)[0];
    expect(build).toMatch(/umask 077/);
    expect(build).toMatch(/download/);
  });
});
