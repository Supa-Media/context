const { describe, expect, test } = require("@jest/globals");
const plugin = require("../plugins/with-context-widgets");

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
});
