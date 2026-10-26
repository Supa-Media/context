/**
 * Sabotage record (2026-10-26): `lead`'s pattern written with one backslash,
 * as it was in `browse.ts` before, so the page's script saw /^d+/ and no
 * numbered option ever matched (the Vamoose month menu) → the first four tests
 * fail. Checked in real Chromium too: an "8 - Aug" menu picked 8.
 */
import { describe, expect, test } from "vitest";
import { pickExpirySource } from "./cardMenus";

/** A `<select>` as the page's script sees it: options with a value and words, and the events a pick fires. */
function menu(options: Array<[string, string]>) {
  const fired: string[] = [];
  const el = {
    tagName: "SELECT",
    value: "",
    options: options.map(([value, words]) => ({ value, innerText: words, textContent: words, disabled: false })),
    dispatchEvent: (event: { type: string }) => fired.push(event.type),
  };
  return { el, fired };
}

/** Run the source the way the browser does: a string, in a page with this one menu. */
function pick(el: object, value: string, field: "cc-exp-month" | "cc-exp-year" | "cc-exp"): boolean {
  const run = new Function("document", "Event", `return ${pickExpirySource(7, value, field)};`);
  return run({ querySelector: () => el }, class { constructor(public type: string) {} });
}

const MONTHS_PADDED: Array<[string, string]> = [["", "MM"], ...Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, "0"), String(i + 1).padStart(2, "0")] as [string, string])];
const MONTHS_NAMED: Array<[string, string]> = [["", "Month"], ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((name, i) => [`m${i}`, `${i + 1} - ${name}`] as [string, string])];
const WORDS_ONLY: Array<[string, string]> = [["", "Month"], ...["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((name, i) => [`x${i}`, name] as [string, string])];
const YEARS: Array<[string, string]> = [["", "YYYY"], ...Array.from({ length: 10 }, (_, i) => [String(2026 + i), String(2026 + i)] as [string, string])];
const SHORT_YEARS: Array<[string, string]> = [["", "YY"], ...Array.from({ length: 10 }, (_, i) => [String(26 + i), String(26 + i)] as [string, string])];

// The owner's review, 2026-10-26: Vamoose's "MM" menu of "08"-style months refused the card, and the person was asked for a second 👍.
describe("card expiry menus (./cardMenus.ts)", () => {
  test("a month menu of 08-style values takes the card's month", () => {
    const { el, fired } = menu(MONTHS_PADDED);
    expect(pick(el, "08", "cc-exp-month")).toBe(true);
    expect(el.value).toBe("08");
    expect(fired).toEqual(["input", "change"]);
  });

  test("8 - Aug, and month names alone, are the eighth month", () => {
    const named = menu(MONTHS_NAMED);
    expect(pick(named.el, "08", "cc-exp-month")).toBe(true);
    expect(named.el.value).toBe("m7");
    const words = menu(WORDS_ONLY);
    expect(pick(words.el, "08", "cc-exp-month")).toBe(true);
    expect(words.el.value).toBe("x7");
  });

  test("a year menu takes 2028 or 28", () => {
    const long = menu(YEARS);
    expect(pick(long.el, "2028", "cc-exp-year")).toBe(true);
    expect(long.el.value).toBe("2028");
    const short = menu(SHORT_YEARS);
    expect(pick(short.el, "2028", "cc-exp-year")).toBe(true);
    expect(short.el.value).toBe("28");
  });

  test("a one-box expiry aimed at a menu picks its month or its year", () => {
    const month = menu(MONTHS_PADDED);
    expect(pick(month.el, "08/28", "cc-exp")).toBe(true);
    expect(month.el.value).toBe("08");
    const year = menu(YEARS);
    expect(pick(year.el, "08/28", "cc-exp")).toBe(true);
    expect(year.el.value).toBe("2028");
  });

  test("a menu with no such option picks nothing", () => {
    const { el, fired } = menu([["", "MM"], ["01", "01"], ["02", "02"]]);
    expect(pick(el, "08", "cc-exp-month")).toBe(false);
    expect(el.value).toBe("");
    expect(fired).toEqual([]);
    // August is never December's "8"-less neighbour, nor the 18th of anything.
    const days = menu([["", "Day"], ["18", "18"], ["28", "28"]]);
    expect(pick(days.el, "08", "cc-exp-month")).toBe(false);
  });
});
