import { describe, expect, test } from "@jest/globals";
import path from "node:path";

/**
 * GHSA-vcc3-ghjq-m6fr: decode-uri-component <= 0.4.x does exponential and
 * quadratic work on malformed percent-encoded input. It ships in the web app:
 * expo-router 6 pins query-string 7, whose `parse` (called by
 * @react-navigation/core's `getStateFromPath` on every link) decodes each query
 * value with it. The fixed releases (0.5.x) are ESM-only, which query-string 7
 * can't `require`, so `patches/decode-uri-component@0.2.2.patch` backports
 * 0.5.1's linear decoder into the CommonJS 0.2.2 and keeps 0.2.2's API: the
 * same export, `+` decoded to a space, native `decodeURIComponent` first, a
 * TypeError for a non-string, and never a throw for a string.
 *
 * Everything here resolves the modules the way the app does, from expo-router,
 * so the test fails if the patch stops applying to the copy that ships.
 */
const expoRouter = path.dirname(require.resolve("expo-router/package.json"));
const queryStringPath = require.resolve("query-string", { paths: [expoRouter] });
const decode: (input: string) => string = require(
  require.resolve("decode-uri-component", { paths: [path.dirname(queryStringPath)] }),
);
const queryString: { parse: (query: string) => Record<string, unknown> } = require(queryStringPath);

function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

// The three shapes that blow up the old decoder (measured on 0.2.2: 3.6 KB of
// truncated triples took 32 s, 1.2 KB of one malformed run 3.3 s, 56 KB of
// distinct runs 0.8 s). The patched decoder takes well under a millisecond on
// each. The bound is generous so a slow CI runner cannot flake it, and far
// below what the old decoder needs.
const adversarial: Array<[string, string]> = [
  ["truncated three-byte sequences", "%E2%82%41".repeat(400) + "%"],
  ["one long malformed run", "%C3".repeat(400) + "%zz"],
  [
    "many distinct malformed runs",
    Array.from({ length: 8000 }, (_, i) => {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `%${hex(Math.floor(i / 256))}%${hex(i % 256)}x`;
    }).join("") + "%zz",
  ],
];

describe("decoding a hostile query value takes bounded time", () => {
  test.each(adversarial)("%s", (_name, input) => {
    expect(timed(() => decode(input))).toBeLessThan(250);
  });

  test("through query-string.parse, as a link is parsed", () => {
    const [, value] = adversarial[0];
    let parsed: Record<string, unknown> = {};
    expect(timed(() => (parsed = queryString.parse(`q=${value}&next=%2Fconsole`)))).toBeLessThan(250);
    expect(parsed.next).toBe("/console");
  });

  test("work grows linearly with the input", () => {
    const input = (n: number) => "%E2%82%41".repeat(n) + "%";
    decode(input(2000)); // warm up
    const small = timed(() => decode(input(2000)));
    const large = timed(() => decode(input(16000)));
    // 8x the input: linear is about 8x; the old decoder's growth was cubic.
    expect(large).toBeLessThan(Math.max(small, 1) * 40);
  });
});

describe("decoding results", () => {
  test("well-formed input is exactly the native decoder", () => {
    for (const input of ["", "st%C3%A5le", "%F0%9F%98%80", "%2525", "%2F%3F%23", "a%20b"]) {
      expect(decode(input)).toBe(decodeURIComponent(input));
    }
  });

  test("a plus is a space, as it was in 0.2.2", () => {
    expect(decode("a+b")).toBe("a b");
    expect(decode("%61+%4d%4D")).toBe("a MM");
    expect(queryString.parse("q=a+b%20c")).toEqual({ q: "a b c" });
  });

  // From upstream's own test suite (decode-uri-component 0.5.1 test.js).
  test.each([
    ["%", "%"],
    ["%%25%%", "%%%%"],
    ["st%C3%A5le%", "ståle%"],
    ["%%7Bst%C3%A5le%7D%", "%{ståle}%"],
    ["%7B%ab%%7C%de%%7D", "{%ab%|%de%}"],
    ["%ab%ab%ab", "%ab%ab%ab"],
    ["%FE%FF", "��"],
    ["%C2", "�"],
    ["%C2x", "�x"],
    ["%C3%5A%A5%AB", "%C3Z%A5%AB"],
    ["%F0%9F%98%80%ab", "😀%ab"],
    ["%ED%A0%80", "%ED%A0%80"],
    ["%u0041", "%u0041"],
    ["a%FE%FFb", "a��b"],
  ])("malformed %j decodes to %j", (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  // Where 0.2.2 was wrong, the fix follows upstream: decoded output is never
  // decoded again, so the `%` a `%25` produces stays a `%`.
  test.each([
    ["%25C2%zz", "%C2%zz"],
    ["%84%D7%25%88%90", "%84%D7%%88%90"],
    ["%20%20%25%80", "  %%80"],
  ])("decoded output is not decoded again: %j", (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  test("a non-string is still a TypeError, and a string never throws", () => {
    expect(() => decode(undefined as unknown as string)).toThrow(
      "Expected `encodedURI` to be of type `string`, got `undefined`",
    );
    for (const input of ["%", "%zz", "%C2%", "%E0%80%80", "%%%"]) {
      expect(() => decode(input)).not.toThrow();
    }
  });
});
