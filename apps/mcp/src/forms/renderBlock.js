import { FORM_FENCE_LANG, NOTIFY_RE } from "./grammar.js";

/* ----------------------------- writing a block ---------------------------- */

/**
 * A form block, rendered from a config. The inverse of `parseFormBody`.
 *
 * ## Why this exists at all
 *
 * "The gateway renders every row, and therefore parses every row" is the rule
 * the four submission tools are built on: no argument anywhere in them reaches
 * a file as text. A tool that *creates* a form has to hold the same line, and
 * the only way to hold it is to render the block here rather than take one.
 * `create_form` takes fields and a policy; it never takes Markdown.
 *
 * ## It refuses rather than mangles
 *
 * A form block is line-oriented and its field entries are comma-delimited, so
 * some strings simply cannot be written into one: a newline anywhere, or a
 * comma or bracket inside a select option, which `parseInlineMap` splits on
 * before it ever looks at quoting. A renderer that dropped or escaped those
 * would be writing a form the author did not ask for — and the author is about
 * to hand it to strangers. So each is an error naming the value.
 *
 * ## The round trip is the proof, not the comment
 *
 * Everything this emits is read back by this module's own scanner before it is
 * written: `create_form` parses the rendered block, and the parser is the
 * authority on what the form means. `forms.test.mjs` holds the stronger
 * property — render, parse, render again, byte for byte — over options that
 * open with a quote, which is the one fixture that decides the quoting here
 * and the only one a renderer emitting everything bare would fail. Same
 * discipline as `renderResponsesFile(parseResponsesFile(x)) === x` on the
 * response side.
 */
export function renderFormBlock(config) {
  const lines = [];
  for (const key of ["id", "responses", "layout", "submit"]) {
    const value = config[key];
    if (typeof value !== "string" || !value) return { error: `"${key}" is required` };
    // Top-level values run to the end of the line and are never unquoted, so a
    // line break is the only thing that cannot survive — and the only thing
    // that would silently become a second key.
    if (/[\r\n]/.test(value)) return { error: `"${key}" may not contain a line break` };
    lines.push(`${key}: ${value}`);
  }
  lines.push(`edit_own: ${config.edit_own === false ? "false" : "true"}`);
  lines.push(`show_responses: ${config.show_responses === true ? "true" : "false"}`);
  lines.push(`votes: ${config.votes === "named" ? "named" : "off"}`);

  /*
    Refused rather than escaped, for the reason the option list is: this value
    runs to the end of its line, so a newline in it would not be mangled, it
    would become a second key in a block somebody is about to hand to
    strangers. `NOTIFY_RE` admits nothing that needs escaping, which is why
    this is one test rather than a quoting rule — and why an address, the thing
    an author will reach for first, is refused here in the same words the
    parser uses rather than being written out and refused later by a server the
    author cannot see.
  */
  if (config.notify !== undefined && config.notify !== null) {
    if (typeof config.notify !== "string" || !NOTIFY_RE.test(config.notify)) {
      return {
        error: '"notify" must be owner or a handle such as @dan — never an email address',
      };
    }
    lines.push(`notify: ${config.notify}`);
  }

  if (!Array.isArray(config.fields) || !config.fields.length) {
    return { error: "a form needs at least one field" };
  }
  lines.push("fields:");
  for (const field of config.fields) {
    const entry = renderField(field);
    if (entry.error) return entry;
    lines.push(`  - ${entry.text}`);
  }
  return { text: ["```" + FORM_FENCE_LANG, ...lines, "```"].join("\n") };
}

function renderField(field) {
  if (!field || typeof field !== "object") return { error: "each field is an object" };
  const name = field.name;
  if (typeof name !== "string" || !name) return { error: 'a field needs a "name"' };
  const parts = [];
  for (const key of ["name", "type"]) {
    const value = field[key];
    if (typeof value !== "string" || !value) return { error: `"${name}": ${key} is required` };
    const scalar = quoteScalar(value);
    if (scalar === null) return { error: `"${name}": ${key} may not contain a line break` };
    parts.push(`${key}: ${scalar}`);
  }
  if (field.required === true) parts.push("required: true");
  for (const bound of ["max", "min"]) {
    if (field[bound] === undefined) continue;
    if (!Number.isFinite(field[bound])) return { error: `"${name}": ${bound} must be a number` };
    parts.push(`${bound}: ${field[bound]}`);
  }
  if (field.options !== undefined) {
    if (!Array.isArray(field.options) || !field.options.length) {
      return { error: `"${name}": options is a list of at least one choice` };
    }
    const rendered = [];
    for (const option of field.options) {
      if (typeof option !== "string" || !option.trim()) {
        return { error: `"${name}": every option is a non-empty string` };
      }
      // `parseInlineMap` finds the list's end with `indexOf("]")` and splits it
      // on commas, both before any quoting is considered. These three are
      // therefore inexpressible rather than merely awkward.
      if (/[[\],]/.test(option)) {
        return { error: `"${name}": an option may not contain a comma or a square bracket ("${option}")` };
      }
      const scalar = quoteScalar(option);
      if (scalar === null) return { error: `"${name}": an option may not contain a line break` };
      rendered.push(scalar);
    }
    parts.push(`options: [${rendered.join(", ")}]`);
  }
  return { text: `{ ${parts.join(", ")} }` };
}

/** Bare where the scanner reads it back unchanged; quoted otherwise. */
const BARE_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function quoteScalar(value) {
  if (/[\r\n]/.test(value)) return null;
  if (BARE_SCALAR_RE.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
