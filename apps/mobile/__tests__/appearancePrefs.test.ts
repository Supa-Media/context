/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  APPEARANCE_STORAGE_KEY,
  readStoredScheme,
  writeStoredScheme,
} from "../features/design/appearancePrefs";
import { peekStoredSchemeSync as peekWeb } from "../features/design/appearancePeek.web";

/**
 * The native half, reached the way `providerOpenNative.test.ts` reaches
 * `open.ts`: this suite resolves `.web.ts` ahead of the bare extension for
 * every platform pair (`jest.config.js`, "the way Metro does when it bundles
 * for the browser"), so a plain `from "./appearancePeek"` import — even a
 * bare `require` of the same specifier — would silently hand back the *web*
 * module. Only a specifier that already carries the `.ts` extension skips
 * that extension search and names this file unambiguously.
 */
const native = require("../features/design/appearancePeek.ts") as typeof import("../features/design/appearancePeek");
const peekNative = native.peekStoredSchemeSync;
import {
  AppearanceProvider,
  resetAppearanceForTests,
  useAppearanceChoice,
  useScheme,
} from "../features/design/theme";

/**
 * The remembered appearance choice: persistence, the synchronous first-paint
 * peek that avoids a flash on web, and the live store `theme.tsx` builds on
 * top of both for the app root and the settings panel to share.
 *
 * `resetAppearanceForTests` re-runs the synchronous peek against whatever
 * `localStorage` holds *right now* — it is not a blunt "forget everything",
 * it is "boot again, as if this were a fresh process" — which is what lets a
 * test change the stored value and then see a fresh boot without a full
 * `jest.resetModules()`.
 */

afterEach(() => {
  window.localStorage.clear();
  resetAppearanceForTests();
});

