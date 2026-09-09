const fs = require("node:fs");
const path = require("node:path");
const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("@expo/config-plugins");

const TARGET_NAME = "ContextWidgets";
const SOURCE_DIRECTORY = "targets/context-widgets";
const IOS_DIRECTORY = TARGET_NAME;
const SOURCE_FILES = [
  "ContextWidgets.swift",
  "MeetingActivityAttributes.swift",
  "ContextMeetingLiveActivity.swift",
  "ContextQuickCaptureWidget.swift",
];

function identifiers(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) throw new Error("with-context-widgets requires ios.bundleIdentifier");
  return {
    appGroup: `group.${bundleIdentifier}`,
    extensionBundleIdentifier: `${bundleIdentifier}.widgets`,
  };
}

function declareEasExtension(config, ids) {
  const extra = { ...(config.extra ?? {}) };
  const eas = { ...(extra.eas ?? {}) };
  const build = { ...(eas.build ?? {}) };
  const experimental = { ...(build.experimental ?? {}) };
  const ios = { ...(experimental.ios ?? {}) };
  const current = Array.isArray(ios.appExtensions) ? ios.appExtensions : [];
  const extension = {
    targetName: TARGET_NAME,
    bundleIdentifier: ids.extensionBundleIdentifier,
    entitlements: {
      "com.apple.security.application-groups": [ids.appGroup],
    },
  };
  ios.appExtensions = [...current.filter((item) => item?.targetName !== TARGET_NAME), extension];
  experimental.ios = ios;
  build.experimental = experimental;
  eas.build = build;
  extra.eas = eas;
  config.extra = extra;
  return config;
}

function addWidgetTarget(project, ids) {
  const targets = project.pbxNativeTargetSection();
  const existingEntry = Object.entries(targets).find(
    ([key, target]) => !key.endsWith("_comment") && String(target?.name).replaceAll('"', "") === TARGET_NAME,
  );
  if (existingEntry) return existingEntry[0];

  const target = project.addTarget(
    TARGET_NAME,
    "app_extension",
    TARGET_NAME,
    ids.extensionBundleIdentifier,
  );
  project.addBuildPhase(
    SOURCE_FILES.map((file) => `${IOS_DIRECTORY}/${file}`),
    "PBXSourcesBuildPhase",
    "Sources",
    target.uuid,
  );

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const [key, configuration] of Object.entries(configurations)) {
    if (key.endsWith("_comment") || typeof configuration !== "object") continue;
    const settings = configuration.buildSettings;
    if (String(settings?.PRODUCT_NAME).replaceAll('"', "") !== TARGET_NAME) continue;
    settings.APPLICATION_EXTENSION_API_ONLY = "YES";
    settings.CODE_SIGN_ENTITLEMENTS = `"${IOS_DIRECTORY}/${TARGET_NAME}.entitlements"`;
    settings.CONTEXT_APP_GROUP = `"${ids.appGroup}"`;
    settings.CURRENT_PROJECT_VERSION = "$(CURRENT_PROJECT_VERSION)";
    settings.GENERATE_INFOPLIST_FILE = "NO";
    settings.INFOPLIST_FILE = `"${IOS_DIRECTORY}/${TARGET_NAME}-Info.plist"`;
    settings.IPHONEOS_DEPLOYMENT_TARGET = "16.1";
    settings.MARKETING_VERSION = "$(MARKETING_VERSION)";
    settings.PRODUCT_BUNDLE_IDENTIFIER = `"${ids.extensionBundleIdentifier}"`;
    settings.SKIP_INSTALL = "YES";
    settings.SWIFT_VERSION = "5.0";
  }
  return target.uuid;
}

function withContextWidgets(config) {
  const ids = identifiers(config);
  declareEasExtension(config, ids);

  config = withInfoPlist(config, (result) => {
    result.modResults.NSSupportsLiveActivities = true;
    result.modResults.ContextAppGroup = ids.appGroup;
    return result;
  });

  config = withEntitlementsPlist(config, (result) => {
    const key = "com.apple.security.application-groups";
    const existing = Array.isArray(result.modResults[key]) ? result.modResults[key] : [];
    result.modResults[key] = [...new Set([...existing, ids.appGroup])];
    return result;
  });

  config = withDangerousMod(config, ["ios", async (result) => {
    const projectRoot = result.modRequest.projectRoot;
    const source = path.join(projectRoot, SOURCE_DIRECTORY);
    const destination = path.join(result.modRequest.platformProjectRoot, IOS_DIRECTORY);
    if (!fs.existsSync(source)) throw new Error(`Missing Context widget sources at ${source}`);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
    return result;
  }]);

  config = withXcodeProject(config, (result) => {
    addWidgetTarget(result.modResults, ids);
    return result;
  });

  return config;
}

module.exports = withContextWidgets;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.declareEasExtension = declareEasExtension;
module.exports.identifiers = identifiers;
