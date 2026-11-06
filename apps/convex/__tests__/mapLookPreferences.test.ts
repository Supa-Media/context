/**
 * THE MAP'S LOOK — one row per person, the choice follows them across devices.
 *
 *  1. **Only the caller's own row.** Neither function names a user, so nobody
 *     can read or set another person's look.
 *  2. **Only the look.** Unknown fields and out-of-range numbers are refused.
 *  3. **Bounded.** A loop in a client cannot churn the row without limit.
 *  4. **Leaves with the account.**
 */

import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import { asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

const read = api.functions.mapLook.myMapLook;
const set = api.functions.mapLook.setMyMapLook;

describe("the caller's own look", () => {
  test("a signed-out caller reads nothing and cannot write", async () => {
    const t = setupTest();
    expect(await t.query(read, {})).toBeNull();
    await expect(t.mutation(set, { look: { board: "chalk" } })).rejects.toThrow();
  });

  test("a look is read back, with when it was made", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const before = Date.now();
    const at = await asUser(t, seyi).mutation(set, { look: { board: "chalk", sketch: 0.4, names: "all" } });
    expect(await asUser(t, seyi).query(read, {})).toEqual({
      look: { board: "chalk", sketch: 0.4, names: "all" },
      updatedAt: at,
    });
    expect(at).toBeGreaterThanOrEqual(before);
  });

  test("another person's look is invisible and untouched", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    await asUser(t, seyi).mutation(set, { look: { board: "chalk" } });
    expect(await asUser(t, jon).query(read, {})).toBeNull();
    await asUser(t, jon).mutation(set, { look: { board: "graph" } });
    expect(await asUser(t, seyi).query(read, {})).toMatchObject({ look: { board: "chalk" } });
  });

  test("a new look replaces the last, whole, in one row", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(set, { look: { board: "chalk", depth: true, motion: "still" } });
    await asUser(t, seyi).mutation(set, { look: { board: "paper" } });
    const rows = await t.run((ctx) => ctx.db.query("mapLookPreferences").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ look: { board: "paper" } });
    expect(rows[0].look).not.toHaveProperty("depth");
    expect(rows[0].look).not.toHaveProperty("motion");
  });
});

describe("only a look is ever stored", () => {
  test("an unknown choice, an unknown field or a stray note is refused", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await expect(as.mutation(set, { look: { board: "sepia" } } as never)).rejects.toThrow();
    await expect(as.mutation(set, { look: { colorBy: "tag" } } as never)).rejects.toThrow();
    await expect(
      as.mutation(set, { look: { board: "paper", note: "1-projects/secret.md" } } as never),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("mapLookPreferences").collect())).toEqual([]);
  });

  test("numbers outside their range, or not finite, are refused", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    const refused = [
      { sketch: 1.5 },
      { sketch: -0.1 },
      { textSize: 7 },
      { textSize: 25 },
      { lineWidth: 0.1 },
      { lineWidth: 4.5 },
      { dotSize: 0.2 },
      { dotSize: 3.5 },
      { spread: 0.3 },
      { spread: 2.6 },
      { spread: NaN },
      { dotSize: Infinity },
    ];
    for (const look of refused) {
      await expect(as.mutation(set, { look })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("mapLookPreferences").collect())).toEqual([]);
  });

  test("numbers at the edges of their range are accepted", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(set, {
      look: { sketch: 0, textSize: 8, lineWidth: 0.2, dotSize: 0.3, spread: 0.4 },
    });
    await asUser(t, seyi).mutation(set, {
      look: { sketch: 1, textSize: 24, lineWidth: 4, dotSize: 3, spread: 2.5 },
    });
    expect(await asUser(t, seyi).query(read, {})).toMatchObject({ look: { spread: 2.5 } });
  });

  test("a client stuck in a loop is stopped", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    for (let i = 0; i < 120; i++) {
      await as.mutation(set, { look: { sketch: i % 2 === 0 ? 0.2 : 0.8 } });
    }
    await expect(as.mutation(set, { look: { sketch: 0.5 } })).rejects.toThrow(/RATE_LIMITED|Too many/);
  });
});

describe("leaving", () => {
  test("the row goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(set, { look: { board: "kraft" } });
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("mapLookPreferences").collect())).toEqual([]);
  });
});

describe("the owner reading one person's look by username", () => {
  test("a username is the person's personal workspace slug, and it reads their look alone", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await createWorkspace(t, seyi, "seyi");
    const at = await asUser(t, seyi).mutation(set, { look: { board: "graph", dotSize: 1.2 } });
    const byName = internal.functions.mapLook.lookOfUsername;
    expect(await t.query(byName, { username: "@Seyi" })).toEqual({ found: "look", look: { board: "graph", dotSize: 1.2 }, updatedAt: at });
  });

  test("an unknown name, a shared workspace's slug and a person with no look each say which", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await createWorkspace(t, seyi, "seyi");
    await createWorkspace(t, seyi, "team-notes", { kind: "shared" });
    await asUser(t, seyi).mutation(set, { look: { board: "graph" } });
    const ada = await createUser(t, "ada@example.invalid");
    await createWorkspace(t, ada, "ada");
    const byName = internal.functions.mapLook.lookOfUsername;
    expect(await t.query(byName, { username: "nobody" })).toEqual({ found: "no such name" });
    expect(await t.query(byName, { username: "team-notes" })).toEqual({ found: "not a person" });
    expect(await t.query(byName, { username: "ada" })).toEqual({ found: "no look saved" });
  });

});
