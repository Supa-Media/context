/**
 * SPELLING — on or off, a dictionary, and the words a person taught the
 * note editor's checker, kept on the account so they hold on every device
 * (Dev2, 2026-10-27).
 *
 *  1. **Only the caller's own row.** No function names a user, so nobody can
 *     read another person's words or change their settings, and a signed-out
 *     caller gets nothing and sets nothing.
 *  2. **Words, not text.** Only something shaped like one word is kept — no
 *     spaces, digits, markup — so the list cannot hold a sentence out of a
 *     note.
 *  3. **Bounded.** A loop in a client cannot grow the list or churn the row
 *     without limit.
 *  4. **Leaves with the account.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   read returns the first row in the table, not the caller's       1
 *   the WORD pattern accepts anything                                1
 *   learning a word already there appends it again                   1
 *   drop the rate limit                                              1
 *   drop the spellingPreferences sweep from personalRows             1
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import { asUser, createUser, setupTest } from "./fixtures.helpers";

const read = api.functions.spelling.mySpelling;
const set = api.functions.spelling.setMySpelling;
const learn = api.functions.spelling.learnSpellingWord;
const forget = api.functions.spelling.forgetSpellingWord;

describe("the caller's own settings", () => {
  test("a signed-out caller reads nothing and cannot write", async () => {
    const t = setupTest();
    expect(await t.query(read, {})).toBeNull();
    await expect(t.mutation(set, { enabled: false })).rejects.toThrow();
    await expect(t.mutation(learn, { word: "Seyi" })).rejects.toThrow();
  });

  test("nothing is stored until the person changes something", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    expect(await asUser(t, seyi).query(read, {})).toBeNull();
  });

  test("a first word starts from the defaults: on, US English", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(learn, { word: "Togather" });
    expect(await asUser(t, seyi).query(read, {})).toMatchObject({ enabled: true, language: "en-US", words: ["Togather"] });
  });

  test("switching off and changing language keep the words", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await as.mutation(learn, { word: "Fount" });
    await as.mutation(set, { enabled: false });
    await as.mutation(set, { language: "en-GB" });
    expect(await as.query(read, {})).toMatchObject({ enabled: false, language: "en-GB", words: ["Fount"] });
  });

  test("another person's words are invisible and untouched", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    await asUser(t, seyi).mutation(learn, { word: "Kayode" });
    expect(await asUser(t, jon).query(read, {})).toBeNull();
    await asUser(t, jon).mutation(learn, { word: "Tex" });
    await asUser(t, jon).mutation(forget, { word: "Kayode" });
    expect(await asUser(t, seyi).query(read, {})).toMatchObject({ words: ["Kayode"] });
    expect(await asUser(t, jon).query(read, {})).toMatchObject({ words: ["Tex"] });
  });

  test("one row per person, and a word is kept once whatever its case", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await as.mutation(learn, { word: "Libron" });
    await as.mutation(learn, { word: "libron" });
    await as.mutation(learn, { word: "manna-walk" });
    const rows = await t.run((ctx) => ctx.db.query("spellingPreferences").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.words).toEqual(["Libron", "manna-walk"]);
  });

  test("forgetting takes the word out in any case", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await as.mutation(learn, { word: "Seyi's" });
    await as.mutation(learn, { word: "Fount" });
    await as.mutation(forget, { word: "SEYI'S" });
    expect(await as.query(read, {})).toMatchObject({ words: ["Fount"] });
  });
});

describe("only words are ever stored", () => {
  test("a sentence, a path, a number, markup or an empty word is refused", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    for (const word of ["two words", "1-projects/secret.md", "42", "<b>", "", "  ", "-dash", "wo\u0000rd", "x".repeat(65)]) {
      await expect(as.mutation(learn, { word })).rejects.toThrow();
    }
    await expect(as.mutation(set, { language: "fr-FR" } as never)).rejects.toThrow();
    await expect(as.mutation(set, { enabled: true, note: "secret" } as never)).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("spellingPreferences").collect())).toEqual([]);
  });

  test("letters from any script, apostrophes and inner hyphens are words", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    for (const word of ["Ọlọ́run", "don't", "co-op", "Zoë"]) await as.mutation(learn, { word });
    expect((await as.query(read, {}))?.words).toHaveLength(4);
  });

  test("a client stuck in a loop is stopped", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    for (let i = 0; i < 600; i++) await as.mutation(set, { enabled: i % 2 === 0 });
    await expect(as.mutation(learn, { word: "Tex" })).rejects.toThrow(/RATE_LIMITED|Too many/);
  });
});

describe("leaving", () => {
  test("the row goes with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(learn, { word: "Seyi" });
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("spellingPreferences").collect())).toEqual([]);
  });
});
