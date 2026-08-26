const path = require("path");
const { createSupaTests, detectRoutingConflicts } = require("@supa-media/testing");

/**
 * Static guardrails for the Expo/RN gotchas the framework has hit before. These
 * run in CI on every PR — they're fast (no app boot) and catch whole classes of
 * bugs that otherwise only surface at runtime on web/device.
 */
const appDir = path.join(__dirname, "..", "app");
const tests = createSupaTests({
  appDir,
  srcDir: path.join(__dirname, ".."),
  nativeDepsPath: "native-deps.json",
});

describe("Supa framework guardrails", () => {
  // The one that bites hardest: two files resolving to the same URL — including a
  // <Redirect> file silently shadowing a real screen (e.g. app/index.tsx vs
  // app/(app)/(tabs)/index.tsx). Asserts URL conflicts only (missingLayouts is a
  // softer heuristic that false-positives on valid nested stacks).
  test("no Expo Router URL conflicts (incl. <Redirect> shadowing a screen)", () => {
    const { conflicts } = detectRoutingConflicts(appDir);
    if (conflicts.length > 0) {
      throw new Error(
        "Routing conflicts found:\n" +
          conflicts
            .map((c) => `  ${c.url}: ${c.files.join(", ")}\n    ${c.description}`)
            .join("\n"),
      );
    }
  });
  test("web bundle safety", tests.webBundleSafety);
  test("single React instance resolves", tests.reactResolution);
  test("native deps classified + no ungated native imports", tests.nativeImports);
});
