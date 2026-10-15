/**
 * A vault entry's named fields, as the `/vault/<token>` page edits and shows
 * them: an API key, a webhook secret, or an environment variable with one
 * value each for dev, staging and prod (decided by the owner, 2026-10-10;
 * `docs/decisions/texting-assistant/vault.md`).
 *
 * The rules mirror `apps/mcp/src/vault/fields.js`, which is what actually
 * decides; checking them here only lets the form say what is wrong beside the
 * field instead of after a round trip. Pure, so every rule is tested without
 * a screen, and nothing here logs, stores or sends a value.
 */

export const ENVS = ["dev", "staging", "prod"] as const;
export type Env = (typeof ENVS)[number];
export const ENV_LABEL: Record<Env, string> = { dev: "Dev", staging: "Staging", prod: "Prod" };
/** The key a single-valued field keeps its one value under. */
export const SINGLE = "_";
export const MAX_FIELDS = 30;
export const MAX_VALUE = 8192;
const FIELD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/;

export function isEnv(value: unknown): value is Env {
  return typeof value === "string" && (ENVS as readonly string[]).includes(value);
}

export function isFieldName(value: string): boolean {
  return FIELD_NAME.test(value) && value === value.trim();
}

/** One field on the form. `id` is local, so a row keeps its identity while its name is typed. */
export interface FieldDraft {
  id: string;
  name: string;
  perEnv: boolean;
  /** All four columns are kept, so flipping the toggle back does not lose what was typed. */
  values: { _: string; dev: string; staging: string; prod: string };
}

/** What `saveVaultLogin` takes for one field. */
export interface SubmitField {
  name: string;
  perEnv: boolean;
  values: Partial<Record<Env | typeof SINGLE, string>>;
}

/** A field as `revealVaultEntry` answers it. */
export interface RevealedField {
  name: string;
  perEnv: boolean;
  values: Record<string, string>;
}

let counter = 0;
/** A fresh row id. Never derived from a name or a value. */
export function nextFieldId(): string {
  counter += 1;
  return `field-${counter}`;
}

export function emptyField(perEnv: boolean, name = "", id = nextFieldId()): FieldDraft {
  return { id, name, perEnv, values: { _: "", dev: "", staging: "", prod: "" } };
}

/**
 * The rows a form starts with: the agent's suggested names, or one blank row
 * for a secret so there is somewhere to type. Names that could never be saved
 * and repeats are dropped rather than shown as errors the person did not make.
 */
export function initialFields(names: readonly string[], perEnv: boolean, blankRow: boolean): FieldDraft[] {
  const seen = new Set<string>();
  const rows: FieldDraft[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!isFieldName(name) || seen.has(name.toLowerCase()) || rows.length >= MAX_FIELDS) continue;
    seen.add(name.toLowerCase());
    rows.push(emptyField(perEnv, name));
  }
  if (rows.length === 0 && blankRow) rows.push(emptyField(perEnv));
  return rows;
}

/** The value columns a row submits, in the order the form shows them. */
export function columnsOf(field: Pick<FieldDraft, "perEnv">): ReadonlyArray<Env | typeof SINGLE> {
  return field.perEnv ? ENVS : [SINGLE];
}

function hasValue(field: FieldDraft): boolean {
  return columnsOf(field).some((key) => field.values[key].length > 0);
}

/** A row nobody has typed into: no name, no value. Left out of the save, never an error. */
export function isBlankRow(field: FieldDraft): boolean {
  return field.name.trim() === "" && !hasValue(field);
}

export interface FieldProblems {
  /** Per row id: what is wrong with its name. */
  names: Record<string, string>;
  /** Per row id and column: a value that is too long. */
  values: Record<string, Partial<Record<Env | typeof SINGLE, string>>>;
  /** Whether anything above is set. */
  any: boolean;
}

/** What the form shows beside each field before Save can be pressed. */
export function fieldProblems(drafts: readonly FieldDraft[]): FieldProblems {
  const names: Record<string, string> = {};
  const values: FieldProblems["values"] = {};
  const seen = new Map<string, string>();
  for (const field of drafts) {
    if (isBlankRow(field)) continue;
    const name = field.name.trim();
    if (name === "") names[field.id] = "Give this field a name.";
    else if (!isFieldName(name)) names[field.id] = "Use letters, digits, spaces, dots, dashes or underscores.";
    else if (seen.has(name.toLowerCase())) names[field.id] = `${seen.get(name.toLowerCase())} is already a field.`;
    else seen.set(name.toLowerCase(), name);
    for (const key of columnsOf(field)) {
      if (field.values[key].length > MAX_VALUE) {
        values[field.id] = { ...values[field.id], [key]: `Keep it under ${MAX_VALUE.toLocaleString("en-US")} characters.` };
      }
    }
  }
  const any = Object.keys(names).length > 0 || Object.keys(values).length > 0;
  return { names, values, any };
}

/** The rows that are not blank, in `saveVaultLogin`'s shape, empty values left out. */
export function submitFields(drafts: readonly FieldDraft[]): SubmitField[] {
  return drafts
    .filter((field) => !isBlankRow(field))
    .map((field) => {
      const values: SubmitField["values"] = {};
      for (const key of columnsOf(field)) {
        if (field.values[key].length > 0) values[key] = field.values[key];
      }
      return { name: field.name.trim(), perEnv: field.perEnv, values };
    });
}

