const { afterEach, beforeEach, describe, expect, test } = require("@jest/globals");

/**
 * The EAS project id used to be a literal committed to `app.config.js` —
 * `apps/mobile/eas.json`'s Apple team id sat beside it the same way. Both are
 * account identifiers with no business in a public, MIT-licensed repository
 * (see CLAUDE.md, "This repository is public and MIT licensed"), so the id
 * now comes from `process.env.EAS_PROJECT_ID`, set from the `EAS_PROJECT_ID`
 * secret (`scripts/secrets-allowlist.json`) in CI and from `.env.local`
 * locally.
 *
 * ## Why this has to keep working with nothing set
 *
 * `runtimeVersion.test.js` already `require`s this file with no environment
 * configured, and so does `expo export --platform web` when it runs outside
 * EAS (CI's `deploy-web.yml` job, or a developer's laptop). Both are ordinary,
 * working states — not the placeholder the CI check in `deploy-web.yml`
 * already knows how to catch (`""` or `YOUR_EAS_PROJECT_ID`), which is why the
 * fallback below is exactly that literal rather than a new one.
 *
 * ## Why an actual EAS build gets no fallback
 *
 * `EAS_BUILD` is the environment variable EAS Build sets to `"true"` on its
 * own remote worker — the one place a placeholder project id would silently
 * link the build to nothing, or to the wrong project, rather than failing.
 * That is worse than refusing outright, so the placeholder only survives
 * everywhere EAS_BUILD is not `"true"`.
 */
describe("app.config.js reads EAS_PROJECT_ID from the environment", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.EAS_PROJECT_ID;
    delete process.env.EAS_BUILD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("with nothing set, config still loads — for tests and local dev", () => {
    const config = require("../app.config.js")({ config: {} });
    expect(config.extra.eas.projectId).toBe("YOUR_EAS_PROJECT_ID");
    expect(config.updates.url).toBe("https://u.expo.dev/YOUR_EAS_PROJECT_ID");
  });

  test("with EAS_PROJECT_ID set, it is used verbatim", () => {
    process.env.EAS_PROJECT_ID = "11111111-2222-3333-4444-555555555555";
    const config = require("../app.config.js")({ config: {} });
    expect(config.extra.eas.projectId).toBe("11111111-2222-3333-4444-555555555555");
    expect(config.updates.url).toBe(
      "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
    );
  });

  test("on an EAS build with no EAS_PROJECT_ID, it fails clearly instead of shipping a placeholder", () => {
    process.env.EAS_BUILD = "true";
    expect(() => require("../app.config.js")({ config: {} })).toThrow(/EAS_PROJECT_ID/);
  });

  test("on an EAS build with EAS_PROJECT_ID set, it does not throw", () => {
    process.env.EAS_BUILD = "true";
    process.env.EAS_PROJECT_ID = "11111111-2222-3333-4444-555555555555";
    expect(() => require("../app.config.js")({ config: {} })).not.toThrow();
  });
});

/**
 * Everything this object is *not* is the point: no `android` key, because that
 * is the one thing Android-prep is allowed to touch, and this is compared
 * against the rendered config with `android` stripped out. Captured from this
 * file's own output before the Android permissions existed, and pinned here
 * rather than fetched from `origin/main` at test time — a shallow CI checkout
 * often has no such ref, and a test that reaches outside itself to pass is one
 * that can pass for the wrong reason. A future PR that legitimately changes
 * iOS, the plugin list, or anything else non-Android updates this object in
 * the same commit, the same rule `meetingsCapture.test.ts` applies to
 * `MEETING_AUDIO_MODE`.
 */
