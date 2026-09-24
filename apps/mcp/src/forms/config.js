import {
  FORM_ID_RE,
  LAYOUTS,
  SUBMIT_ROLES,
  VOTE_MODES,
  NOTIFY_RE,
  MAX_FIELDS,
  FIELD_KEYS,
  FIELD_NAME_RE,
  RESERVED_FIELD_NAMES,
  FIELD_TYPES,
  MAX_LINE_CAP,
  MAX_TEXT_CAP,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
} from "./grammar.js";

/* ------------------------------ the config ------------------------------- */

export function normalizeConfig(raw, fieldMaps) {
  const id = raw.get("id");
  if (typeof id !== "string" || !id) return { error: '"id" is required' };
  if (!FORM_ID_RE.test(id)) {
    return { error: '"id" must be lowercase letters, digits and dashes (max 40)' };
  }

  const responses = raw.get("responses");
  if (typeof responses !== "string" || !responses) return { error: '"responses" is required' };
  if (!responses.endsWith(".md")) return { error: '"responses" must be a path ending in .md' };

  const layout = raw.get("layout");
  if (typeof layout !== "string" || !layout) {
    return { error: '"layout" is required — use table or sections' };
  }
  if (!LAYOUTS.has(layout)) return { error: '"layout" must be table or sections' };

  const submit = raw.has("submit") ? raw.get("submit") : "member";
  if (!SUBMIT_ROLES.has(submit)) return { error: '"submit" must be member, editor or owner' };

  const editOwn = raw.has("edit_own") ? parseBool(raw.get("edit_own")) : true;
  if (editOwn === null) return { error: '"edit_own" must be true or false' };

  const showResponses = raw.has("show_responses")
    ? parseBool(raw.get("show_responses"))
    : false;
  if (showResponses === null) return { error: '"show_responses" must be true or false' };

  const votes = raw.has("votes") ? raw.get("votes") : "off";
  if (!VOTE_MODES.has(votes)) return { error: '"votes" must be named or off' };

  /*
    Absent means nobody is told, and absent is the default. A key that had to
    be written out as `notify: nobody` to mean "no mail" would make every form
    already in a customer's bucket ambiguous the day this shipped.
  */
  const notify = raw.has("notify") ? raw.get("notify") : null;
  if (notify !== null && (typeof notify !== "string" || !NOTIFY_RE.test(notify))) {
    return {
      error: '"notify" must be owner or a handle such as @dan — never an email address',
    };
  }

  if (!raw.has("fields")) return { error: '"fields" is required' };
  if (!fieldMaps.length) return { error: "a form needs at least one field" };
  if (fieldMaps.length > MAX_FIELDS) return { error: `a form takes at most ${MAX_FIELDS} fields` };

  const fields = [];
  const seen = new Set();
  for (const map of fieldMaps) {
    const field = normalizeField(map);
    if (field.error) return field;
    if (seen.has(field.name)) return { error: `two fields are called "${field.name}"` };
    seen.add(field.name);
    fields.push(field);
  }

  return {
    config: {
      id,
      responses,
      layout,
      submit,
      edit_own: editOwn,
      show_responses: showResponses,
      votes,
      // Present only when declared, so `"notify" in config` is the question
      // "does this form tell anybody", asked in one way everywhere.
      ...(notify === null ? {} : { notify }),
      fields,
    },
  };
}

function normalizeField(map) {
  for (const key of map.keys()) {
    if (!FIELD_KEYS.has(key)) {
      return { error: `unknown key "${key}" (accepted: ${[...FIELD_KEYS].join(", ")})` };
    }
  }
  const name = map.get("name");
  if (typeof name !== "string" || !name) return { error: '"name" is required' };
  if (!FIELD_NAME_RE.test(name)) {
    return { error: `"${name}" must be lowercase letters, digits and underscores, starting with a letter` };
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    return { error: `"${name}" is a column this gateway writes; choose another name` };
  }

  const type = map.get("type");
  if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
    return { error: `"${name}": type must be one of ${[...FIELD_TYPES.keys()].join(", ")}` };
  }
  const spec = FIELD_TYPES.get(type);
  const field = { name, type, required: false };

  if (map.has("required")) {
    const required = parseBool(map.get("required"));
    if (required === null) return { error: `"${name}": required must be true or false` };
    field.required = required;
  }

  if (spec.needsMax) {
    if (!map.has("max")) {
      return { error: `"${name}": a ${type} field needs max, so a submission cannot be unbounded` };
    }
    const cap = Number(map.get("max"));
    const ceiling = type === "text" ? MAX_TEXT_CAP : MAX_LINE_CAP;
    if (!Number.isInteger(cap) || cap < 1 || cap > ceiling) {
      return { error: `"${name}": max must be a whole number from 1 to ${ceiling}` };
    }
    field.max = cap;
  } else if (map.has("max") && type !== "number") {
    return { error: `"${name}": max applies to line, text and number fields only` };
  }

  if (type === "select") {
    const options = map.get("options");
    if (!Array.isArray(options) || !options.length) {
      return { error: `"${name}": a select field needs options: [a, b, …]` };
    }
    if (options.length > MAX_OPTIONS) {
      return { error: `"${name}": at most ${MAX_OPTIONS} options` };
    }
    if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
      return { error: `"${name}": an option may be at most ${MAX_OPTION_LENGTH} characters` };
    }
    if (options.some((option) => /[\r\n|]/.test(option))) {
      return { error: `"${name}": an option may not contain a newline or a pipe` };
    }
    if (new Set(options).size !== options.length) {
      return { error: `"${name}": two options are the same` };
    }
    field.options = options;
  } else if (map.has("options")) {
    return { error: `"${name}": options applies to a select field only` };
  }

  if (type === "number") {
    for (const bound of ["min", "max"]) {
      if (!map.has(bound)) continue;
      const value = Number(map.get(bound));
      if (!Number.isFinite(value)) return { error: `"${name}": ${bound} must be a number` };
      field[bound] = value;
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      return { error: `"${name}": min is greater than max` };
    }
  } else if (map.has("min")) {
    return { error: `"${name}": min applies to a number field only` };
  }

  return field;
}

function parseBool(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * A checkbox ANSWER's two words — which are not the block grammar's two words.
 *
 * `parseBool` reads the form *declaration*: `required: true`, `edit_own:
 * false`. That vocabulary is a stable storage format and is deliberately not
 * widened here.
 *
 * A checkbox answer is a different value in a different file. It is **stored**
 * as `yes`/`no` — that is what `renderResponsesFile` writes and what somebody
 * reads in the answers note — so `yes`/`no` is what it must accept. It did
 * not: `validateSubmission` sent the answer through `parseBool`, which knows
 * only `true`/`false`, while the console's own form widget submits `yes`/`no`.
 * Every form carrying a checkbox was therefore unanswerable from the console,
 * with a refusal naming two words nothing in the product shows.
 *
 * Both pairs are accepted, because an answer that came back out of the file
 * and an answer typed as `true` are both somebody meaning the same thing, and
 * the round trip through the responses file has to close.
 */
export function parseAnswerBool(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  if (word === "true" || word === "yes") return true;
  if (word === "false" || word === "no") return false;
  return null;
}

