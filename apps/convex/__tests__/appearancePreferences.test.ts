/**
 * APPEARANCE — Light, Dark or follow the device, kept on the account so the
 * choice holds on every device (Dev2, 2026-10-14).
 *
 *  1. **Only the caller's own row.** Neither function names a user, so nobody
 *     can read or set another person's choice, and a signed-out caller gets
 *     nothing and sets nothing.
 *  2. **One row per person, one word only.** Anything but the three words is
 *     refused, so the row can never grow into something that holds more.
 *  3. **Bounded.** A loop in a client cannot churn the row without limit.
 *  4. **Leaves with the account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   read returns the first row in the table, not the caller's     1
 *   write inserts a new row every time                              1
 *   drop the rate limit                                             1
 *   drop the appearancePreferences sweep from personalRows          1
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

const read = api.functions.appearance.myAppearance;
const set = api.functions.appearance.setMyAppearance;

describe("the caller's own choice", () => {
  test("a signed-out caller reads nothing and cannot write", async () => {
    const t = setupTest();
    expect(await t.query(read, {})).toBeNull();
    await expect(t.mutation(set, { appearance: "dark" })).rejects.toThrow();
  });

  test("nothing is stored until the person chooses", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    expect(await asUser(t, seyi).query(read, {})).toBeNull();
  });

  test("a choice is read back, with when it was made", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const before = Date.now();
    const at = await asUser(t, seyi).mutation(set, { appearance: "dark" });
    const stored = await asUser(t, seyi).query(read, {});
    expect(stored).toEqual({ appearance: "dark", updatedAt: at });
    expect(at).toBeGreaterThanOrEqual(before);
  });

  test("another person's choice is invisible and untouched", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    await asUser(t, seyi).mutation(set, { appearance: "dark" });
    expect(await asUser(t, jon).query(read, {})).toBeNull();
    await asUser(t, jon).mutation(set, { appearance: "light" });
    expect(await asUser(t, seyi).query(read, {})).toMatchObject({ appearance: "dark" });
  });

  test("a new choice replaces the last, in one row", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(set, { appearance: "dark" });
    await asUser(t, seyi).mutation(set, { appearance: "system" });
    const rows = await t.run((ctx) => ctx.db.query("appearancePreferences").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appearance: "system" });
  });
});

describe("only a choice is ever stored", () => {
  test("another word, a missing word or an extra field is refused", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await expect(as.mutation(set, {} as never)).rejects.toThrow();
    await expect(as.mutation(set, { appearance: "sepia" } as never)).rejects.toThrow();
    await expect(as.mutation(set, { appearance: "dark", note: "1-projects/secret.md" } as never)).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("appearancePreferences").collect())).toEqual([]);
  });

  test("a client stuck in a loop is stopped", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    for (let i = 0; i < 60; i++) {
      await as.mutation(set, { appearance: i % 2 === 0 ? "dark" : "light" });
    }
    await expect(as.mutation(set, { appearance: "dark" })).rejects.toThrow(/RATE_LIMITED|Too many/);
  });
});

describe("leaving", () => {
  test("the row goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(set, { appearance: "light" });
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("appearancePreferences").collect())).toEqual([]);
  });
});
