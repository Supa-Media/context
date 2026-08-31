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
  web: {
    favicon: "./assets/favicon.png",
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
  /**
   * One runtime, pinned, for the life of the app.
   *
   * This is a Supa Media convention rather than this app's own idea: every app
   * in the estate pins a single runtime version and ships almost everything
   * over the air. An older app carries whatever number it was pinned at years
   * ago (togather is in the 1.0.2x range); a new one starts at `1.0.0` and
   * stays there.
   *
   * **It was `{ policy: "appVersion" }`, which is the trap.** That policy makes
   * the runtime version *track the `version` field above* — so the first time
   * anybody ships an App Store release and bumps `1.0.0` to `1.0.1`, the
   * runtime forks. Every install still on 1.0.0 is then on an orphaned runtime:
   * `eas update` keeps publishing, those clients keep polling, and nothing ever
   * reaches them again. Nothing fails, nothing logs, they simply stop getting
   * updates. Pinning the literal decouples the two, so the marketing version
   * can move as often as the App Store wants it to.
   *
   * **What this buys, and what it costs.** It buys one update channel that
   * reaches every install ever shipped. It costs the guarantee that the JS in
   * an update can assume the native modules it was built against — because that
   * bundle will land on clients built months earlier. That is what
   * `native-deps.json` is for: `core` is the baseline every build has, and
   * anything added later goes in `gated` and must be imported dynamically
   * behind a runtime check with a real fallback. `supa-framework.test.js`
   * enforces it (`tests.nativeImports`), and a static import of a gated
   * dependency fails CI rather than crashing an old phone.
   *
   * **The one legitimate reason to change this string** is a native change no
   * gate can paper over — an Expo SDK upgrade that moves the ABI. Bumping it
   * then is deliberate: it strands every existing install on its current JS
   * until people update through the store, which is the cost of the upgrade and
   * should be stated in the PR that does it. Bumping it for any other reason,
   * or restoring the `appVersion` policy because it "looks tidier", is how the
   * estate ends up maintaining a runtime per release.
   */
  runtimeVersion: "1.0.0",
  updates: {
    // Built from the real projectId above rather than repeated, so the two can
    // never drift. The placeholder that used to sit here made every `eas
    // update` fail ("Add the following EAS Update key-values to the project
    // app.config.js"), so OTA updates have never shipped — and the string was
    // public in an open-source repo.
    url: `https://u.expo.dev/${PROJECT_ID}`,
  },
});
