const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withXcodeProject } = require("@expo/config-plugins");

/**
 * The Context card in Messages: an iMessage extension whose cards Tex sends
 * for a link to a note (apps/agent/src/appCards.ts), and which opens the
 * note when a card is tapped. Its bundle id is the app's plus `.messages`,
 * the id the texting Worker names on each card (apps/agent/wrangler.jsonc).
 * Built the way with-context-widgets.js builds the widgets.
 */

const TARGET_NAME = "ContextMessages";
const SOURCE_DIRECTORY = "targets/context-messages";
const IOS_DIRECTORY = TARGET_NAME;
const SOURCE_FILES = ["MessagesViewController.swift", "CardShell.swift"];
const RESOURCE_FILES = ["Assets.xcassets"];
const ICON_SET = "iMessage App Icon";
const PRODUCT_TYPE = '"com.apple.product-type.app-extension.messages"';

function identifiers(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) throw new Error("with-context-messages requires ios.bundleIdentifier");
  return { extensionBundleIdentifier: `${bundleIdentifier}.messages` };
}

function declareEasExtension(config, ids) {
  const extra = { ...(config.extra ?? {}) };
  const eas = { ...(extra.eas ?? {}) };
  const build = { ...(eas.build ?? {}) };
  const experimental = { ...(build.experimental ?? {}) };
  const ios = { ...(experimental.ios ?? {}) };
  const current = Array.isArray(ios.appExtensions) ? ios.appExtensions : [];
  const extension = { targetName: TARGET_NAME, bundleIdentifier: ids.extensionBundleIdentifier };
  ios.appExtensions = [...current.filter((item) => item?.targetName !== TARGET_NAME), extension];
  experimental.ios = ios;
  build.experimental = experimental;
  eas.build = build;
  extra.eas = eas;
  config.extra = extra;
  return config;
}

function addMessagesTarget(project, ids, versions = {}) {
  const targets = project.pbxNativeTargetSection();
  const existingEntry = Object.entries(targets).find(
    ([key, target]) => !key.endsWith("_comment") && String(target?.name).replaceAll('"', "") === TARGET_NAME,
  );
  if (existingEntry) {
    existingEntry[1].productType = PRODUCT_TYPE;
    return existingEntry[0];
  }

  // As for the widgets: node-xcode skips the dependency unless these exist.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const target = project.addTarget(TARGET_NAME, "app_extension", TARGET_NAME, ids.extensionBundleIdentifier);
  // node-xcode creates a generic extension. Xcode only compiles a stickers
  // icon catalog for its Messages product type (the native template's type).
  target.pbxNativeTarget.productType = PRODUCT_TYPE;
  project.addBuildPhase(
    SOURCE_FILES.map((file) => `${IOS_DIRECTORY}/${file}`),
    "PBXSourcesBuildPhase",
    "Sources",
    target.uuid,
  );
  project.addBuildPhase(
    RESOURCE_FILES.map((file) => `${IOS_DIRECTORY}/${file}`),
    "PBXResourcesBuildPhase",
    "Resources",
    target.uuid,
  );

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const [key, configuration] of Object.entries(configurations)) {
    if (key.endsWith("_comment") || typeof configuration !== "object") continue;
    const settings = configuration.buildSettings;
    if (String(settings?.PRODUCT_NAME).replaceAll('"', "") !== TARGET_NAME) continue;
    settings.APPLICATION_EXTENSION_API_ONLY = "YES";
    settings.ASSETCATALOG_COMPILER_APPICON_NAME = `"${ICON_SET}"`;
    settings.CURRENT_PROJECT_VERSION = String(versions.buildNumber ?? "1");
    settings.GENERATE_INFOPLIST_FILE = "NO";
    settings.INFOPLIST_FILE = `"${IOS_DIRECTORY}/${TARGET_NAME}-Info.plist"`;
    settings.IPHONEOS_DEPLOYMENT_TARGET = "16.1";
    settings.MARKETING_VERSION = `"${versions.version ?? "1.0.0"}"`;
    settings.PRODUCT_BUNDLE_IDENTIFIER = `"${ids.extensionBundleIdentifier}"`;
    settings.SKIP_INSTALL = "YES";
    settings.SWIFT_VERSION = "5.0";
    settings.TARGETED_DEVICE_FAMILY = `"1,2"`;
  }
  return target.uuid;
}

function withContextMessages(config) {
  const ids = identifiers(config);
  declareEasExtension(config, ids);

  config = withDangerousMod(config, ["ios", async (result) => {
    const source = path.join(result.modRequest.projectRoot, SOURCE_DIRECTORY);
    const destination = path.join(result.modRequest.platformProjectRoot, IOS_DIRECTORY);
    if (!fs.existsSync(source)) throw new Error(`Missing Context Messages sources at ${source}`);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
    return result;
  }]);

  config = withXcodeProject(config, (result) => {
    addMessagesTarget(result.modResults, ids, { version: config.version, buildNumber: config.ios?.buildNumber });
    return result;
  });

  return config;
}

module.exports = withContextMessages;
module.exports.addMessagesTarget = addMessagesTarget;
module.exports.declareEasExtension = declareEasExtension;
module.exports.identifiers = identifiers;
