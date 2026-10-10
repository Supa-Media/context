import { describe, expect, test } from "@jest/globals";
import {
  MAX_FIELDS,
  anyValue,
  applyDotenv,
  buildDotenv,
  dotenvCount,
  dotenvKey,
  dotenvValue,
  emptyField,
  fieldProblems,
  initialFields,
  isBlankRow,
  parseDotenv,
  submitFields,
  type FieldDraft,
  type RevealedField,
} from "../features/vault/vaultFields";

/**
 * The vault page's field rules, `.env` reading and `.env` writing. The
 * backend (`apps/mcp/src/vault/fields.js`) decides what saves; these prove the
 * page agrees with it and that what it copies out reads back the same.
 */

function row(name: string, perEnv: boolean, values: Partial<FieldDraft["values"]> = {}, id = name || "blank"): FieldDraft {
  const field = emptyField(perEnv, name, id);
  return { ...field, values: { ...field.values, ...values } };
}

describe("the rows a form starts with", () => {
  test("the agent's names, deduplicated, or one blank row for a secret", () => {
    const rows = initialFields(["STRIPE_KEY", "stripe_key", "bad/name", "WEBHOOK"], true, true);
    expect(rows.map((field) => [field.name, field.perEnv])).toEqual([
      ["STRIPE_KEY", true],
      ["WEBHOOK", true],
    ]);
    expect(initialFields([], true, true)).toHaveLength(1);
    expect(initialFields([], false, false)).toEqual([]);
  });

  test("row ids are unique and never carry a name", () => {
    const rows = initialFields(["A", "B"], false, false);
    expect(new Set(rows.map((field) => field.id)).size).toBe(2);
    expect(rows.every((field) => !field.id.includes(field.name))).toBe(true);
  });
});

describe("what the form checks before Save", () => {
  test("a blank row is ignored, not an error", () => {
    const blank = row("", true);
    expect(isBlankRow(blank)).toBe(true);
    expect(fieldProblems([blank]).any).toBe(false);
    expect(submitFields([blank])).toEqual([]);
  });

  test("a value with no name, a bad name and a repeat ignoring case are named beside the row", () => {
    const problems = fieldProblems([
      row("", false, { _: "x" }, "a"),
      row("api/key", false, {}, "b"),
      row("TOKEN", false, {}, "c"),
      row("token", true, {}, "d"),
    ]);
    expect(problems.names).toEqual({
      a: "Give this field a name.",
      b: "Use letters, digits, spaces, dots, dashes or underscores.",
      d: "TOKEN is already a field.",
    });
    expect(problems.any).toBe(true);
  });

  test("a value over the limit is caught in its own column", () => {
    const long = "x".repeat(8193);
    const problems = fieldProblems([row("KEY", true, { prod: long }, "k")]);
    expect(problems.values).toEqual({ k: { prod: "Keep it under 8,192 characters." } });
    expect(fieldProblems([row("KEY", true, { prod: "x".repeat(8192) }, "k")]).any).toBe(false);
  });

  test("a hidden column's text is neither checked nor saved", () => {
    // Typed per environment, then switched to one value: the env columns stay
    // in the form (so switching back loses nothing) but are not sent.
    const field = row("KEY", false, { dev: "x".repeat(9000), _: "one" }, "k");
    expect(fieldProblems([field]).any).toBe(false);
    expect(submitFields([field])).toEqual([{ name: "KEY", perEnv: false, values: { _: "one" } }]);
  });
});

