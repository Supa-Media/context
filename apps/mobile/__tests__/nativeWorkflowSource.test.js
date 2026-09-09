const fs = require("node:fs");
const { describe, expect, test } = require("@jest/globals");

describe("native release workflow artifact safety", () => {
  const source = fs.readFileSync(require("node:path").resolve(__dirname, "../../../.github/workflows/deploy-mobile-native.yml"), "utf8");
  test("submits the validated local IPA path", () => expect(source).toMatch(/eas submit --platform ios --path \/tmp\/context-build\.ipa/));
  test("does not submit iOS latest or ID", () => expect(source).not.toMatch(/eas submit --platform ios --(?:id|latest)/));
  test("uses restrictive umask", () => expect(source).toMatch(/umask 077/));
  test("runs signed IPA validation on macOS", () => {
    expect(source).toMatch(/runs-on: macos-latest/);
    expect(source).not.toMatch(/runs-on: ubuntu-latest/);
  });
  test("cleans temporary build artifacts with a trap", () => expect(source).toMatch(/trap 'rm -f \/tmp\/context-build\.json/));
});
