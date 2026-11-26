/**
 * WHOSE ANTHROPIC KEY PAYS FOR A CALL (decided by the owner, 2026-11-26).
 *
 * The keys live on the AI Gateway's Provider Keys page; `aiKeys.json` names
 * them by alias and records, per key, whose it is, its credit (`capUsd`), how
 * much is used (`usedUsd` as of `usedAsOf`), when one-off credit expires
 * (`expires`) or, for use-it-or-lose-it monthly credit (`resetEvery: "month"`),
 * when it lapses and refills (`resets`, then every month after), and
 * `retiredUntil`: skip it until then. Aliases are names, not secrets.
 *
 * Per use (`prod`, `lab`, `evals`) the keys that can still pay are tried by
 * whose credit lapses soonest (a monthly key's period end, or a one-off
 * expiry), so credit that is about to lapse is spent before credit that keeps (Dev2: "smartly always use the expiring key first before
 * we go onto the next"); keys with no expiry follow, in file order. A key is
 * left out while retired, once expired, or once its recorded use reaches its
 * credit. The gateway (`aiGateway.js`) and the benchmark runner
 * (`bench/models.mjs`) read the order at call time, so a retirement ends on
 * its date without a deploy; the console's costs page reads the same file.
 *
 * A run may pick a key first (`AI_KEY_PICK`, from a Lab or eval run's `key`):
 * it goes ahead of the use's order whatever its state, and the order follows
 * it, so a picked key that cannot pay never stops the run.
 */

const FILE = require("./aiKeys.json");

/** An alias the gateway's Provider Keys page accepts. */
const KEY_ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_KEY_ALIASES = 8;

const USES = Object.freeze(Object.keys(FILE.uses));
const AI_KEYS = Object.freeze(FILE.keys.map((key) => Object.freeze({ ...key, uses: Object.freeze([...key.uses]) })));

const time = (iso) => (typeof iso === "string" ? Date.parse(iso) : NaN);

/** `iso` moved by `months` calendar months, the day clamped to the month's last. */
function addMonths(at, months) {
  const d = new Date(at);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * The current credit period of a monthly key (`resetEvery: "month"`): `{ start, end }`, where `end` is the next
 * monthly anniversary of `resets` after `now` (when the credit lapses and refills). Null for a key that does not reset.
 */
function periodOf(key, now = Date.now()) {
  const anchor = time(key.resets);
  if (key.resetEvery !== "month" || !Number.isFinite(anchor)) return null;
  let n = 0;
  if (anchor <= now) while (addMonths(anchor, n) <= now && n < 1200) n += 1;
  else while (addMonths(anchor, n - 1) > now && n > -1200) n -= 1;
  return { start: addMonths(anchor, n - 1), end: addMonths(anchor, n) };
}

/** When `key`'s current credit lapses: its period's end, a one-off `expires`, or Infinity. */
function lapsesAt(key, now = Date.now()) {
  const period = periodOf(key, now);
  if (period) return period.end;
  return Number.isFinite(time(key.expires)) ? time(key.expires) : Infinity;
}

/**
 * Why `key` cannot pay at `now` ("retired", "expired", "used up"), or null when it can. A monthly key never expires;
 * its recorded use counts only inside the period it was recorded in, so a refill makes it whole again.
 */
function keyState(key, now = Date.now()) {
  if (time(key.retiredUntil) > now) return "retired";
  const period = periodOf(key, now);
  if (!period && time(key.expires) <= now) return "expired";
  const useCounts = !period || time(key.usedAsOf) >= period.start;
  if (useCounts && Number.isFinite(key.capUsd) && Number.isFinite(key.usedUsd) && key.usedUsd >= key.capUsd) return "used up";
  return null;
}

/** Clean a comma list or array of aliases: trimmed, valid, unique, capped. */
function cleanAliases(list) {
  const parts = Array.isArray(list) ? list : String(list ?? "").split(",");
  return [...new Set(parts.map((alias) => String(alias).trim()).filter((alias) => KEY_ALIAS.test(alias)))].slice(0, MAX_KEY_ALIASES);
}

/** The keys for `use` that can pay at `now`, soonest expiry first, then file order; empty for an unknown use. */
function keysForUse(use, now = Date.now()) {
  if (!USES.includes(use)) return [];
  return AI_KEYS.map((key, i) => ({ key, i, lapses: lapsesAt(key, now) }))
    .filter(({ key }) => key.uses.includes(use) && keyState(key, now) === null)
    .sort((a, b) => a.lapses - b.lapses || a.i - b.i)
    .map(({ key }) => key);
}

function aliasesForUse(use, now = Date.now()) {
  return keysForUse(use, now).map((key) => key.alias);
}

/**
 * The key a person named, by alias, id or owner ("segun", "Segun's key",
 * "segun-claude-credits"), or null when none matches.
 */
function findKey(name) {
  if (typeof name !== "string") return null;
  const said = name.trim().toLowerCase().replace(/['’]s\b/g, "").replace(/\bkey\b/g, "").trim();
  if (!said) return null;
  return AI_KEYS.find((key) => key.alias === said || key.key === said || key.owner.toLowerCase() === said) ?? null;
}

/**
 * The aliases an environment tries, in order. With `AI_KEY_USE`: a run's pick
 * (`AI_KEY_PICK`) first, then that use's order at `now`. Without it, the
 * older literal list `AI_GATEWAY_KEY_ALIASES`, or none: a self-hosted gateway
 * names no key it does not hold.
 */
function keyAliasesOf(env, now = Date.now()) {
  const use = typeof env?.AI_KEY_USE === "string" ? env.AI_KEY_USE.trim() : "";
  if (!use) return cleanAliases(typeof env?.AI_GATEWAY_KEY_ALIASES === "string" ? env.AI_GATEWAY_KEY_ALIASES : []);
  const picked = findKey(typeof env?.AI_KEY_PICK === "string" ? env.AI_KEY_PICK : "");
  return cleanAliases([...(picked ? [picked.alias] : []), ...aliasesForUse(use, now)]);
}

/** Every key as `tex_dev keys` shows it: its record, whether it can pay now, and its place in each use's order. */
function keysReport(now = Date.now()) {
  const orders = Object.fromEntries(USES.map((use) => [use, aliasesForUse(use, now)]));
  return {
    order: orders,
    keys: AI_KEYS.map((key) => ({
      ...key,
      leftUsd: Number.isFinite(key.capUsd) && Number.isFinite(key.usedUsd) ? Math.max(0, key.capUsd - key.usedUsd) : null,
      lapses: Number.isFinite(lapsesAt(key, now)) ? new Date(lapsesAt(key, now)).toISOString() : null,
      state: keyState(key, now) ?? "active",
    })),
  };
}

module.exports = { AI_KEYS, USES, KEY_ALIAS, MAX_KEY_ALIASES, aliasesForUse, cleanAliases, findKey, keyAliasesOf, keyState, keysForUse, keysReport, lapsesAt, periodOf };
