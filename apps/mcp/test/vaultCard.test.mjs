/**
 * Cards in the vault (`src/vault/card.js`): what a person types is checked
 * and kept as fixed fields, and what anyone is shown of a card is its brand,
 * last four digits and expiry, never its number or security code.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `luhn` always true → "a number that fails its check digit is refused".
 *  2. The expiry check dropped → "an expired card is refused".
 *  3. `cardSummary` keeping the number → "a card's summary never holds its number".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_FIELDS, cardLabel, cardSummary, normalizeCard } from "../src/vault/card.js";
import { entryType, fieldSummaries, fieldValue } from "../src/vault/fields.js";

// The card networks' published test numbers: never a real card.
const VISA = "4242 4242 4242 4242";
const AMEX = "3782-822463-10005";
const NOW = Date.UTC(2026, 9, 21);

const card = (extra = {}) => ({ number: VISA, expMonth: "8", expYear: "29", cvc: "123", name: "Ada Lovelace", postalCode: "94110", ...extra });

test("a card is kept as its fixed fields, digits only", () => {
  const { fields, summary, error } = normalizeCard(card(), NOW);
  assert.equal(error, null);
  assert.deepEqual(
    fields.map((field) => field.name),
    CARD_FIELDS.filter((name) => name !== "exp"),
  );
  const secret = { fields };
  assert.equal(fieldValue(secret, "number"), "4242424242424242");
  assert.equal(fieldValue(secret, "exp_month"), "08");
  assert.equal(fieldValue(secret, "exp_year"), "2029");
  assert.equal(fieldValue(secret, "cvc"), "123");
  assert.deepEqual(summary, { brand: "visa", last4: "4242", expMonth: "08", expYear: "2029" });
  assert.equal(entryType({ type: "card" }), "card");
});

test("name and ZIP are optional, and an Amex takes a four-digit code", () => {
  const { fields, summary, error } = normalizeCard({ number: AMEX, expMonth: "12", expYear: "2030", cvc: "1234" }, NOW);
  assert.equal(error, null);
  assert.equal(summary.brand, "amex");
  assert.deepEqual(fields.map((field) => field.name), ["number", "exp_month", "exp_year", "cvc"]);
  assert.match(normalizeCard({ ...card(), cvc: "1234" }, NOW).error ?? "", /security code/);
});

test("a number that fails its check digit is refused", () => {
  assert.match(normalizeCard(card({ number: "4242 4242 4242 4241" }), NOW).error ?? "", /card number/);
  assert.match(normalizeCard(card({ number: "4242" }), NOW).error ?? "", /card number/);
  assert.match(normalizeCard(card({ number: "4242abcd42424242" }), NOW).error ?? "", /card number/);
});

test("an expired card is refused, and this month still counts", () => {
  assert.match(normalizeCard(card({ expMonth: "9", expYear: "2026" }), NOW).error ?? "", /expired/);
  assert.equal(normalizeCard(card({ expMonth: "10", expYear: "2026" }), NOW).error, null);
  assert.match(normalizeCard(card({ expMonth: "13" }), NOW).error ?? "", /month/);
  assert.match(normalizeCard(card({ expYear: "2101" }), NOW).error ?? "", /year/);
});

test("a card's summary never holds its number or code, and its label is what an AI is told", () => {
  const { fields, summary } = normalizeCard(card(), NOW);
  const shown = JSON.stringify({ summary, fields: fieldSummaries(fields) });
  assert.ok(!shown.includes("4242424242424242"));
  assert.ok(!shown.includes("123\""));
  assert.equal(cardSummary({ number: "4242424242424242", exp_month: "08", exp_year: "2029" }).last4, "4242");
  assert.equal(cardLabel({ type: "card", card: summary }), "Visa ••4242, expires 08/29");
  assert.equal(cardLabel({ type: "card" }), "card");
});
