const { describe, expect, test } = require("@jest/globals");
const plugin = require("../plugins/with-context-messages");
const fs = require("node:fs");
const path = require("node:path");

const target = (...parts) => path.join(__dirname, "..", "targets", "context-messages", ...parts);

describe("Context Messages extension config plugin", () => {
  test("its bundle id is the one the texting Worker names on each card", () => {
    expect(plugin.identifiers({ ios: { bundleIdentifier: "lc.context.mobile" } })).toEqual({
      extensionBundleIdentifier: "lc.context.mobile.messages",
    });
    const wrangler = fs.readFileSync(path.join(__dirname, "..", "..", "agent", "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"APP_CARD_EXTENSION_ID": "lc.context.mobile.messages"');
    expect(wrangler).toContain('"APP_CARD_EXTENSION_ID": "lc.context.staging.messages"');
  });

  test("extension declaration is deterministic and keeps the widgets", () => {
    const config = {
      ios: { bundleIdentifier: "lc.context.mobile" },
      extra: { eas: { build: { experimental: { ios: { appExtensions: [{ targetName: "ContextWidgets", bundleIdentifier: "lc.context.mobile.widgets" }] } } } } },
    };
    const ids = plugin.identifiers(config);
    plugin.declareEasExtension(config, ids);
    plugin.declareEasExtension(config, ids);
    expect(config.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: "ContextWidgets", bundleIdentifier: "lc.context.mobile.widgets" },
      { targetName: "ContextMessages", bundleIdentifier: "lc.context.mobile.messages" },
    ]);
  });

  test("the plist declares an iMessage extension with its view controller", () => {
    const plist = fs.readFileSync(target("ContextMessages-Info.plist"), "utf8");
    expect(plist).toMatch(/<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.message-payload-provider<\/string>/);
    expect(plist).toMatch(/<key>NSExtensionPrincipalClass<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.MessagesViewController<\/string>/);
    expect(plist).toMatch(/<key>CFBundleName<\/key>\s*<string>\$\(PRODUCT_NAME\)<\/string>/);
  });

  test("the iMessage icon set has every file it lists, the App Store size included", () => {
    const set = target("Assets.xcassets", "iMessage App Icon.stickersiconset");
    const { images } = JSON.parse(fs.readFileSync(path.join(set, "Contents.json"), "utf8"));
    expect(images.some((image) => image.idiom === "ios-marketing" && image.size === "1024x768")).toBe(true);
    for (const image of images) expect(fs.existsSync(path.join(set, image.filename))).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, "..", "plugins", "with-context-messages.js"), "utf8");
    expect(source).toContain('const ICON_SET = "iMessage App Icon"');
  });

  test("a card opens only a context.lc link", () => {
    const source = fs.readFileSync(target("MessagesViewController.swift"), "utf8");
    expect(source).toContain('url.scheme == "https"');
    expect(source).toContain('host == "context.lc" || host.hasSuffix(".context.lc")');
    expect(source).toContain("extensionContext?.open(url)");
  });

  test("the generated prebuild embeds the extension with its icon and sources", () => {
    const project = path.join(__dirname, "..", "ios", "Context.xcodeproj", "project.pbxproj");
    if (!fs.existsSync(project)) return;
    const body = fs.readFileSync(project, "utf8");
    expect(body).toMatch(/ContextMessages\.appex in Copy Files/);
    expect(body).toMatch(/MessagesViewController\.swift in Sources/);
    expect(body).toMatch(/Assets\.xcassets in Resources/);
    expect(body).toContain('ASSETCATALOG_COMPILER_APPICON_NAME = "iMessage App Icon"');
  });
});
