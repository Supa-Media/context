/**
 * A card in the vault, as the app handles it: what the add form checks
 * before Save, and how a saved card is named everywhere it is listed. The
 * control plane checks it again and is the one that decides
 * (`apps/mcp/src/vault/card.js`); this only spares the person a round trip.
 *
 * Pure so the tests can walk it without a screen.
 */

/** What `saveVaultLogin` takes as `card`. */
export interface CardDraft {
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  name?: string;
  postalCode?: string;
}

/** The form's own state: one expiry box, typed as MM/YY. */
export interface CardFormState {
  number: string;
  expiry: string;
  cvc: string;
  name: string;
  postalCode: string;
}

export const CARD_EMPTY: CardFormState = { number: "", expiry: "", cvc: "", name: "", postalCode: "" };

/** `meta.card`: what a list is told of a card. Never its number. */
export interface CardSummary {
  brand: string;
  last4: string;
  expMonth: string;
  expYear: string;
}

const BRAND_NAMES: Record<string, string> = { amex: "Amex", visa: "Visa", mastercard: "Mastercard", discover: "Discover" };

export const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** The Luhn check digit every card number carries. */
export function luhnOk(digits: string): boolean {
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

const isAmex = (digits: string) => /^3[47]/.test(digits);

/** "4242 4242 4242 4242" (Amex as 4-6-5) as the person types, so a slip is visible. */
export function groupCardNumber(value: string): string {
  const digits = digitsOf(value).slice(0, 19);
  const sizes = isAmex(digits) ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const groups: string[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= digits.length) break;
    groups.push(digits.slice(at, at + size));
    at += size;
  }
  return groups.join(" ");
}

/** "08/29" as the person types "0829" or "8/29". */
export function groupExpiry(value: string): string {
  const raw = value.replace(/[^\d/]/g, "");
  const [month = "", year = ""] = raw.includes("/") ? raw.split("/") : [raw.slice(0, 2), raw.slice(2)];
  const mm = month.slice(0, 2);
  const yy = digitsOf(year).slice(0, 2);
  if (raw.includes("/") || yy.length > 0) return `${mm}/${yy}`;
  return mm;
}

/** The month and two-digit year in an MM/YY box, or null when it isn't one. */
export function parseExpiry(value: string): { month: number; year: number } | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{2})\s*$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(match[2]) };
}

/** What still stands between a card and Save, in one sentence, or null. */
export function cardBlocker(card: CardFormState, now: Date = new Date()): string | null {
  const digits = digitsOf(card.number);
  if (digits.length === 0) return "To save, enter the card number.";
  if (digits.length < 12 || digits.length > 19 || !luhnOk(digits)) return "Check the card number.";
  if (card.expiry.trim() === "") return "To save, enter the expiry date.";
  const expiry = parseExpiry(card.expiry);
  if (expiry === null) return "Enter the expiry as MM/YY.";
  if (expiry.year < now.getUTCFullYear() || (expiry.year === now.getUTCFullYear() && expiry.month < now.getUTCMonth() + 1)) {
    return "This card has expired.";
  }
  const cvc = digitsOf(card.cvc);
  if (cvc.length === 0) return "To save, enter the security code.";
  if (cvc.length !== (isAmex(digits) ? 4 : 3)) return isAmex(digits) ? "An Amex security code is 4 digits." : "The security code is 3 digits.";
  return null;
}

/** The form's state in `saveVaultLogin`'s shape, or null while it can't be saved. */
export function cardDraft(card: CardFormState, now: Date = new Date()): CardDraft | null {
  if (cardBlocker(card, now) !== null) return null;
  const expiry = parseExpiry(card.expiry)!;
  return {
    number: digitsOf(card.number),
    expMonth: String(expiry.month),
    expYear: String(expiry.year),
    cvc: digitsOf(card.cvc),
    ...(card.name.trim() ? { name: card.name.trim() } : {}),
    ...(card.postalCode.trim() ? { postalCode: card.postalCode.trim() } : {}),
  };
}

/** "Visa ••4242, expires 08/29", the same words Tex is told. */
export function cardLabel(card: CardSummary | null | undefined): string {
  if (!card || typeof card.last4 !== "string") return "Card";
  return `${BRAND_NAMES[card.brand] ?? "Card"} ••${card.last4}, expires ${card.expMonth}/${String(card.expYear).slice(-2)}`;
}

/** How a card's stored fields read on its view page. */
export const CARD_FIELD_LABELS: Record<string, string> = {
  number: "Card number",
  exp_month: "Expiry month",
  exp_year: "Expiry year",
  cvc: "Security code",
  name: "Name on card",
  postal_code: "Billing ZIP or postcode",
};
