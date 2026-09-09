// The application deliberately does not import this package.  It resolves the
// module through `requireOptionalNativeModule` so the pinned OTA runtime remains
// safe on Context binaries made before this module existed.
export {};
