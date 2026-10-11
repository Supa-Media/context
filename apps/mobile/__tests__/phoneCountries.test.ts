import { describe, expect, test } from "@jest/globals";
import {
  PHONE_COUNTRIES,
  composePhone,
  countryByIso,
  countryOfNumber,
  flagOf,
  searchCountries,
  splitPhone,
} from "../features/auth/phoneCountries";

/**
 * The phone field's country list (Dev2, 2026-10-09): nobody types a country
 * code, the United States is picked unless changed, and every other country
 * is one search away. These are the rules that turn what was typed into the
 * `+<code><number>` Twilio takes.
 */
describe("phone countries", () => {
  test("the United States is first and the default", () => {
    expect(searchCountries("")[0]?.iso).toBe("US");
    expect(countryByIso("nowhere").iso).toBe("US");
    expect(PHONE_COUNTRIES.length).toBeGreaterThan(200);
    expect(new Set(PHONE_COUNTRIES.map((c) => c.iso)).size).toBe(PHONE_COUNTRIES.length);
    for (const c of PHONE_COUNTRIES) expect(c.dial).toMatch(/^[1-9]\d{0,3}$/);
  });

  test("a typed number gets the picked country's code, punctuation dropped", () => {
    expect(composePhone(countryByIso("US"), "(202) 615-0407")).toBe("+12026150407");
    expect(composePhone(countryByIso("NG"), "0803 123 4567")).toBe("+2348031234567");
    expect(composePhone(countryByIso("GB"), "07700 900123")).toBe("+447700900123");
    // Italy keeps its leading 0.
    expect(composePhone(countryByIso("IT"), "06 1234 5678")).toBe("+390612345678");
    expect(composePhone(countryByIso("US"), "  ")).toBe("");
  });

  test("North American countries share +1 and keep their area code in the number", () => {
    expect(countryByIso("JM").dial).toBe("1");
    expect(composePhone(countryByIso("JM"), "876 555 0100")).toBe("+18765550100");
  });

  test("a number typed with its own + wins over the picked country", () => {
    expect(composePhone(countryByIso("US"), "+44 7700 900123")).toBe("+447700900123");
    expect(countryOfNumber("+44 7700 900123")?.iso).toBe("GB");
    expect(countryOfNumber("+1 202 615 0407")?.iso).toBe("US");
    expect(countryOfNumber("+234 803")?.iso).toBe("NG");
    expect(countryOfNumber("202")).toBeNull();
  });

  test("a stored number splits back into its country and the rest", () => {
    expect(splitPhone("+447700900123")).toMatchObject({ country: { iso: "GB" }, national: "7700900123" });
    expect(splitPhone("")).toMatchObject({ country: { iso: "US" }, national: "" });
  });

  test("search finds by name, any word of it, or code", () => {
    expect(searchCountries("king").map((c) => c.iso)).toContain("GB");
    expect(searchCountries("nig").map((c) => c.iso)).toEqual(expect.arrayContaining(["NG", "NE"]));
    expect(searchCountries("+234").map((c) => c.iso)).toEqual(["NG"]);
    expect(searchCountries("zzz")).toEqual([]);
  });

  test("flags are drawn from the ISO code", () => {
    expect(flagOf("US")).toBe("🇺🇸");
  });
});
