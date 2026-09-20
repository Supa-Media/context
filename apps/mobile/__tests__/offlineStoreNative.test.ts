import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The native half of the key/value port, which nothing had ever executed.
 *
 * `offlineStore.test.ts` runs the conformance suite against `localStorage` and
 * against `memoryStore()`, and says in its own header that `store.ts` "is not
 * here and cannot be". `store.ts` says the same thing about itself — *"what is
 * not covered is this delegation… Keep it a delegation for that reason: any
 * logic added here is logic nothing checks."*
 *
 * Both were right about the reason and wrong about the conclusion. This suite
 * resolves `web.ts` ahead of the bare extension, so the native half is reached
 * by importing it **by its explicit path** — the arrangement
 * `pluginSandboxNativeReady.test.ts` already uses — and `AsyncStorage` is a
 * plain module that `jest.mock` can replace. There is no `jest-expo` preset
 * needed for a module that is four function calls.
 *
 * And the delegation is not neutral. Each of the four methods makes a
 * **failure-stance decision**, and one of them was wrong in a way that let a
 * sign-out report that it had cleared a device it could not read. That is the
 * whole of what is asserted here: the native half makes the same four
 * decisions as the web half, on the platform where the failure is most real —
 * `store.ts` names Android's AsyncStorage ceiling itself.
 */

/**
 * The fake `AsyncStorage`. `mock`-prefixed because the factory below reads it,
 * and jest refuses any other out-of-scope name.
 */
let mockBroken: { getAllKeys?: boolean; getItem?: boolean; removeItem?: boolean; setItem?: boolean };
let mockHeld: Map<string, string>;

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => {
      if (mockBroken.getItem) throw new Error("database disk image is malformed");
      return mockHeld.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      if (mockBroken.setItem) throw new Error("database or disk is full");
      mockHeld.set(key, value);
    },
    removeItem: async (key: string) => {
      if (mockBroken.removeItem) throw new Error("database disk image is malformed");
      mockHeld.delete(key);
    },
    getAllKeys: async () => {
      if (mockBroken.getAllKeys) throw new Error("database disk image is malformed");
      return [...mockHeld.keys()] as readonly string[];
    },
  },
}));

const { openStore } =
  require("../features/offline/store.ts") as typeof import("../features/offline/store");

beforeEach(() => {
  mockBroken = {};
  mockHeld = new Map([["a", "one"], ["b", "two"]]);
});

describe("the native key/value store", () => {
  test("round-trips, overwrites, removes, and lists", async () => {
    const store = openStore();
    expect(store.durable).toBe(true);
    expect(await store.get("a")).toBe("one");

    await store.set("a", "three");
    expect(await store.get("a")).toBe("three");
    expect((await store.keys()).sort()).toEqual(["a", "b"]);

    await store.remove("a");
    expect(await store.get("a")).toBeNull();
    await store.remove("a");
  });

  test("a read that fails answers nothing cached, because its callers have that branch", async () => {
    mockBroken.getItem = true;
    expect(await openStore().get("a")).toBeNull();
  });

  test("a removal that fails is tolerated, because stale data already has to be", async () => {
    mockBroken.removeItem = true;
    await expect(openStore().remove("a")).resolves.toBeUndefined();
  });

  test("a write that fails REACHES the caller, because it is somebody's typing", async () => {
    // The asymmetry both halves of this port document. A queue write that
    // silently did nothing is the failure `outbox.ts` has a sentence for.
    mockBroken.setItem = true;
    await expect(openStore().set("a", "x")).rejects.toThrow();
  });

  test("a listing that fails REACHES the caller too, because its callers are the clears", async () => {
    /*
      The one that was wrong. `keys()` had the read stance — swallow, answer
      `[]` — but it has no read callers: `forgetEverything`,
      `forgetWorkspace`, `forgetDepartedContexts`, `sweep`, `forgetPlace`,
      `forgetAllMeetings` and `forget.ts`'s own verification are all clears, and
      to a clear "no keys" means **done**, not "nothing cached".

      On a phone this is the live case rather than the theoretical one:
      `store.ts` names Android's AsyncStorage ceiling itself, and a corrupt or
      full SQLite database is exactly where `getAllKeys` throws while `getItem`
      goes on answering — so the note bodies stay readable while the clear that
      was supposed to take them reports success.
    */
    mockBroken.getAllKeys = true;
    await expect(openStore().keys()).rejects.toThrow();

    // Anti-vacuity: a working listing still answers, so "rejects" is about the
    // failure rather than about this method being broken outright.
    mockBroken.getAllKeys = false;
    expect((await openStore().keys()).sort()).toEqual(["a", "b"]);
  });

  test("the listing is a plain array the caller may sort in place", async () => {
    // `getAllKeys` answers `readonly string[]`; every caller here sorts or
    // filters it. The spread in `store.ts` is what makes that safe, and it is
    // the one line of this delegation that is not a straight pass-through.
    const listed = await openStore().keys();
    expect(() => listed.sort()).not.toThrow();
  });
});
