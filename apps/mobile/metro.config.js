const path = require("node:path");
const { createMetroConfig } = require("@supa-media/metro");

const config = createMetroConfig({
  projectRoot: __dirname,
  sharedPackages: ["@context/shared", "@context/drawings"],
  // Use Sentry's serializer so native and OTA bundles carry debug IDs that
  // match the source maps uploaded during the build.
  withSentry: true,
});

// CI exports must read the checkout on disk, not a long-lived parent Watchman
// watch whose cache can still name files from a branch that was just replaced.
if (process.env.CI) config.resolver.useWatchman = false;

/*
  ── ONE DEPENDENCY RESOLVES DIFFERENTLY ON A DEVICE, AND DID NOT RESOLVE ──

  Yjs reaches Web Crypto through `lib0/webcrypto`, whose package exports carry
  a `react-native` condition pointing at a file that requires
  `isomorphic-webcrypto/src/react-native` — a package nothing in this tree
  depends on. So the web bundle built and the native bundles did not:

      Unable to resolve module isomorphic-webcrypto/src/react-native

  Redirected here, for `ios` and `android` only, to a shim over `expo-crypto`.
  The web console keeps lib0's browser build and the platform's real
  `crypto.subtle`; see `shims/lib0-webcrypto.js` for what the shim provides and
  what it deliberately does not.

  Narrow on purpose. This rewrites **one** specifier on **two** platforms, so a
  future resolution failure is still a resolution failure rather than something
  this function quietly absorbed — and `defaultResolver` handles everything
  else, including every other lib0 entry point.
*/
const LIB0_WEBCRYPTO = "lib0/webcrypto";
const NATIVE = new Set(["ios", "android"]);
const shim = path.join(__dirname, "shims", "lib0-webcrypto.js");

const defaultResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === LIB0_WEBCRYPTO && NATIVE.has(platform)) {
    return { type: "sourceFile", filePath: shim };
  }
  // `context.resolveRequest` is Metro's own resolver and is what a config that
  // did not set this field would have used. Calling the captured previous
  // value first keeps any resolver the framework's config installed.
  return defaultResolver
    ? defaultResolver(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