const BEFORE_ANDROID_PREP = {
  name: "Context",
  slug: "context",
  version: "1.0.0",
  scheme: "context",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "lc.context.mobile",
    usesAppleSignIn: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: ["audio"],
    },
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash.png",
        imageWidth: 180,
        resizeMode: "contain",
        backgroundColor: "#FFFFFF",
        dark: { backgroundColor: "#050506" },
      },
    ],
    ["expo-notifications", { color: "#3B82F6" }],
    [
      "expo-camera",
      {
        cameraPermission:
          "Context uses the camera so you can capture a photo straight into a note.",
        microphonePermission:
          "Context uses the microphone to record an audio note.",
        recordAudioAndroid: true,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission:
          "Context needs your photo library so you can attach an image to a note.",
        cameraPermission:
          "Context uses the camera so you can capture a photo straight into a note.",
      },
    ],
    [
      "expo-media-library",
      {
        photosPermission:
          "Context needs your photo library so you can attach an image to a note.",
        savePhotosPermission:
          "Context saves images you export from a note back to your photo library.",
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      "expo-local-authentication",
      {
        faceIDPermission:
          "Context can use Face ID to unlock a private context on this device.",
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission:
          "Context uses the microphone to record your meetings. Audio is transcribed and then discarded — only the text is saved, into storage you own.",
      },
    ],
    "expo-video",
    "expo-font",
    "expo-localization",
    "expo-web-browser",
    "expo-background-task",
    "expo-mail-composer",
  ],
  extra: {
    eas: { projectId: "YOUR_EAS_PROJECT_ID" },
    router: { origin: false },
  },
  owner: "lilseyi",
  runtimeVersion: "1.0.0",
  updates: { url: "https://u.expo.dev/YOUR_EAS_PROJECT_ID" },
};

/**
 * Android: prepared, not shipped (owner, 2026-09-07). No keystore, no build,
 * no store submission — see `docs/decisions/meetings.md`. This is the test for
 * the manifest half of that prep.
 */
describe("app.config.js: Android is prepared for a backgrounded recording", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.EAS_PROJECT_ID;
    delete process.env.EAS_BUILD;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /**
   * All four permissions a foreground microphone recording needs on Android
   * 14+, spelled out explicitly rather than left to be inferred from what
   * `expo-audio`'s plugin happens to add — see the comment on `android.permissions`
   * in `app.config.js` for which of these are also granted elsewhere, and why
   * that redundancy is deliberate rather than accidental.
   */
  test("declares RECORD_AUDIO, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE and POST_NOTIFICATIONS", () => {
    const config = require("../app.config.js")({ config: {} });
    expect(config.android.permissions).toEqual([
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MICROPHONE",
      "android.permission.POST_NOTIFICATIONS",
    ]);
  });

  /**
   * `expo-audio`'s own plugin has an `enableBackgroundRecording` option that
   * would add two of the four permissions above on its own — see
   * `node_modules/expo-audio/plugin/build/withAudio.js`. This app does not
   * pass it, on purpose: `android.permissions` above is the one place that
   * answers "what does recording need on Android", and asking the plugin for
   * the same two permissions would be a second, driftable source for them.
   * This test is what catches somebody "helpfully" turning the option on
   * later without also removing the explicit list.
   */
  test("does not ask expo-audio's plugin to add its own copy of those permissions", () => {
    const config = require("../app.config.js")({ config: {} });
    const audioPlugin = config.plugins.find(
      (entry) => Array.isArray(entry) && entry[0] === "expo-audio",
    );
    expect(audioPlugin[1]).toEqual({
      microphonePermission:
        "Context uses the microphone to record your meetings. Audio is transcribed and then discarded — only the text is saved, into storage you own.",
    });
  });

  /**
   * The point of adding Android's permissions as a plain `android.permissions`
   * array — no plugin, no `enableBackgroundRecording` — is that it cannot
   * touch anything else this file renders, iOS included. This is the test
   * that would catch it if it ever did.
   */
  test("the Android permissions are additive: nothing else this file renders changed", () => {
    const { android, ...rest } = require("../app.config.js")({ config: {} });
    expect(rest).toEqual(BEFORE_ANDROID_PREP);
    expect(Object.keys(android).sort()).toEqual([
      "adaptiveIcon",
      "intentFilters",
      "package",
      "permissions",
    ]);
  });

  /**
   * The one thing this file cannot prove on its own: that `expo-audio`'s
   * *installed* Android module still bundles the foreground-service
   * declaration (`<service android:foregroundServiceType="microphone">`) and
   * creates its own notification channel at runtime, which is what makes a
   * fourth config plugin under `apps/mobile/plugins/` unnecessary today. That
   * lives in `node_modules/expo-audio/android/src/main/AndroidManifest.xml`
   * and `.../service/AudioRecordingService.kt` — outside this repo, so a test
   * here would only be testing a dependency's internals, not this app. `expo
   * config --type introspect` / `expo prebuild --platform android
   * --no-install` (run by hand, see the PR this test shipped in) is the real
   * check, and the day that library ever drops the service, `eas build
   * --platform android` is what will say so.
   */
  test.todo(
    "expo-audio's bundled AndroidManifest.xml still declares the microphone foreground service (verified by hand per-release, see PR body)",
  );
});
