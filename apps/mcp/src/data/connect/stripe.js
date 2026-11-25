/**
 * Stripe, connected with a read-only restricted key (`rk_live_…` or `rk_test_…`). Its dataset is `revenue.csv`:
 * one row per balance transaction in the reporting categories that make or take back revenue, in the currency's
 * main unit. A secret key (`sk_`) is refused: it can write, and Context only ever reads.
 *
 * Kept columns: `id`, `date`, `category`, `currency`, `amount`, `fee`, `net`, and `usd`, the amount again when it is
 * in US dollars (empty otherwise), so `sum(stripe/revenue.usd)` reads as the boards write it. No description, customer or email:
 * a sheet is read by everyone its folder is shared with, and a description can hold a customer's name.
 */

import { appJson } from "./appFetch.js";

const API = "https://api.stripe.com/v1/balance_transactions";
const NAME = "Stripe";
export const STRIPE_KEY = /^rk_(live|test)_[A-Za-z0-9]{16,250}$/;
/** The reporting categories a revenue sheet keeps (Stripe's own names). */
const CATEGORIES = new Set(["charge", "refund", "dispute", "dispute_reversal", "partial_capture_reversal", "charge_failure", "refund_failure"]);
/** Currencies Stripe counts in whole units (its zero-decimal list); every other is in hundredths. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** The most pages one run reads: 100 rows each. */
export const STRIPE_MAX_PAGES = 50;

export const STRIPE_SOURCE = Object.freeze({
  app: "stripe",
  name: NAME,
  dataset: "revenue",
  key: "id",
  date: "date",
  columns: Object.freeze([
    { name: "id", type: "text" },
    { name: "date", type: "date" },
    { name: "category", type: "text" },
    { name: "currency", type: "text" },
    { name: "amount", type: "number" },
    { name: "fee", type: "number" },
    { name: "net", type: "number" },
    { name: "usd", type: "number" },
  ]),
});

const auth = (key) => ({ headers: { authorization: `Bearer ${key}` } });

/** What the owner pasted, checked by its shape and then by Stripe: `{ok: true, kept}` or `{ok: false, said}`. */
export async function checkStripeKey(input, fetcher) {
  const key = typeof input?.key === "string" ? input.key.trim() : "";
  if (/^sk_/.test(key)) return { ok: false, said: "That's a secret key, which can change your Stripe account. Make a restricted key with read access instead" };
  if (!STRIPE_KEY.test(key)) return { ok: false, said: "That isn't a Stripe restricted key; it starts with rk_live_ or rk_test_" };
  const tried = await appJson(fetcher, `${API}?limit=1`, auth(key), NAME);
  if (!tried.ok) return { ok: false, said: tried.status === 401 || tried.status === 403 ? "Stripe refused the key; give it read access to Balance transactions" : `${tried.said}; try again` };
  return { ok: true, kept: { key } };
}

const unit = (currency, minor) => {
  const value = Number(minor);
  if (!Number.isFinite(value)) return "";
  return String(ZERO_DECIMAL.has(currency) ? value : value / 100);
};

/** One balance transaction as a row, or null when it isn't revenue. */
export function stripeRow(txn) {
  if (!txn || typeof txn.id !== "string" || !Number.isFinite(txn.created)) return null;
  const category = String(txn.reporting_category ?? "");
  if (!CATEGORIES.has(category)) return null;
  const currency = String(txn.currency ?? "").toLowerCase().slice(0, 3);
  return {
    id: txn.id.slice(0, 64),
    date: new Date(txn.created * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    category,
    currency,
    amount: unit(currency, txn.amount),
    fee: unit(currency, txn.fee),
    net: unit(currency, txn.net),
    usd: currency === "usd" ? unit(currency, txn.amount) : "",
  };
}

/**
 * The revenue rows from `sinceMs` up to `beforeMs` (or now), newest first as Stripe lists them: `{ok: true, rows,
 * more}` or `{ok: false, said, refused}`. `more` says the page cap was reached before the oldest of them.
 */
export async function fetchStripeRows({ kept, sinceMs, beforeMs = null, fetcher, pages = STRIPE_MAX_PAGES }) {
  const rows = [];
  let after = null;
  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(Math.floor(sinceMs / 1000)) });
    if (beforeMs !== null) query.set("created[lt]", String(Math.floor(beforeMs / 1000)));
    if (after !== null) query.set("starting_after", after);
    const answered = await appJson(fetcher, `${API}?${query}`, auth(kept.key), NAME);
    if (!answered.ok) return { ok: false, said: answered.said, refused: answered.status === 401 || answered.status === 403 };
    const data = Array.isArray(answered.body?.data) ? answered.body.data : [];
    for (const txn of data) {
      const row = stripeRow(txn);
      if (row !== null) rows.push(row);
    }
    if (answered.body?.has_more !== true || data.length === 0) return { ok: true, rows, more: false };
    after = typeof data[data.length - 1]?.id === "string" ? data[data.length - 1].id : null;
    if (after === null) return { ok: true, rows, more: false };
  }
  return { ok: true, rows, more: true };
}