/** Whether any row carries a value: a secret saves only with one. */
export function anyValue(drafts: readonly FieldDraft[]): boolean {
  return drafts.some((field) => !isBlankRow(field) && hasValue(field));
}

/* --------------------------------- .env in -------------------------------- */

export interface DotenvEntry {
  name: string;
  value: string;
}

const DOTENV_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/;

/**
 * Read pasted `.env` text: `KEY=value` lines, `export ` in front, `#`
 * comments on their own line or after an unquoted value, single quotes taken
 * literally, double quotes with `\n`, `\"` and `\\` escapes and able to run
 * over several lines. A line that is none of these is counted, not guessed at.
 * A key given twice keeps its last value, as a shell would.
 */
export function parseDotenv(text: string): { entries: DotenvEntry[]; skipped: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const found = new Map<string, DotenvEntry>();
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = DOTENV_LINE.exec(line.replace(/^export\s+/, ""));
    if (match === null) {
      skipped += 1;
      continue;
    }
    const name = match[1]!;
    let rest = match[2]!.trimStart();
    let value: string;
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else if (rest.startsWith('"')) {
      // A double-quoted value may run on to later lines until its closing quote.
      let body = rest.slice(1);
      let end = closingQuote(body);
      while (end === -1 && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index]}`;
        end = closingQuote(body);
      }
      value = unescapeDouble(end === -1 ? body : body.slice(0, end));
    } else {
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment);
      value = rest.trim();
    }
    found.delete(name);
    found.set(name, { name, value });
  }
  return { entries: [...found.values()], skipped };
}

function closingQuote(body: string): number {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\") i += 1;
    else if (body[i] === '"') return i;
  }
  return -1;
}

function unescapeDouble(body: string): string {
  return body.replace(/\\([nrt"\\$])/g, (_, ch: string) =>
    ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch,
  );
}

/**
 * Put parsed `.env` values into one environment's column. A name already on
 * the form (ignoring case) takes the value — in `env`'s column when it is per
 * environment, its one value otherwise — and a new name becomes a new
 * per-environment row. Blank rows make way; nothing past the field limit is
 * added, and the count of what was left out is returned so the page can say so.
 */
export function applyDotenv(
  drafts: readonly FieldDraft[],
  entries: readonly DotenvEntry[],
  env: Env,
): { drafts: FieldDraft[]; filled: number; dropped: number } {
  const rows = drafts.filter((field) => !isBlankRow(field)).map((field) => ({ ...field, values: { ...field.values } }));
  let filled = 0;
  let dropped = 0;
  for (const entry of entries) {
    if (!isFieldName(entry.name)) {
      dropped += 1;
      continue;
    }
    const existing = rows.find((field) => field.name.trim().toLowerCase() === entry.name.toLowerCase());
    if (existing !== undefined) {
      existing.values[existing.perEnv ? env : SINGLE] = entry.value;
      filled += 1;
      continue;
    }
    if (rows.length >= MAX_FIELDS) {
      dropped += 1;
      continue;
    }
    const row = emptyField(true, entry.name);
    row.values[env] = entry.value;
    rows.push(row);
    filled += 1;
  }
  return { drafts: filled === 0 ? [...drafts] : rows, filled, dropped };
}

/* --------------------------------- .env out ------------------------------- */

const ENV_SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A field name as a `.env` key: kept when it already is one, else UPPER_SNAKE. */
export function dotenvKey(name: string): string {
  if (ENV_SAFE.test(name)) return name;
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (snake === "") return "FIELD";
  return /^[0-9]/.test(snake) ? `_${snake}` : snake;
}

const BARE = /^[A-Za-z0-9_./:@+,=%-]*$/;

/**
 * A value as `.env` writes it. Bare when nothing in it needs quoting; single
 * quotes when it has no `'` or line break, since those are literal in every
 * reader (dotenv, Docker Compose, a shell's `source`); otherwise double
 * quotes, escaping `\`, `"`, `$` and line breaks.
 */
export function dotenvValue(value: string): string {
  if (BARE.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** The value a field holds in `env`: its env column when per environment, its one value otherwise. */
export function valueIn(field: RevealedField, env: Env): string | null {
  const value = field.values[field.perEnv ? env : SINGLE];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One environment as a `.env` file: every field with a value there, keys made
 * env-safe, a key that two names collapse into numbered rather than one value
 * silently winning. A comment line names the entry, and the environment when
 * any field has one per environment.
 */
export function buildDotenv(entryName: string, fields: readonly RevealedField[], env: Env): string {
  const title = entryName.replace(/[\r\n]+/g, " ");
  const lines = [fields.some((field) => field.perEnv) ? `# ${title} (${env})` : `# ${title}`];
  const used = new Set<string>();
  for (const field of fields) {
    const value = valueIn(field, env);
    if (value === null) continue;
    const base = dotenvKey(field.name);
    let key = base;
    for (let n = 2; used.has(key.toUpperCase()); n += 1) key = `${base}_${n}`;
    used.add(key.toUpperCase());
    lines.push(`${key}=${dotenvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** How many fields `buildDotenv` would write for `env`. */
export function dotenvCount(fields: readonly RevealedField[], env: Env): number {
  return fields.filter((field) => valueIn(field, env) !== null).length;
}
