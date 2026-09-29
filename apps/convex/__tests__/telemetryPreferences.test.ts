/**
 * TELEMETRY PREFERENCES — the Privacy & feedback switches, kept on the
 * account so turning one off holds on every device.
 *
 *  1. **Only the caller's own row.** A read or a write names no user; the
 *     caller's identity is the only key, so nobody can read or set another
 *     person's switches, and a signed-out caller gets nothing and sets
 *     nothing.
 *  2. **One row per person, whole choices only.** A write carries all three
 *     switches and replaces the last one; nothing but three booleans is
 *     accepted, so the row can never grow a field that holds more than a
 *     choice.
 *  3. **Bounded.** A loop in a client cannot churn the row without limit.
 *  4. **Leaves with the account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   read returns the first row in the table, not the caller's     1
 *   write inserts a new row every time                              2
 *   drop the rate limit                                             1
 *   drop the telemetryPreferences sweep from personalRows           1
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

const OFF = { crashReports: false, screenCounts: true, recordings: false };

describe("the caller's own switches", () => {
  test("a signed-out caller reads nothing and cannot write", async () => {
    const t = setupTest();
    expect(await t.query(api.functions.telemetry.myTelemetryPreferences, {})).toBeNull();
    await expect(t.mutation(api.functions.telemetry.setMyTelemetryPreferences, OFF)).rejects.toThrow();
  });

  test("nothing is stored until the person chooses", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    expect(await asUser(t, seyi).query(api.functions.telemetry.myTelemetryPreferences, {})).toBeNull();
  });

  test("a choice is read back, with when it was made", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const before = Date.now();
    await asUser(t, seyi).mutation(api.functions.telemetry.setMyTelemetryPreferences, OFF);
    const stored = await asUser(t, seyi).query(api.functions.telemetry.myTelemetryPreferences, {});
    expect(stored).toMatchObject(OFF);
    expect(stored!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test("another person's choice is invisible and untouched", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    await asUser(t, seyi).mutation(api.functions.telemetry.setMyTelemetryPreferences, OFF);
    expect(await asUser(t, jon).query(api.functions.telemetry.myTelemetryPreferences, {})).toBeNull();
    await asUser(t, jon).mutation(api.functions.telemetry.setMyTelemetryPreferences, {
      crashReports: true,
      screenCounts: true,
      recordings: true,
    });
    expect(await asUser(t, seyi).query(api.functions.telemetry.myTelemetryPreferences, {})).toMatchObject(OFF);
  });

  test("a new choice replaces the last, in one row", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(api.functions.telemetry.setMyTelemetryPreferences, OFF);
    await asUser(t, seyi).mutation(api.functions.telemetry.setMyTelemetryPreferences, {
      crashReports: true,
      screenCounts: false,
      recordings: false,
    });
    const rows = await t.run((ctx) => ctx.db.query("telemetryPreferences").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ crashReports: true, screenCounts: false, recordings: false });
  });
});

describe("only a choice is ever stored", () => {
  test("a partial, a non-boolean or an extra field is refused", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    const set = api.functions.telemetry.setMyTelemetryPreferences;
    await expect(as.mutation(set, { crashReports: false } as never)).rejects.toThrow();
    await expect(as.mutation(set, { ...OFF, recordings: "no" } as never)).rejects.toThrow();
    await expect(as.mutation(set, { ...OFF, note: "1-projects/secret.md" } as never)).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("telemetryPreferences").collect())).toEqual([]);
  });

  test("a client stuck in a loop is stopped", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    const set = api.functions.telemetry.setMyTelemetryPreferences;
    for (let i = 0; i < 60; i++) {
      await as.mutation(set, { ...OFF, crashReports: i % 2 === 0 });
    }
    await expect(as.mutation(set, OFF)).rejects.toThrow(/RATE_LIMITED|Too many/);
  });
});

describe("leaving", () => {
  test("the row goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(api.functions.telemetry.setMyTelemetryPreferences, OFF);
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("telemetryPreferences").collect())).toEqual([]);
  });
});
