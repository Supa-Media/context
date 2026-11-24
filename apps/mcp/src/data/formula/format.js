/**
 * A metric's value as a person reads it, in one of a few display formats.
 * Pure; the app's tiles and the gateway's answers show the same text.
 */

export const FORMATS = Object.freeze(["0", "0.0", "0%", "0.0%", "$0", "$0.00", "duration", "0.0k"]);

const NO_VALUE = "—";

function fixed(n, digits) {
  // `|| 0` turns -0 into 0, so a small negative never shows as "-0".
  const rounded = Number(n.toFixed(digits)) || 0;
  return rounded.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** One decimal, without a trailing ".0": 2.4, 3. */
function short(n) {
  return String(Number(n.toFixed(1)) || 0);
}

function duration(minutes) {
  const m = Math.round(minutes) || 0;
  if (Math.abs(m) < 60) return `${m} min`;
  const hours = minutes / 60;
  if (Math.abs(Number(hours.toFixed(1))) < 24) return `${short(hours)} h`;
  return `${short(minutes / 1440)} d`;
}

function money(n, digits) {
  const text = fixed(Math.abs(n), digits);
  return Number(n.toFixed(digits)) < 0 ? `-$${text}` : `$${text}`;
}

/** `value` (a number, or null for no value) in `format`; an unknown format shows up to two decimals. */
export function formatValue(value, format) {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_VALUE;
  switch (format) {
    case "0": return fixed(value, 0);
    case "0.0": return fixed(value, 1);
    case "0%": return `${fixed(value * 100, 0)}%`;
    case "0.0%": return `${fixed(value * 100, 1)}%`;
    case "$0": return money(value, 0);
    case "$0.00": return money(value, 2);
    case "duration": return duration(value);
    case "0.0k": return `${fixed(value / 1000, 1)}k`;
    default: return (Number(value.toFixed(2)) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}
