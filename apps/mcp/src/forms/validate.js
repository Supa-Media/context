import { DATE_RE } from "./grammar.js";
import { parseAnswerBool } from "./config.js";

/* ---------------------------- submitted values --------------------------- */

/**
 * Check one submission against the form, and normalize it to strings.
 *
 * Everything stored in the response file is a string, because the file is the
 * record and a number that came back as `1.0` where `1` went in is a diff
 * nobody asked for. Coercion happens once, here, and the rendered value is
 * what a later read gets back verbatim.
 */
export function validateSubmission(config, values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return { error: "values must be an object of field names to answers" };
  }
  const known = new Set(config.fields.map((field) => field.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) return { error: `there is no field called "${key}" on this form` };
  }

  const out = {};
  for (const field of config.fields) {
    const supplied = values[field.name];
    const missing = supplied === undefined || supplied === null || supplied === "";
    if (missing) {
      if (field.required) return { error: `"${field.name}" is required` };
      out[field.name] = "";
      continue;
    }
    const checked = normalizeValue(field, supplied);
    if (checked.error) return checked;
    out[field.name] = checked.value;
  }
  return { values: out };
}

function normalizeValue(field, supplied) {
  switch (field.type) {
    case "checkbox": {
      const parsed = parseAnswerBool(supplied);
      if (parsed === null) return { error: `"${field.name}" must be yes or no` };
      return { value: parsed ? "yes" : "no" };
    }
    case "number": {
      const value = typeof supplied === "number" ? supplied : Number(String(supplied).trim());
      if (!Number.isFinite(value)) return { error: `"${field.name}" must be a number` };
      if (field.min !== undefined && value < field.min) {
        return { error: `"${field.name}" must be at least ${field.min}` };
      }
      if (field.max !== undefined && value > field.max) {
        return { error: `"${field.name}" must be at most ${field.max}` };
      }
      return { value: String(value) };
    }
    case "date": {
      const value = String(supplied).trim();
      if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return { error: `"${field.name}" must be a date like 2026-09-12` };
      }
      return { value };
    }
    case "select": {
      const value = String(supplied).trim();
      if (!field.options.includes(value)) {
        return { error: `"${field.name}" must be one of: ${field.options.join(", ")}` };
      }
      return { value };
    }
    case "line": {
      if (typeof supplied !== "string") return { error: `"${field.name}" must be text` };
      const value = supplied.trim();
      if (/[\r\n]/.test(value)) return { error: `"${field.name}" must be a single line` };
      if (hasControlCharacters(value)) return { error: `"${field.name}" contains a control character` };
      if ([...value].length > field.max) {
        return { error: `"${field.name}" is longer than ${field.max} characters` };
      }
      return { value };
    }
    case "text": {
      if (typeof supplied !== "string") return { error: `"${field.name}" must be text` };
      const value = supplied.replace(/\r\n?/g, "\n").trim();
      if (hasControlCharacters(value.replace(/\n/g, ""))) {
        return { error: `"${field.name}" contains a control character` };
      }
      if ([...value].length > field.max) {
        return { error: `"${field.name}" is longer than ${field.max} characters` };
      }
      return { value };
    }
    default:
      return { error: `"${field.name}" has an unknown type` };
  }
}

function hasControlCharacters(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

