/**
 * THE EARLY-BETA NOTICE — "Got it" is remembered on the account, so the
 * notice is dismissed once per person, not once per browser or phone.
 *
 * It was once per device, which meant a second browser, the desktop app, a
 * phone or cleared site data showed it again (Dev2, 2026-09-29: "ive had to
 * dismiss this twice").
 *
 *  1. **Only the caller's own mark.** Neither function names a user; a
 *     signed-out caller reads nothing and marks nothing.
 *  2. **Once is once.** Marking again keeps one row and the first time.
 *  3. **Leaves with the account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   read answers seen for anyone once somebody has seen it          1
 *   mark inserts a new row every time                               1
 *   drop the betaNoticeReads sweep from personalRows                1
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

const seen = api.functions.telemetry.betaNoticeSeen;
const mark = api.functions.telemetry.markBetaNoticeSeen;

describe("the early-beta notice", () => {
  test("unseen until the person says Got it, then seen on every device", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const phone = asUser(t, seyi);
    const browser = asUser(t, seyi);
    expect(await phone.query(seen, {})).toBe(false);
    await phone.mutation(mark, {});
    expect(await browser.query(seen, {})).toBe(true);
  });

  test("one person's Got it is not another's", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    await asUser(t, seyi).mutation(mark, {});
    expect(await asUser(t, jon).query(seen, {})).toBe(false);
  });

  test("signed out: nothing to read and nothing to mark", async () => {
    const t = setupTest();
    expect(await t.query(seen, {})).toBeNull();
    await expect(t.mutation(mark, {})).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("betaNoticeReads").collect())).toEqual([]);
  });

  test("marking twice keeps one row and the first time", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await as.mutation(mark, {});
    const first = await t.run((ctx) => ctx.db.query("betaNoticeReads").collect());
    await as.mutation(mark, {});
    const rows = await t.run((ctx) => ctx.db.query("betaNoticeReads").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenAt).toBe(first[0]!.seenAt);
  });

  test("the mark goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(mark, {});
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("betaNoticeReads").collect())).toEqual([]);
  });
});
