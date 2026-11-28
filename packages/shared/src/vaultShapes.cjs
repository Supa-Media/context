/**
 * Vault shapes the gateway and Tex both name: a card's fields and checkout parts, an entry's type, a new login's
 * password, and the share a key gives one Tex group chat. Pure: nothing here reads or opens a secret. The readers
 * (`openForFill`, `fieldValue`, `actorMayUse` and the rest) stay in `apps/mcp/src/vault/`.
 */

/** A card's fields, in the order a checkout asks for them. `exp` is never stored: it is made from the month and year. */
const CARD_FIELDS = Object.freeze(["number", "exp_month", "exp_year", "cvc", "name", "postal_code"]);
/** The parts a checkout box can be: the stored fields, and `exp` for one MM/YY box. */
const CARD_PARTS = Object.freeze(["number", "exp", "exp_month", "exp_year", "cvc", "name", "postal_code"]);

const BRAND_NAMES = { amex: "Amex", visa: "Visa", mastercard: "Mastercard", discover: "Discover", card: "Card" };

/** "Visa ••4242, expires 08/29": how a card is named to an AI and in a list. */
function cardLabel(meta) {
  const card = meta?.card;
  if (!card || typeof card.last4 !== "string") return "card";
  return `${BRAND_NAMES[card.brand] ?? "Card"} ••${card.last4}, expires ${card.expMonth}/${String(card.expYear).slice(-2)}`;
}

/** One checkout box's value: a stored field, or `exp` as MM/YY. Null when the card has none. */
function cardPartValue(part, field) {
  if (part === "exp") {
    const month = field("exp_month");
    const year = field("exp_year");
    return month && year ? `${month}/${year.slice(-2)}` : null;
  }
  return CARD_FIELDS.includes(part) ? field(part) : null;
}

/** The entry types (`card.js` for cards). An entry saved before types existed is a login. */
function entryType(meta) {
  return meta?.type === "secret" || meta?.type === "card" ? meta.type : "login";
}

/**
 * A STRONG RANDOM PASSWORD FOR A NEW ACCOUNT, MADE ON THE GATEWAY.
 *
 * `make_login` (`agent/makeLogin.js`) creates a password the model never
 * sees: the gateway makes it, seals it into the person's vault, and types it
 * into the sign-up form. So the generator must be unbiased and unpredictable:
 * every byte comes from `crypto.getRandomValues`, never `Math.random`, and a
 * character is drawn by rejection sampling so no symbol is favoured by the
 * modulo of an uneven range.
 *
 * Each character class in use is guaranteed at least once, because sign-up
 * forms refuse a password without a digit or a symbol and a retry costs the
 * person a fresh form. Look-alike characters (0/O, 1/l/I) are left out of the
 * sets, so a password read off a screen or typed by hand stays unambiguous.
 */

const PASSWORD_LENGTH = 20;
const MIN_LENGTH = 12;
const MAX_LENGTH = 64;

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

const RANGE = 2 ** 32;

/**
 * A uniform integer in [0, n). A raw Uint32 at or above the largest multiple
 * of `n` that fits in 2^32 is thrown away and drawn again, so every residue
 * is exactly as likely as every other (a plain `% n` favours the low ones).
 */
function randomBelow(n) {
  if (!Number.isInteger(n) || n < 1 || n > RANGE) throw new RangeError("randomBelow needs an integer from 1 to 2^32");
  const limit = Math.floor(RANGE / n) * n;
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    if (word[0] < limit) return word[0] % n;
  }
}

function clampLength(length) {
  if (!Number.isInteger(length)) return PASSWORD_LENGTH;
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, length));
}

/** Fisher–Yates over the array, in place, with `randomBelow` for every swap. */
function shuffle(chars) {
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

/**
 * A password of `length` characters (clamped to [MIN_LENGTH, MAX_LENGTH]).
 * `symbols: false` leaves the symbol class out for a site that refuses them.
 */
function newPassword({ length = PASSWORD_LENGTH, symbols = true } = {}) {
  const classes = [LOWER, UPPER, DIGITS];
  if (symbols !== false) classes.push(SYMBOLS);
  const union = classes.join("");
  const size = clampLength(length);

  // One from each class first, so the guarantee holds whatever the rest draws.
  const chars = classes.map((set) => set[randomBelow(set.length)]);
  while (chars.length < size) chars.push(union[randomBelow(union.length)]);
  return shuffle(chars).join("");
}


/**
 * A key given to one Tex group chat (Dev2, 2026-11-12: "a group created automatically for that chat"), saved from a
 * link Tex texted there: `#chat:<the chat's key>`. Never a person or an `@group`, so only that chat's own turns count
 * it (`actorAccessOf`), and only to use.
 */
const CHAT_SHARE_PREFIX = "#chat:";
function chatShareTo(chatKey) {
  return `${CHAT_SHARE_PREFIX}${chatKey}`;
}

module.exports = { CARD_FIELDS, CARD_PARTS, cardLabel, cardPartValue, entryType, PASSWORD_LENGTH, MIN_LENGTH, MAX_LENGTH, randomBelow, newPassword, CHAT_SHARE_PREFIX, chatShareTo };
