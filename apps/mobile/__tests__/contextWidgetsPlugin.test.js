const { describe, expect, test } = require("@jest/globals");
const plugin = require("../plugins/with-context-widgets");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("Context widgets config plugin", () => {
  test("derives identifiers from the app bundle id", () => {
    expect(plugin.identifiers({ ios: { bundleIdentifier: "lc.context.mobile" } })).toEqual({
      appGroup: "group.lc.context.mobile",
      extensionBundleIdentifier: "lc.context.mobile.widgets",
    });
  });

  test("extension declaration is deterministic and preserves unrelated config", () => {
    const config = {
      ios: { bundleIdentifier: "lc.context.mobile" },
      extra: { eas: { projectId: "project", build: { experimental: { ios: {
        appExtensions: [{ targetName: "Other", bundleIdentifier: "other.widgets" }],
      } } } } },
    };
    const ids = plugin.identifiers(config);
    plugin.declareEasExtension(config, ids);
    plugin.declareEasExtension(config, ids);
    expect(config.extra.eas.projectId).toBe("project");
    expect(config.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: "Other", bundleIdentifier: "other.widgets" },
      {
        targetName: "ContextWidgets",
        bundleIdentifier: "lc.context.mobile.widgets",
        entitlements: { "com.apple.security.application-groups": ["group.lc.context.mobile"] },
      },
    ]);
  });

  test("requires an iOS bundle id", () => {
    expect(() => plugin.identifiers({ ios: {} })).toThrow(/bundleIdentifier/);
  });

  test("widget extension plist declares its required bundle name", () => {
    const plist = fs.readFileSync(
      path.join(__dirname, "..", "targets", "context-widgets", "ContextWidgets-Info.plist"),
      "utf8",
    );
    expect(plist).toMatch(
      /<key>CFBundleName<\/key>\s*<string>\$\(PRODUCT_NAME\)<\/string>/,
    );
  });

  test("the native bridge remains eligible for the iOS 15.1 host and Expo autolinks it", () => {
    const podspec = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "modules",
        "context-activity-kit",
        "ios",
        "ContextActivityKit.podspec",
      ),
      "utf8",
    );
    expect(podspec).toContain('s.platforms      = { :ios => "15.1" }');

    const moduleSource = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "modules",
        "context-activity-kit",
        "ios",
        "ContextActivityKitModule.swift",
      ),
      "utf8",
    );
    expect(moduleSource).toContain("import ActivityKit");
    expect(moduleSource.match(/guard #available\(iOS 16\.1, \*\)/g)).toHaveLength(4);
    expect(moduleSource).toContain("@available(iOS 16.1, *)");

    const pluginSource = fs.readFileSync(
      path.join(__dirname, "..", "plugins", "with-context-widgets.js"),
      "utf8",
    );
    expect(pluginSource).toContain('settings.IPHONEOS_DEPLOYMENT_TARGET = "16.1"');

    const result = spawnSync(
      process.execPath,
      [
        require.resolve("expo-modules-autolinking/bin/expo-modules-autolinking"),
        "resolve",
        "--platform",
        "ios",
        "--json",
      ],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const resolved = JSON.parse(result.stdout);
    expect(resolved.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: "context-activity-kit",
          pods: expect.arrayContaining([
            expect.objectContaining({ podName: "ContextActivityKit" }),
          ]),
          modules: expect.arrayContaining(["ContextActivityKitModule"]),
        }),
      ]),
    );

    // When this test runs after prebuild + pod install, verify CocoaPods' three
    // concrete outputs too; the resolver assertion above remains deterministic
    // on a clean checkout where generated native directories are absent.
    const ios = path.join(__dirname, "..", "ios");
    const installed = [
      ["Podfile.lock"],
      ["Pods", "Pods.xcodeproj", "project.pbxproj"],
      ["Pods", "Target Support Files", "Pods-Context", "ExpoModulesProvider.swift"],
    ].map((parts) => path.join(ios, ...parts));
    if (installed.every(fs.existsSync)) {
      for (const output of installed) {
        expect(fs.readFileSync(output, "utf8")).toContain("ContextActivityKit");
      }
    }
  });

  test("the generated prebuild has an embedded dependent extension with concrete versions", () => {
    const project = path.join(__dirname, "..", "ios", "Context.xcodeproj", "project.pbxproj");
    if (!fs.existsSync(project)) return;
    const body = fs.readFileSync(project, "utf8");
    expect(body).toMatch(/ContextWidgets\.appex in Copy Files/);
    expect(body).toMatch(/PBXTargetDependency section/);
    expect(body).toMatch(/target = .*ContextWidgets/);
    expect(body).toMatch(
      /CODE_SIGN_ENTITLEMENTS = "?ContextWidgets\/ContextWidgets\.entitlements"?;/,
    );
    expect(body).not.toContain("CURRENT_PROJECT_VERSION = $(CURRENT_PROJECT_VERSION)");
    expect(body).not.toContain("MARKETING_VERSION = $(MARKETING_VERSION)");
  });

  test("widget links enter allowlisted app routes instead of cross-process commands", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "targets", "context-widgets", "ContextQuickCaptureWidget.swift"),
      "utf8",
    );
    expect(source).toContain("context://console?quickAction=note");
    expect(source).toContain("context://meetings?quickAction=meeting");
    expect(source).not.toMatch(/AppIntent|AudioRecorder|stopRecording|pauseRecording/);
  });
});
