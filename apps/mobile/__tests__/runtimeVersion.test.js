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

  test("nothing is in both lists", () => {
    /*
      The other half of the policy is the framework's, and this is the one part
      of it the framework cannot see.

      `tests.nativeImports` in `supa-framework.test.js` does **both** halves —
      it scans the source for static imports of gated deps *and* it refuses a
      native dependency that nobody classified. A comment here used to claim it
      only did the first, and a local classification check sat beside it doing
      the second over five regexes where the framework has fourteen. Measured:
      an unclassified `@shopify/flash-list` fails the framework check and
      passes the local one, and `@sentry/react-native`, `@gorhom/bottom-sheet`,
      `@rnmapbox/*`, `@mapbox/*` and `@react-native-picker/*` are the same
      shape. It was not a second opinion; it was a narrower one wearing the
      same words, which is worse than no check because a reader counts two.

      What survives is the assertion the framework genuinely does not make. It
      unions `core` and `gated` into one `allClassified` set, so a name in both
      is silently accepted — and it is a name with no answer: `core` says
      "every build has it", `gated` says "assume it is absent", and the scanner
      would wave its static imports through on the strength of the `core`
      entry. Sabotage-checked in both directions.
    */
    const both = nativeDeps.core.filter((name) => nativeDeps.gated.includes(name));
    expect(both).toEqual([]);
  });
});
