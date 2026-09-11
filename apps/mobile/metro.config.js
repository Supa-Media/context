const { createMetroConfig } = require("@supa-media/metro");

const config = createMetroConfig({
  projectRoot: __dirname,
  sharedPackages: ["@context/shared"],
  // Use Sentry's serializer so native and OTA bundles carry debug IDs that
  // match the source maps uploaded during the build.
  withSentry: true,
});

// CI exports must read the checkout on disk, not a long-lived parent Watchman
// watch whose cache can still name files from a branch that was just replaced.
if (process.env.CI) config.resolver.useWatchman = false;

module.exports = config;
