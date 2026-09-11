/** @type {import('expo/config').ExpoConfig} */

/**
 * The EAS project id — an account identifier, not a secret, but this
 * repository is public and MIT licensed (CLAUDE.md: "no internal hostnames,
 * no account identifiers... not in code"), so it is read from the
 * environment rather than committed. `updates.url` is derived from it so the
 * two cannot drift.
 *
 * Set `EAS_PROJECT_ID` from the `EAS_PROJECT_ID` secret
 * (`scripts/secrets-allowlist.json` → the 1Password `Context` vault) in every
 * workflow that runs `eas build`, `eas update` or `eas deploy`, and in
 * `.env.local` for local EAS use. Everything else — tests, local `expo
 * start`, `expo export --platform web` when it runs outside EAS — works with
 * nothing set: `resolveEasProjectId` falls back to the same placeholder
 * `deploy-web.yml`'s "Verify the EAS project is linked" step already knows
 * how to catch.
 *
 * The one place a placeholder must never survive is an actual EAS Build,
 * which sets `EAS_BUILD=true` on its own remote worker (an EAS-documented
 * variable, unrelated to this repo's CI). Shipping a build linked to no real
 * project, or the wrong one, is a worse failure than refusing to build at
 * all — so that case throws instead of falling back.
 */
function resolveEasProjectId() {
  const projectId = process.env.EAS_PROJECT_ID;
  if (projectId) return projectId;
  if (process.env.EAS_BUILD === "true") {
    throw new Error(
      "EAS_PROJECT_ID is not set, but this is an EAS Build (EAS_BUILD=true). " +
        "Add it to the build profile's env in apps/mobile/eas.json — see " +
        "deploy-mobile-native.yml, which injects the EAS_PROJECT_ID secret " +
        "there before calling `eas build`.",
    );
  }
  return "YOUR_EAS_PROJECT_ID";
}

