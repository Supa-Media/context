/** @type {import('expo/config').ExpoConfig} */
/** The EAS project. `updates.url` is derived from it so they cannot drift. */
const PROJECT_ID = "cf13cf3d-0868-4463-b045-d7c805ea0bf7";

module.exports = ({ config }) => ({
  ...config,
  name: "Context",
  slug: "context",
  version: "1.0.0",
  scheme: "context",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: process.env.APP_ENV === "staging"
      ? "lc.context.staging"
      : "lc.context.mobile",
    associatedDomains: [],
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    package: process.env.APP_ENV === "staging"
      ? "lc.context.staging"
      : "lc.context.mobile",
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "context" }],
        category: ["DEFAULT", "BROWSABLE"],
      },
    ],
  },
  plugins: [
    "expo-router",
  ],
  extra: {
    eas: {
      projectId: PROJECT_ID,
    },
    router: {
      origin: false,
    },
  },
  owner: "lilseyi",
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    // Built from the real projectId above rather than repeated, so the two can
    // never drift. The placeholder that used to sit here made every `eas
    // update` fail ("Add the following EAS Update key-values to the project
    // app.config.js"), so OTA updates have never shipped — and the string was
    // public in an open-source repo.
    url: `https://u.expo.dev/${PROJECT_ID}`,
  },
});