describe("appearancePrefs — persistence", () => {
  test("round-trips light and dark through the store the offline cache also uses", async () => {
    await writeStoredScheme("light");
    expect(await readStoredScheme()).toBe("light");

    await writeStoredScheme("dark");
    expect(await readStoredScheme()).toBe("dark");
  });

  test('`null` clears the key — that is what "follow the device" is stored as', async () => {
    await writeStoredScheme("dark");
    await writeStoredScheme(null);
    expect(await readStoredScheme()).toBeNull();
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  test("nothing stored, or garbage, lands on null rather than throwing", async () => {
    expect(await readStoredScheme()).toBeNull();
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "purple");
    expect(await readStoredScheme()).toBeNull();
  });

  test("a write that throws (a full quota, say) resolves quietly rather than rejecting", async () => {
    // `store.web.ts` deliberately leaves `set` unguarded — a queued note edit
    // must not fail silently — so this preference's writer is the one that
    // has to decide a lost write here is worth nothing more than a cache
    // miss. A caller that `void`s the promise (`theme.tsx`'s `setChoice`
    // does) must never see an unhandled rejection out of this.
    //
    // Only the real key throws. `openStore()` itself probes `localStorage`
    // with a throwaway key before handing back a store (`store.web.ts`'s
    // `canWrite()`) — if the mock threw unconditionally, that probe would
    // fail instead, `openStore()` would fall back to an in-memory store for
    // the rest of the test, and the write under test would never reach real
    // `localStorage` at all. Throwing only for `APPEARANCE_STORAGE_KEY`
    // is what makes this a test of the write failing, not of the probe.
    const original = window.localStorage.setItem.bind(window.localStorage);
    const setItem = jest
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation((...args: unknown[]) => {
        const [key, value] = args as [string, string];
        if (key === APPEARANCE_STORAGE_KEY) throw new Error("QuotaExceededError");
        original(key, value);
      });
    try {
      await expect(writeStoredScheme("dark")).resolves.toBeUndefined();
      // And the failure was real, not merely swallowed by the fallback store:
      // nothing landed.
      expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("appearancePeek — the synchronous first-paint check", () => {
  test("native always answers unresolved, never guessing at a scheme", () => {
    // `AsyncStorage` is a bridge call — there is nothing synchronous to read
    // on native, so this must never claim an answer it does not have.
    expect(peekNative()).toEqual({ scheme: null, resolved: false });
  });

  test("web answers synchronously from localStorage, resolved either way", () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "light");
    expect(peekWeb()).toEqual({ scheme: "light", resolved: true });
  });

  test('web with nothing stored is still resolved — "no preference" is a real answer, not a pending one', () => {
    expect(peekWeb()).toEqual({ scheme: null, resolved: true });
  });

  test("web ignores garbage rather than surfacing it as a scheme", () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "purple");
    expect(peekWeb()).toEqual({ scheme: null, resolved: true });
  });

  test('a bare import resolves ".web.ts" ahead of the plain file, exactly like Metro on the browser', () => {
    // The same resolution `theme.tsx`'s own `import { peekStoredSchemeSync }
    // from "./appearancePeek"` goes through. If this suite ever stopped
    // preferring `.web.ts` for a bare specifier, `useAppearanceChoice`'s tests
    // below would silently start exercising the *native* stub instead — the
    // same false-green shape `jest.config.js` calls out for `clipboard.web.ts`
    // and its siblings.
    const bare =
      require("../features/design/appearancePeek") as typeof import("../features/design/appearancePeek.web");
    expect(bare.peekStoredSchemeSync()).toEqual(peekWeb());
    expect(bare.peekStoredSchemeSync()).not.toEqual(peekNative());
  });
});

/* -------------------------------------------------------------------------- */
/* useAppearanceChoice / AppearanceProvider — the live store in theme.tsx     */
/* -------------------------------------------------------------------------- */

function mount(node: ReturnType<typeof createElement>): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useAppearanceChoice", () => {
  test('nothing stored: defaults to "system", and is immediately ready on web', () => {
    let seen: ReturnType<typeof useAppearanceChoice> | undefined;
    function Probe() {
      seen = useAppearanceChoice();
      return null;
    }
    const { unmount } = mount(createElement(Probe));
    expect(seen?.choice).toBe("system");
    expect(seen?.ready).toBe(true);
    unmount();
  });

  test("a stored choice is what the very first render sees — the whole point of the sync peek", () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "dark");
    resetAppearanceForTests();

    let seen: ReturnType<typeof useAppearanceChoice> | undefined;
    function Probe() {
      seen = useAppearanceChoice();
      return null;
    }
    const { unmount } = mount(createElement(Probe));
    // Not "eventually dark" — dark on the very first call, before any effect
    // has had a chance to run and correct a wrong guess.
    expect(seen?.choice).toBe("dark");
    expect(seen?.ready).toBe(true);
    unmount();
  });

  test("setChoice updates every reader in the same tick, and persists", () => {
    let seenA: ReturnType<typeof useAppearanceChoice> | undefined;
    let seenB: ReturnType<typeof useAppearanceChoice> | undefined;
    function ProbeA() {
      seenA = useAppearanceChoice();
      return null;
    }
    function ProbeB() {
      seenB = useAppearanceChoice();
      return null;
    }
    const { unmount } = mount(
      createElement("div", null, createElement(ProbeA), createElement(ProbeB)),
    );
    expect(seenA?.choice).toBe("system");

    act(() => {
      seenA?.setChoice("light");
    });
    expect(seenA?.choice).toBe("light");
    // Two unrelated components, one store: `ProbeB` sees the change without
    // ever having been told about `ProbeA`.
    expect(seenB?.choice).toBe("light");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");

    act(() => {
      seenB?.setChoice("system");
    });
    expect(seenA?.choice).toBe("system");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    unmount();
  });
});

describe("AppearanceProvider", () => {
  test("pins the app to the stored choice rather than the system's", () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "light");
    resetAppearanceForTests();

    let seenScheme: string | undefined;
    function Probe() {
      seenScheme = useScheme();
      return null;
    }
    const { unmount } = mount(createElement(AppearanceProvider, null, createElement(Probe)));
    expect(seenScheme).toBe("light");
    unmount();
  });

  test('follows the system when the choice is "system", and stops the moment something is pinned', () => {
    let seenScheme: string | undefined;
    let setChoice: ((choice: "light" | "dark" | "system") => void) | undefined;
    function Probe() {
      const appearance = useAppearanceChoice();
      seenScheme = useScheme();
      setChoice = appearance.setChoice;
      return null;
    }
    const { unmount } = mount(createElement(AppearanceProvider, null, createElement(Probe)));
    // jsdom's `useColorScheme()` (via react-native-web) reliably answers
    // "light" here — the same value `theme.test.ts`'s own
    // `resolveScheme(null, "light")` case exercises directly.
    expect(seenScheme).toBe("light");

    // Pinning to dark overrides the system's "light", proving this is really
    // wired through rather than the provider having landed on "light" by
    // coincidence.
    act(() => {
      setChoice?.("dark");
    });
    expect(seenScheme).toBe("dark");

    // And letting go of the pin returns to the system's answer, not to a
    // hardcoded fallback.
    act(() => {
      setChoice?.("system");
    });
    expect(seenScheme).toBe("light");
    unmount();
  });
});
