const config = require("../app.config.js")({ config: {} });
const nativeDeps = require("../native-deps.json");

/**
 * **One runtime, pinned, for the life of the app.**
 *
 * A Supa Media convention rather than this app's own idea: every app in the
 * estate pins a single runtime version and ships almost everything over the
 * air. An older app carries whatever number it was pinned at (togather is in
 * the 1.0.2x range); a new one starts at `1.0.0` and stays there.
 *
 * It is tested because the failure is **silent in both directions**. Restore
 * `{ policy: "appVersion" }` and nothing breaks until somebody ships a store
 * release: the runtime forks on the version bump, every existing install lands
 * on an orphaned runtime, and updates simply stop arriving — no error, no log,
 * no crash. Add an ungated native dependency and the reverse happens: a bundle
 * built against a module an older client does not have gets delivered to it,
 * because that is exactly what one pinned runtime means.
 *
 * So the two halves are asserted together. They are one policy, and either on
 * its own is a bug.
 */

describe("one runtime, and the obligation that comes with it", () => {
  test("the runtime version is a pinned literal, not a policy", () => {
    /*
      `{ policy: "appVersion" }` is the tidy-looking answer and it is the trap:
      it makes the runtime track `version`, so the first `1.0.0` -> `1.0.1`
      strands every install that came before it.
    */
    expect(typeof config.runtimeVersion).toBe("string");
    expect(config.runtimeVersion).toBe("1.0.0");
  });

  test("and it does not move when the store version does", () => {
    /*
      The property that matters, stated as a property rather than as two equal
      strings: these are allowed to differ, and the point of pinning is that
      changing `version` cannot drag the runtime along with it. Asserting only
      that both read "1.0.0" today would pass just as happily under the policy
      this exists to keep out.
    */
    const shipped = require("../app.config.js")({ config: { version: "2.7.3" } });
    expect(shipped.runtimeVersion).toBe("1.0.0");
  });

  test("every native dependency is classified as core or gated", () => {
    /*
      The other half of the policy. One runtime means an update lands on
      clients built long before it, so a native module that is not in the
      baseline has to be reached dynamically behind a runtime check with a real
      fallback — never a static import.

      `supa-framework.test.js` runs the framework's own scanner over the source
      for the import-shape half of this. This is the classification half, kept
      here beside the pin it exists because of: a dependency nobody classified
      is a dependency nobody decided about.
    */
    const NATIVE = [/^react-native$/, /^react-native-/, /^@react-native(-community)?\//, /^expo-/, /^@expo\//];
    const classified = new Set([...nativeDeps.core, ...nativeDeps.gated]);
    const deps = Object.keys(require("../package.json").dependencies);

    const unclassified = deps.filter(
      (name) => NATIVE.some((re) => re.test(name)) && !classified.has(name) && name !== "expo",
    );
    expect(unclassified).toEqual([]);
  });

  test("nothing is in both lists", () => {
    // `core` is "every build has it"; `gated` is "assume it is absent". A name
    // in both is a name with no answer, and the scanner would let its static
    // imports through on the strength of the `core` entry.
    const both = nativeDeps.core.filter((name) => nativeDeps.gated.includes(name));
    expect(both).toEqual([]);
  });
});
