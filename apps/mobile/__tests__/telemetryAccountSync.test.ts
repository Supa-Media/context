import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The Privacy & feedback switches following the account.
 *
 * What has to hold, because each one is somebody's telemetry going somewhere
 * they said it should not:
 *
 *  - a switch turned off on this device reaches the account, and a switch
 *    turned off elsewhere reaches this device;
 *  - the later of two changes wins, and a change made offline is not lost;
 *  - a device that somebody else signed in to never hands their choices to
 *    the next person's account;
 *  - a failed save to the account is retried, never dropped.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   a waiting device change is never pushed                              4
 *   another account's device choice is pushed to the new account        2
 *   push clears pending even when a newer change landed meanwhile         1
 *   a legacy device choice is claimed instead of pushed                  2
 */

jest.mock("../features/offline/store", () => {
  const { memoryStore } = jest.requireActual<typeof import("../features/offline/memory")>(
    "../features/offline/memory",
  );
  const store = memoryStore();
  return { openStore: () => store, __store: store };
});

const prefs = require("../features/observability/preferences") as typeof import("../features/observability/preferences");
const sync = require("../features/observability/accountPreferences") as typeof import("../features/observability/accountPreferences");
const storeModule = require("../features/offline/store") as { __store: import("../features/offline/memory").KeyValueStore };

const ALL_ON = { crashReports: true, screenCounts: true, recordings: true };
const CRASH_OFF = { crashReports: false, screenCounts: true, recordings: true };
const COUNTS_OFF = { crashReports: true, screenCounts: false, recordings: false };

async function seed(record: Record<string, unknown>) {
  await storeModule.__store.set("context.telemetry.preferences.v1", JSON.stringify(record));
  prefs.resetPreferencesForTests();
  sync.resetAccountSyncForTests();
}

function pusher() {
  const pushed: Array<Record<string, boolean>> = [];
  let fail = false;
  let at = 5_000;
  const push = async (value: { crashReports: boolean; screenCounts: boolean; recordings: boolean }) => {
    if (fail) throw new Error("offline");
    pushed.push({ ...value });
    at += 1;
    return at;
  };
  return {
    push,
    pushed,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

beforeEach(async () => {
  for (const key of await storeModule.__store.keys()) await storeModule.__store.remove(key);
  prefs.resetPreferencesForTests();
  sync.resetAccountSyncForTests();
});

describe("deciding which copy wins", () => {
  test("the account's choice replaces this device's once it is known", () => {
    expect(sync.reconcile({ ...ALL_ON, account: "u1" }, { ...CRASH_OFF, updatedAt: 10 }, "u1")).toEqual({
      kind: "adopt",
      value: { ...CRASH_OFF, updatedAt: 10 },
    });
  });

  test("a change made here and not yet saved beats an older account copy", () => {
    expect(
      sync.reconcile({ ...CRASH_OFF, account: "u1", pending: true, changedAt: 20 }, { ...ALL_ON, updatedAt: 10 }, "u1"),
    ).toEqual({ kind: "push", value: CRASH_OFF });
  });

  test("a newer change on another device beats one waiting here", () => {
    expect(
      sync.reconcile({ ...CRASH_OFF, account: "u1", pending: true, changedAt: 20 }, { ...COUNTS_OFF, updatedAt: 30 }, "u1"),
    ).toEqual({ kind: "adopt", value: { ...COUNTS_OFF, updatedAt: 30 } });
  });

  test("a choice made before the account kept one is carried up to it", () => {
    expect(sync.reconcile(CRASH_OFF, null, "u1")).toEqual({ kind: "push", value: CRASH_OFF });
    expect(sync.reconcile(ALL_ON, null, "u1")).toEqual({ kind: "claim" });
  });

  test("somebody else's choices on this device never reach the next account", () => {
    expect(sync.reconcile({ ...CRASH_OFF, account: "someone-else" }, null, "u1")).toEqual({ kind: "reset" });
    expect(
      sync.reconcile({ ...CRASH_OFF, account: "someone-else", pending: true, changedAt: 99 }, { ...COUNTS_OFF, updatedAt: 1 }, "u1"),
    ).toEqual({ kind: "adopt", value: { ...COUNTS_OFF, updatedAt: 1 } });
  });
});

describe("keeping the two copies in step", () => {
  test("the account's choice is applied here and telemetry hears about it", async () => {
    const heard: unknown[] = [];
    prefs.onPreferencesChange((value) => heard.push(value));
    const p = pusher();
    await sync.syncWithAccount({ ...CRASH_OFF, updatedAt: 10 }, "u1", p.push);
    expect(prefs.preferences()).toEqual(CRASH_OFF);
    expect(heard).toEqual([CRASH_OFF]);
    expect(p.pushed).toEqual([]);
  });

  test("a switch turned here goes to the account", async () => {
    const p = pusher();
    await sync.syncWithAccount(null, "u1", p.push);
    const stop = sync.startAccountSync("u1", p.push);
    await prefs.setPreferences({ crashReports: false });
    await sync.settledForTests();
    expect(p.pushed).toEqual([CRASH_OFF]);
    expect((await prefs.loadStoredPreferences()).pending).toBeUndefined();
    stop();
  });

  test("a failed save stays waiting and goes on the next chance", async () => {
    const p = pusher();
    await sync.syncWithAccount(null, "u1", p.push);
    const stop = sync.startAccountSync("u1", p.push);
    p.setFail(true);
    await prefs.setPreferences({ crashReports: false });
    await sync.settledForTests();
    expect((await prefs.loadStoredPreferences()).pending).toBe(true);
    p.setFail(false);
    await sync.syncWithAccount(null, "u1", p.push);
    expect(p.pushed).toEqual([CRASH_OFF]);
    expect((await prefs.loadStoredPreferences()).pending).toBeUndefined();
    stop();
  });

  test("a change made while a save is in flight is not marked saved", async () => {
    let release: () => void = () => {};
    const pushed: Array<{ screenCounts: boolean }> = [];
    // Only the first save is slow; the change made during it must still go.
    const slowPush = (value: { crashReports: boolean; screenCounts: boolean; recordings: boolean }) =>
      new Promise<number>((resolve) => {
        pushed.push(value);
        if (pushed.length === 1) release = () => resolve(100);
        else resolve(200);
      });
    await sync.syncWithAccount(null, "u1", slowPush);
    const stop = sync.startAccountSync("u1", slowPush);
    await prefs.setPreferences({ crashReports: false });
    await prefs.setPreferences({ screenCounts: false });
    release();
    await sync.settledForTests();
    expect(pushed.at(-1)?.screenCounts).toBe(false);
    expect((await prefs.loadStoredPreferences()).pending).toBeUndefined();
    stop();
  });

  test("a device another person used starts from the defaults for the next", async () => {
    await seed({ ...CRASH_OFF, account: "someone-else" });
    const p = pusher();
    await sync.syncWithAccount(null, "u1", p.push);
    expect(prefs.preferences()).toEqual(ALL_ON);
    expect(p.pushed).toEqual([]);
    expect((await prefs.loadStoredPreferences()).account).toBe("u1");
  });

  test("an old device choice with no account is carried to the account", async () => {
    await seed(CRASH_OFF);
    const p = pusher();
    await sync.syncWithAccount(null, "u1", p.push);
    expect(p.pushed).toEqual([CRASH_OFF]);
    expect(prefs.preferences()).toEqual(CRASH_OFF);
  });

  test("a malformed account id in storage is not trusted", async () => {
    await seed({ ...CRASH_OFF, account: "../../u1" });
    expect((await prefs.loadStoredPreferences()).account).toBeUndefined();
  });
});
