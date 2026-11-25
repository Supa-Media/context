import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The app's own vitals (`features/observability/vitals.ts`): what feeds the
 * Product area's Start time, Load time and Clean sessions.
 *
 * What has to hold:
 *  - one of each kind per session, so a re-render or a burst of errors does
 *    not count a session twice;
 *  - nothing is noted while crash reports are switched off;
 *  - milliseconds only on a timing, so a bad call cannot fill the sheet;
 *  - a send that fails is put back, ahead of anything newer.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   `noteVital` without the once-per-kind check                          3
 *   `noteVital` ignoring the crash reports switch                        1
 */

jest.mock("../features/offline/store", () => {
  const { memoryStore } = jest.requireActual<typeof import("../features/offline/memory")>(
    "../features/offline/memory",
  );
  const store = memoryStore();
  return { openStore: () => store };
});

const prefs = require("../features/observability/preferences") as typeof import("../features/observability/preferences");
const vitals = require("../features/observability/vitals") as typeof import("../features/observability/vitals");

beforeEach(() => {
  prefs.resetPreferencesForTests();
  vitals.resetVitalsForTests();
});

describe("app vitals", () => {
  test("a launch notes the session and one timing, once", () => {
    vitals.noteLaunch(1234.6);
    vitals.noteLaunch(99);
    const taken = vitals.takeVitals();
    expect(taken.map((item) => item.kind).sort()).toEqual(["load", "session"]);
    expect(taken.find((item) => item.kind === "load")?.ms).toBe(1235);
    expect(vitals.takeVitals()).toEqual([]);
  });

  test("many errors in one session are one error", () => {
    vitals.noteVital("error");
    vitals.noteVital("error");
    expect(vitals.takeVitals()).toEqual([{ kind: "error" }]);
  });

  test("nothing is noted with crash reports off", async () => {
    await prefs.setPreferences({ crashReports: false });
    vitals.noteLaunch(10);
    vitals.noteVital("error");
    expect(vitals.takeVitals()).toEqual([]);
  });

  test("milliseconds only on a timing, and capped", () => {
    vitals.noteVital("session", 5);
    vitals.noteVital("load", Number.NaN);
    expect(vitals.takeVitals()).toEqual([]);
    vitals.noteVital("load", 10_000_000);
    expect(vitals.takeVitals()).toEqual([{ kind: "load", ms: 600_000 }]);
  });

  test("a session id is 16 hex, and a failed send goes back first", () => {
    expect(vitals.vitalSession()).toMatch(/^[0-9a-f]{16}$/);
    vitals.noteVital("session");
    const taken = vitals.takeVitals();
    vitals.noteVital("error");
    vitals.returnVitals(taken);
    expect(vitals.takeVitals().map((item) => item.kind)).toEqual(["session", "error"]);
  });

  test("a listener hears each new vital", () => {
    const heard = jest.fn();
    vitals.onVitals(heard);
    vitals.noteVital("session");
    vitals.noteVital("session");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
