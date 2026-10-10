/**
 * Vault fields: the named values an entry carries beyond a login's username
 * and password. An API key, a webhook secret, an account number, or an
 * environment variable with one value each for dev, staging and prod
 * (decided by the owner, 2026-10-10: "it should support custom fields but for
 * most they will need dev, staging and prod environment variables").
 *
 * The values are sealed in the entry's `secret` part. Its `meta` part carries
 * each field's name, whether it is per environment, and which environments
 * hold a value, so an agent can say "STRIPE_KEY is saved for dev and prod"
 * without ever opening one.
 */

/** The environments a per-environment field holds, in the order a page shows them. */
export const ENVS = Object.freeze(["dev", "staging", "prod"]);
/** The key a single-valued field keeps its one value under. */
export const SINGLE = "_";
export const MAX_FIELDS = 30;
/** Long enough for a private key or a service-account file, short of a document. */
export const MAX_VALUE = 8192;

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/;

export function isFieldName(value) {
  return typeof value === "string" && NAME.test(value) && value === value.trim();
}

/** The entry types. An entry saved before types existed is a login. */
export function entryType(meta) {
  return meta?.type === "secret" ? "secret" : "login";
}

/**
 * Validate the fields a person typed: `[{name, perEnv, values}]` where
 * `values` is `{_: v}` or `{dev?, staging?, prod?}`. Returns `{fields, error}`
 * with blank values dropped, so a field left empty in staging is simply not
 * set there. Names are unique ignoring case, because `.env` keys collide that
 * way in practice.
 */
export function normalizeFields(input) {
  if (input === undefined || input === null) return { fields: [], error: null };
  if (!Array.isArray(input)) return { fields: [], error: "fields must be a list" };
  if (input.length > MAX_FIELDS) return { fields: [], error: `at most ${MAX_FIELDS} fields` };
  const seen = new Set();
  const fields = [];
  for (const raw of input) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!isFieldName(name)) return { fields: [], error: "a field name is letters, digits, spaces, dots, dashes or underscores" };
    if (seen.has(name.toLowerCase())) return { fields: [], error: `${name} is there twice` };
    seen.add(name.toLowerCase());
    const perEnv = raw?.perEnv === true;
    const keys = perEnv ? ENVS : [SINGLE];
    const values = {};
    for (const key of keys) {
      const value = raw?.values?.[key];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") return { fields: [], error: `${name} has a value that is not text` };
      if (value.length > MAX_VALUE) return { fields: [], error: `${name} is longer than a field can be` };
      values[key] = value;
    }
    fields.push({ name, perEnv, values });
  }
  return { fields, error: null };
}

/** What `meta` says about fields: names, per-environment or not, and where a value is set. Never a value. */
export function fieldSummaries(fields) {
  return fields.map(({ name, perEnv, values }) => ({
    name,
    perEnv,
    set: (perEnv ? ENVS : [SINGLE]).filter((key) => typeof values?.[key] === "string"),
  }));
}

/** One field's value from an opened secret part, or null. `env` is required for a per-environment field. */
export function fieldValue(secret, field, env) {
  const found = (Array.isArray(secret?.fields) ? secret.fields : []).find((entry) => entry?.name === field);
  if (!found) return null;
  const key = found.perEnv ? env : SINGLE;
  if (found.perEnv && !ENVS.includes(env)) return null;
  const value = found.values?.[key];
  return typeof value === "string" ? value : null;
}