describe("what Save sends", () => {
  test("names trimmed, blank values left out, in the backend's shape", () => {
    expect(
      submitFields([
        row(" STRIPE_KEY ", true, { dev: "sk_test_fake_dev", prod: "sk_test_fake_prod" }),
        row("Account id", false, { _: "acct_fake" }),
        row("EMPTY", true),
      ]),
    ).toEqual([
      { name: "STRIPE_KEY", perEnv: true, values: { dev: "sk_test_fake_dev", prod: "sk_test_fake_prod" } },
      { name: "Account id", perEnv: false, values: { _: "acct_fake" } },
      { name: "EMPTY", perEnv: true, values: {} },
    ]);
  });

  test("a secret needs one value somewhere", () => {
    expect(anyValue([row("A", true), row("", false)])).toBe(false);
    expect(anyValue([row("A", true, { staging: "v" })])).toBe(true);
  });
});

describe("reading a pasted .env", () => {
  test("KEY=value lines, export, comments, quotes and blank lines", () => {
    const text = [
      "# Stripe",
      "",
      "STRIPE_KEY=sk_test_fake_123",
      "export WEBHOOK_SECRET=whsec_fake # the dashboard one",
      "SINGLE='literal $HOME \\n'",
      'DOUBLE="line one\\nsays \\"hi\\""',
      "SPACED = padded value ",
      "HASH=abc#def",
      "EMPTY=",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      entries: [
        { name: "STRIPE_KEY", value: "sk_test_fake_123" },
        { name: "WEBHOOK_SECRET", value: "whsec_fake" },
        { name: "SINGLE", value: "literal $HOME \\n" },
        { name: "DOUBLE", value: 'line one\nsays "hi"' },
        { name: "SPACED", value: "padded value" },
        { name: "HASH", value: "abc#def" },
        { name: "EMPTY", value: "" },
      ],
      skipped: 0,
    });
  });

  test("a double-quoted value may run over lines; CRLF and a BOM are fine", () => {
    const text = '﻿KEY="-----BEGIN FAKE-----\r\nAAAA\r\n-----END FAKE-----"\r\nNEXT=1';
    expect(parseDotenv(text).entries).toEqual([
      { name: "KEY", value: "-----BEGIN FAKE-----\nAAAA\n-----END FAKE-----" },
      { name: "NEXT", value: "1" },
    ]);
  });

  test("lines that are not KEY=value are counted, not guessed; a repeat keeps its last value", () => {
    expect(parseDotenv("just words\n=nokey\n1BAD=x\nA=1\nA=2")).toEqual({
      entries: [{ name: "A", value: "2" }],
      skipped: 3,
    });
  });
});

describe("filling one environment from a .env", () => {
  test("a name on the form takes the value in that column; a new one becomes a per-environment row", () => {
    const form = [row("stripe_key", true, { dev: "old" }, "s"), row("PIN", false, {}, "p"), row("", true, {}, "blank")];
    const { drafts, filled, dropped } = applyDotenv(
      form,
      [
        { name: "STRIPE_KEY", value: "sk_test_fake_prod" },
        { name: "PIN", value: "1234" },
        { name: "NEW_ONE", value: "n" },
      ],
      "prod",
    );
    expect([filled, dropped]).toEqual([3, 0]);
    expect(drafts.map((field) => [field.name, field.perEnv, field.values])).toEqual([
      ["stripe_key", true, { _: "", dev: "old", staging: "", prod: "sk_test_fake_prod" }],
      ["PIN", false, { _: "1234", dev: "", staging: "", prod: "" }],
      ["NEW_ONE", true, { _: "", dev: "", staging: "", prod: "n" }],
    ]);
    // The form it was given is untouched.
    expect(form[0]!.values.prod).toBe("");
  });

  test("past the field limit, new names are left out and counted", () => {
    const full = Array.from({ length: MAX_FIELDS }, (_, i) => row(`K${i}`, true));
    const { drafts, dropped } = applyDotenv(full, [{ name: "EXTRA", value: "x" }, { name: "K1", value: "y" }], "dev");
    expect(drafts).toHaveLength(MAX_FIELDS);
    expect(dropped).toBe(1);
    expect(drafts[1]!.values.dev).toBe("y");
  });

  test("nothing usable leaves the form as it was", () => {
    const form = [row("", true, {}, "blank")];
    expect(applyDotenv(form, [], "dev")).toEqual({ drafts: form, filled: 0, dropped: 0 });
  });
});

