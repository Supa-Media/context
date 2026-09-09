const { describe, expect, test } = require("@jest/globals");
const plugin = require("../plugins/with-context-widgets");
const fs = require("node:fs");
const path = require("node:path");

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

  test("the generated prebuild has an embedded dependent extension with concrete versions", () => {
    const project = path.join(__dirname, "..", "ios", "Context.xcodeproj", "project.pbxproj");
    if (!fs.existsSync(project)) return;
    const body = fs.readFileSync(project, "utf8");
    expect(body).toMatch(/ContextWidgets\.appex in Copy Files/);
    expect(body).toMatch(/PBXTargetDependency section/);
    expect(body).toMatch(/target = .*ContextWidgets/);
    expect(body).toMatch(/CODE_SIGN_ENTITLEMENTS = "ContextWidgets\/ContextWidgets\.entitlements"/);
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