module.exports = ({ config }) => {
  // Read fresh on every call rather than once at module load — Node caches
  // this module, and both this file's own tests and expo's tooling call the
  // exported function more than once per process with different environments.
  const PROJECT_ID = resolveEasProjectId();

  return {
    ...config,
    name: "Context",
    slug: "context",
    version: "1.0.0",
    scheme: "context",
    orientation: "portrait",
    icon: "./assets/icon.png",
    /**
     * The app follows the system appearance.
     *
     * This value was already `"automatic"` while the app was dark-only, which is
     * the one combination that is actively wrong: iOS draws keyboards, action
     * sheets and the share sheet in the *system's* scheme, so a light-mode phone
     * got light system chrome sitting on a permanently dark app. It is honest
     * only because `features/design/tokens.ts` now carries a real light palette.
     * If that palette is ever removed, this must become `"dark"` in the same
     * change.
     */
    userInterfaceStyle: "automatic",
    assetBundlePatterns: ["**/*"],
    ios: {
      // Preserve the build number EAS remote versioning resolves.
      ...(config.ios ?? {}),
      supportsTablet: true,
      bundleIdentifier:
        process.env.APP_ENV === "staging"
          ? "lc.context.staging"
          : "lc.context.mobile",
      /**
       * No `associatedDomains` key.
       *
       * It used to be `[]`, which is not the same as absent: Expo emitted a
       * `com.apple.developer.associated-domains` entitlement containing an empty
       * array, and an entitlement the provisioning profile does not carry fails
       * the build with a mismatch rather than being ignored. Universal Links need
       * the apple-app-site-association file on context.lc before this is worth
       * turning on, so it is left out until then.
       */
      /** `expo-apple-authentication` is inert in the binary without this. */
      usesAppleSignIn: true,
      infoPlist: {
        /**
         * Context ships no encryption of its own beyond HTTPS, which is exempt.
         * Without this every single App Store Connect upload stops to ask the
         * export-compliance question by hand.
         */
        ITSAppUsesNonExemptEncryption: false,
        /**
         * Capture has to survive the phone being put down.
         *
         * Without this iOS suspends the app the moment it leaves the foreground
         * and the recording simply stops — which is the whole meeting, because
         * nobody watches a phone for an hour. It is *not* a permission string, so
         * it is not a duplicate of the plugin block below: this is an
         * entitlement-shaped capability and the plugins own no key for it.
         *
         * This native baseline is already present in the shipped binary. The
         * JS session setting is therefore safe to deliver over the air.
         */
        UIBackgroundModes: ["audio"],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        // The mark is drawn for the dark ground it sits on, not for white.
        backgroundColor: "#050506",
      },
      package:
        process.env.APP_ENV === "staging"
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
      /**
       * Android is prepared, not shipped (owner, 2026-09-07): no keystore, no
       * build, no store submission yet. This is the manifest half of that prep,
       * so the first real Android binary is one `eas build` rather than a
       * project — see `docs/decisions/meetings.md`, "Android is prepared, not
       * shipped".
       *
       * Every permission a backgrounded recording needs on Android 14+, and
       * where each one actually comes from — spelled out because two of the
       * four are already granted by a library this app depends on, and leaving
       * that undocumented is how somebody "cleans up" a permission that is
       * silently load-bearing:
       *
       *  - `RECORD_AUDIO` — also declared by the `expo-audio` plugin below
       *    (`recordAudioAndroid` defaults to `true`) and by that library's own
       *    bundled `AndroidManifest.xml`. Listed here too so this array is a
       *    complete, self-contained answer to "what does recording need" that
       *    does not require reading a dependency's source to verify.
       *  - `FOREGROUND_SERVICE` — the base permission every foreground service
       *    needs on API 28+. Already unconditional in `expo-audio`'s own
       *    bundled manifest (`android/src/main/AndroidManifest.xml` in the
       *    installed package), which Android's manifest merger folds into this
       *    app's on every build regardless of what this file says. Listed here
       *    anyway, for the same self-contained reason as `RECORD_AUDIO`.
       *  - `FOREGROUND_SERVICE_MICROPHONE` — the Android 14 (API 34) microphone
       *    foreground-service type. `expo-audio`'s plugin only adds this when
       *    its `enableBackgroundRecording` option is passed, which this config
       *    does not do (see the `expo-audio` plugin entry below for why:
       *    duplicating one permission source into two would be the thing this
       *    comment is warning against). So this line is the one that is
       *    actually load-bearing for it.
       *  - `POST_NOTIFICATIONS` — Android 13 (API 33) runtime permission a
       *    foreground service's notification needs to actually show. Same
       *    story as `FOREGROUND_SERVICE_MICROPHONE`: load-bearing here.
       *
       * What this array does **not** need to add: the `<service
       * android:foregroundServiceType="microphone">` declaration, or the
       * notification channel. `expo-audio`'s own Android module
       * (`AudioRecordingService.kt`, installed alongside the JS package)
       * already declares that service in its bundled manifest and creates its
       * notification channel at runtime the first time a recording starts — so
       * the "small config plugin under `apps/mobile/plugins/`" this was
       * expected to need turned out to be unnecessary: the library already
       * does it. If a future `expo-audio` upgrade ever drops that service, the
       * Android manifest test below is the one that will fail first.
       */
      permissions: [
        "android.permission.RECORD_AUDIO",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MICROPHONE",
        "android.permission.POST_NOTIFICATIONS",
      ],
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    /**
     * Every config plugin the native baseline needs.
     *
     * Permission strings live *here* rather than in `ios.infoPlist`, so each
     * permission has exactly one source of truth. A module listed with no config
     * object is one that only needs to be linked; a module with one is a module
     * that writes a permission string or a build setting, and leaving it bare
     * would let Expo inject its own generic English into our binary.
     */
    plugins: [
      "expo-router",
      "@sentry/react-native/expo",
      "./plugins/with-context-widgets",
      [
        "expo-splash-screen",
        {
          image: "./assets/splash.png",
          imageWidth: 180,
          resizeMode: "contain",
          // Matches `colors.ground` / the light palette's ground in tokens.ts.
          // These two must be kept in step with that file by hand: the splash is
          // native, so it is painted before any JS — including the theme — runs.
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
          /*
          What the person is actually agreeing to, in the sentence iOS shows
          them. "…to record an audio note" described a voice memo, which is not
          this: this records a meeting and sends the audio out to be
          transcribed. A prompt that misdescribes what is being recorded is an
          App Review problem and a consent problem at once, and consent is the
          one decision in this feature with no mechanical test — so the words
          are the control.
        */
          microphonePermission:
            "Context uses the microphone to record your meetings. Audio is transcribed and then discarded — only the text is saved, into storage you own.",
          /*
          Deliberately **not** `enableBackgroundRecording: true` here, even
          though that option exists and would add
          `FOREGROUND_SERVICE_MICROPHONE` and `POST_NOTIFICATIONS` for us. Two
          reasons. First, this plugin's own `enableBackgroundRecording` also
          pushes `"audio"` into `ios.infoPlist.UIBackgroundModes` — harmlessly,
          since it checks for the value before pushing and `app.config.js`
          already sets it above, but a second writer of the same iOS key is
          not a habit worth starting. Second, `android.permissions` above is
          already the one place that answers "what does recording need on
          Android" — adding a second path that grants two of the same four
          permissions is exactly the duplication that block's own comment
          warns about. If `android.permissions` above is ever removed, turn
          this on instead of leaving Android permission-less.
        */
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
     * enforces both halves of that (`tests.nativeImports`): a native dependency
     * nobody classified fails CI, and so does a static import of a gated one,
     * rather than crashing an old phone. Two bounds on that worth knowing.
     * `gated` is empty today, so only the first half actually runs — the second
     * is the guard waiting for the first dependency that needs it. And
     * classification reads `dependencies` only: an unclassified native package
     * in `devDependencies` is inspected by nothing.
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
  };
};
