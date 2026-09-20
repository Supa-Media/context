/**
 * `lib0/webcrypto`, for the native bundle — because lib0's own one does not build.
 *
 * ## What breaks without this
 *
 * Yjs reaches Web Crypto through `lib0/random` → `lib0/webcrypto`, and lib0's
 * package exports pick a **`react-native`** condition that resolves to a file
 * whose first line is `require('isomorphic-webcrypto/src/react-native')`. That
 * package is not a dependency of lib0, of this app, or of anything else here,
 * so Metro cannot resolve it and the iOS and Android bundles fail outright:
 *
 *     Unable to resolve module isomorphic-webcrypto/src/react-native
 *       from lib0/dist/webcrypto.react-native.cjs
 *
 * Nothing in the unit suites sees this. Jest resolves for node, the web bundle
 * takes the `browser` condition and is fine, and the failure is a *native
 * resolution* that only happens when Metro exports for a device — which is the
 * deploy step, after merge. It took the OTA pipeline down for four merges
 * while every pull request was green, which is why `ci.yml` now exports the
 * native bundle before merging rather than after.
 *
 * ## What lib0 actually needs, and what this gives it
 *
 * Two names, which is lib0's whole published surface (`webcrypto.d.ts`):
 * `getRandomValues` and `subtle`.
 *
 * `getRandomValues` comes from `expo-crypto`, which is already a native
 * dependency of this app and is the platform's own CSPRNG rather than a
 * fallback. That is the one Yjs uses: every client id and `versionNonce` in a
 * shared document comes through `lib0/random`, and a weak source there is two
 * editors colliding on an id rather than a cosmetic problem.
 *
 * `subtle` is **not** implemented, because nothing in this app's native bundle
 * uses it: `lib0/crypto` is the only thing that would, and Yjs core does not
 * import it. It is a throwing stub rather than `undefined` so that the day
 * something does reach for it, the message says what happened and where to fix
 * it — instead of `cannot read property 'importKey' of undefined` inside a
 * dependency, on a device.
 *
 * ## Why a shim rather than adding the missing package
 *
 * `isomorphic-webcrypto` is unmaintained, pulls a polyfill stack of its own,
 * and exists to provide exactly what `expo-crypto` already provides here. This
 * is smaller, uses the platform, and is a file somebody can read.
 *
 * Wired in `metro.config.js`, for `ios` and `android` only — the web console
 * keeps lib0's browser build and real `crypto.subtle`.
 */

const { getRandomValues } = require("expo-crypto");

/**
 * The half nothing here uses, kept loud.
 *
 * Every member throws with the same sentence, so an accidental dependency on
 * `SubtleCrypto` inside the native bundle fails at the call with an
 * explanation rather than somewhere downstream with a type error.
 */
const subtle = new Proxy(
  {},
  {
    get(_target, property) {
      return () => {
        throw new Error(
          `lib0/webcrypto: subtle.${String(property)} is not available in the native bundle. ` +
            "See apps/mobile/shims/lib0-webcrypto.js — implement it there if something now needs it.",
        );
      };
    },
  },
);

module.exports = { getRandomValues, subtle };
