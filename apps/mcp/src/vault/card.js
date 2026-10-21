/**
 * Cards in the vault (the owner, 2026-10-21: "add cards to the vault").
 *
 * A card is an entry of type `card` whose values are fixed fields (below),
 * sealed in the secret part like any other field, so sharing, moving,
 * revealing and the fill step's one door (`fill.js`) treat it like any other
 * entry. Its meta carries `card`, a summary of brand, last four digits and
 * expiry: what an AI and a list are told ("Visa ••4242, expires 08/29"),
 * never the number or the security code.
 *
 * Shared by the gateway, which fills a card at checkout
 * (`agent/fillCard.js`), and the control plane, which saves one
 * (`apps/convex/functions/vault.ts`).
 */

/** A card's fields, in the order a checkout asks for them. `exp` is never stored: it is made from the month and year. */
export const CARD_FIELDS = Object.freeze(["number", "exp_month", "exp_year", "cvc", "name", "postal_code"]);
/** The parts a checkout box can be: the stored fields, and `exp` for one MM/YY box. */
export const CARD_PARTS = Object.freeze(["number", "exp", "exp_month", "exp_year", "cvc", "name", "postal_code"]);

const MAX_NAME = 100;
const MAX_POSTAL = 16;

const BRANDS = [
  { brand: "amex", pattern: /^3[47]/, lengths: [15], cvc: 4 },
  { brand: "visa", pattern: /^4/, lengths: [13, 16, 19], cvc: 3 },
  { brand: "mastercard", pattern: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16], cvc: 3 },
  { brand: "discover", pattern: /^(6011|65|64[4-9])/, lengths: [16, 19], cvc: 3 },
];
const BRAND_NAMES = { amex: "Amex", visa: "Visa", mastercard: "Mastercard", discover: "Discover", card: "Card" };

/** Whether a string of digits passes the Luhn check every card number carries. */
export function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function brandOf(digits) {
  return BRANDS.find((entry) => entry.pattern.test(digits)) ?? null;
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/**
 * Check a card a person typed: `{number, expMonth, expYear, cvc, name?,
 * postalCode?}`. Returns `{fields, summary, error}`: fields as `normalizeFields`
 * gives them, ready to seal, and the summary for meta.
 */
export function normalizeCard(input, now = Date.now()) {
  const refuse = (error) => ({ fields: [], summary: null, error });
  const raw = text(input?.number).replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(raw) || !luhn(raw)) return refuse("check the card number");
  const known = brandOf(raw);
  if (known !== null && !known.lengths.includes(raw.length)) return refuse("check the card number");
  const month = Number(text(input?.expMonth));
  if (!Number.isInteger(month) || month < 1 || month > 12) return refuse("check the expiry month");
  const yearText = text(input?.expYear);
  if (!/^\d{2}$|^\d{4}$/.test(yearText)) return refuse("check the expiry year");
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  if (year > 2100) return refuse("check the expiry year");
  const today = new Date(now);
  if (year < today.getUTCFullYear() || (year === today.getUTCFullYear() && month < today.getUTCMonth() + 1)) {
    return refuse("this card has expired");
  }
  const cvc = text(input?.cvc);
  if (!/^\d+$/.test(cvc) || cvc.length !== (known?.cvc ?? cvc.length) || cvc.length < 3 || cvc.length > 4) {
    return refuse("check the security code");
  }
  const name = text(input?.name);
  if (name.length > MAX_NAME) return refuse("the name on the card is too long");
  const postal = text(input?.postalCode);
  if (postal.length > MAX_POSTAL) return refuse("check the billing ZIP or postcode");
  const values = {
    number: raw,
    exp_month: String(month).padStart(2, "0"),
    exp_year: String(year),
    cvc,
    name,
    postal_code: postal,
  };
  const fields = CARD_FIELDS.filter((field) => values[field] !== "").map((field) => ({ name: field, perEnv: false, values: { _: values[field] } }));
  return { fields, summary: cardSummary(values), error: null };
}

/** What meta keeps of a card: brand, last four and expiry. Never the number or code. */
export function cardSummary(values) {
  const digits = text(values?.number);
  return {
    brand: brandOf(digits)?.brand ?? "card",
    last4: digits.slice(-4),
    expMonth: text(values?.exp_month),
    expYear: text(values?.exp_year),
  };
}

/** "Visa ••4242, expires 08/29": how a card is named to an AI and in a list. */
export function cardLabel(meta) {
  const card = meta?.card;
  if (!card || typeof card.last4 !== "string") return "card";
  return `${BRAND_NAMES[card.brand] ?? "Card"} ••${card.last4}, expires ${card.expMonth}/${String(card.expYear).slice(-2)}`;
}

/** One checkout box's value: a stored field, or `exp` as MM/YY. Null when the card has none. */
export function cardPartValue(part, field) {
  if (part === "exp") {
    const month = field("exp_month");
    const year = field("exp_year");
    return month && year ? `${month}/${year.slice(-2)}` : null;
  }
  return CARD_FIELDS.includes(part) ? field(part) : null;
}