describe("writing one environment as .env", () => {
  test("keys already env-safe are kept; others become UPPER_SNAKE", () => {
    expect(dotenvKey("STRIPE_KEY")).toBe("STRIPE_KEY");
    expect(dotenvKey("stripe_key")).toBe("stripe_key");
    expect(dotenvKey("Account number")).toBe("ACCOUNT_NUMBER");
    expect(dotenvKey("api-key.v2")).toBe("API_KEY_V2");
    expect(dotenvKey("webhookSecret v2")).toBe("WEBHOOK_SECRET_V2");
    expect(dotenvKey("2fa code")).toBe("_2FA_CODE");
    expect(dotenvKey("...")).toBe("FIELD");
  });

  test("values are quoted only when they need it", () => {
    expect(dotenvValue("sk_test_fake_123")).toBe("sk_test_fake_123");
    expect(dotenvValue("https://x.test/a?b=c")).toBe("'https://x.test/a?b=c'");
    expect(dotenvValue("has space")).toBe("'has space'");
    expect(dotenvValue("$HOME#x")).toBe("'$HOME#x'");
    expect(dotenvValue("it's")).toBe(`"it's"`);
    expect(dotenvValue('a\nb "c" \\ $d')).toBe('"a\\nb \\"c\\" \\\\ \\$d"');
    expect(dotenvValue("")).toBe("");
  });

  const fields: RevealedField[] = [
    { name: "STRIPE_KEY", perEnv: true, values: { dev: "sk_test_fake_dev", prod: "sk_test_fake prod" } },
    { name: "Account id", perEnv: false, values: { _: "acct_fake" } },
    { name: "account-id", perEnv: true, values: { prod: "clash" } },
    { name: "PRIVATE", perEnv: true, values: { prod: "-----BEGIN-----\nAA\n-----END-----" } },
  ];

  test("one environment's values and every single value, under a comment naming them", () => {
    expect(buildDotenv("Stripe", fields, "dev")).toBe("# Stripe (dev)\nSTRIPE_KEY=sk_test_fake_dev\nACCOUNT_ID=acct_fake\n");
    expect(dotenvCount(fields, "staging")).toBe(1);
  });

  test("two names that collapse to one key are numbered, never one silently lost", () => {
    expect(buildDotenv("Stripe", fields, "prod").split("\n")).toEqual([
      "# Stripe (prod)",
      "STRIPE_KEY='sk_test_fake prod'",
      "ACCOUNT_ID=acct_fake",
      "ACCOUNT_ID_2=clash",
      'PRIVATE="-----BEGIN-----\\nAA\\n-----END-----"',
      "",
    ]);
  });

  test("what it writes reads back to the same values", () => {
    const text = buildDotenv("Stripe", fields, "prod");
    expect(parseDotenv(text).entries).toEqual([
      { name: "STRIPE_KEY", value: "sk_test_fake prod" },
      { name: "ACCOUNT_ID", value: "acct_fake" },
      { name: "ACCOUNT_ID_2", value: "clash" },
      { name: "PRIVATE", value: "-----BEGIN-----\nAA\n-----END-----" },
    ]);
    const tricky: RevealedField[] = [{ name: "T", perEnv: false, values: { _: `q"u'o\\te $x\nnext` } }];
    expect(parseDotenv(buildDotenv("T", tricky, "dev")).entries).toEqual([{ name: "T", value: `q"u'o\\te $x\nnext` }]);
  });

  test("an entry with no per-environment field names no environment; a newline in a name can't add a line", () => {
    const single: RevealedField[] = [{ name: "KEY", perEnv: false, values: { _: "v" } }];
    expect(buildDotenv("Two\nLines", single, "prod")).toBe("# Two Lines\nKEY=v\n");
  });
});
