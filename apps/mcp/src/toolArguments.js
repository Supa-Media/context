/**
 * Tool-call arguments, checked against the schema the gateway advertised.
 *
 * `tools/list` publishes an `inputSchema` for every tool. Until this file
 * existed nothing enforced one: `callTool` took the whole arguments object and
 * each handler read the properties it happened to know about, so the only
 * reason "this tool takes no arguments" was true of `export_encryption_keys`
 * is that its two implementing functions do not declare an `args` parameter.
 * An argument the schema does not describe reached a handler unexamined, and
 * the callers here are AI clients driven by text other people wrote — an email
 * body, a meeting transcript, a shared note. Extra properties are how a
 * prompt-injected client turns a read into something else, and the schema is
 * the only place that says what a tool actually takes.
 *
 * **Written by hand, against the subset the tools use.** The gateway takes no
 * npm dependencies and runs on the Workers runtime; a JSON Schema library is
 * neither available nor wanted for a handful of keywords. What the tool
 * definitions in `index.js` actually use, and therefore all this supports:
 *
 *   - `type: "object"` with `properties`, `required` and
 *     `additionalProperties: false` — at the root and, for `move_notes`, one
 *     level down inside `items`.
 *   - property types `string`, `boolean`, `integer`, `array`, `object`.
 *   - `enum` on strings, `minimum`/`maximum` on integers, `items` on arrays.
 *
 * A keyword a schema uses and this file does not know is a silent hole, so
 * `unsupportedKeywords` names them and the census test fails the build rather
 * than letting a schema quietly mean less than it says.
 *
 * **The refusal is about the caller's own request and nothing else.** No
 * message here reads storage, names a workspace, or varies with what exists:
 * every string it can produce is a function of the arguments the caller sent
 * and the schema that is already public in `tools/list`. That is what makes
 * `{path: "x.md", workspaceId: "…"}` refused identically whether that
 * workspace exists or not — the refusal happens before anything is looked up.
 */

/**
 * How much of an arguments object this will walk before giving up.
 *
 * Not a business rule — `move_notes` has its own `BATCH_MOVE_CAP`, and
 * duplicating it here would give two numbers that can drift. This is a work
 * budget, so that a caller cannot spend the Worker's CPU inside the validator
 * with a million-element array or an object with a million keys. Every key
 * examined and every array element entered costs one unit. The largest legal
 * call today is a 100-move batch at three properties each, a little over 400
 * units; 10,000 leaves two orders of magnitude of headroom and still refuses
 * in microseconds.
 *
 * Recursion depth needs no separate ceiling: the walk is driven by the schema,
 * never by the value, so it can only descend where a schema says `object` or
 * `array` — and the deepest schema here is two levels. A value nested a
 * thousand deep under a property declared `string` fails one `typeof` check
 * without ever being entered.
 */
export const VALIDATION_NODE_BUDGET = 10000;

/** The message a caller gets when its arguments outrun that budget. */
const TOO_LARGE = "arguments are too large to check";

/** The keywords this validator implements. Anything else is a hole. */
const KNOWN_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "description",
  "title",
  "default",
]);

/**
 * Every schema keyword in `schema` this file would ignore.
 *
 * The census test asserts this is empty across all advertised tools. Adding
 * `pattern` or `minLength` to a tool definition without teaching this file
 * about it would otherwise advertise a constraint nothing enforces, which is
 * worse than not advertising it: a reviewer reads the schema and believes it.
 */
export function unsupportedKeywords(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [...seen];
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) seen.add(key);
  }
  for (const child of Object.values(schema.properties || {})) {
    unsupportedKeywords(child, seen);
  }
  if (schema.items) unsupportedKeywords(schema.items, seen);
  return [...seen];
}

/**
 * A caller-supplied name, rendered so a reviewer and an agent can both read it.
 *
 * Two reasons this is not plain interpolation. A property name arrives from a
 * client driven by somebody else's text, so it can carry control characters,
 * bidi overrides or zero-width joiners that would make the refusal itself
 * unreadable — `docs/decisions/testing.md`'s "an invisible character in source
 * is a fixture nobody can review", one layer out. And the attack this guard is
 * for includes a name that differs from a real one only by a confusable, where
 * echoing the bytes back verbatim produces a message that appears to complain
 * about the correct spelling. Everything outside printable ASCII is escaped,
 * so a Cyrillic a in place of an ASCII one comes back as `\u0430` and the
 * caller can see what it actually sent.
 */
export function describeName(name) {
  const text = typeof name === "string" ? name : String(name);
  const clipped = text.length > 64 ? `${text.slice(0, 64)}...` : text;
  let out = "";
  for (const char of clipped) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e && char !== '"' && char !== "\\") {
      out += char;
    } else if (code > 0xffff) {
      out += `\\u{${code.toString(16)}}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return `"${out}"`;
}

/** The type name to say in a refusal, for a value of unknown shape. */
function typeNameOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `a string`, `an integer` — the article the message needs. */
function withArticle(type) {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/** Does `value` satisfy the JSON Schema `type` keyword `expected`? */
function matchesType(expected, value) {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      // A schema with no `type` constrains nothing; that is the schema's
      // choice, not a gap here.
      return true;
  }
}

/**
 * Check one value against one schema.
 *
 * Returns `null` when it is acceptable, or a sentence naming what is wrong.
 * `path` is the raw, unescaped address of this value — `path`,
 * `moves[0].source` — and is escaped once, at the moment a message is built.
 */
function checkValue(schema, value, path, budget) {
  if (budget.spent > VALIDATION_NODE_BUDGET) return TOO_LARGE;

  if (schema.type && !matchesType(schema.type, value)) {
    return `argument ${describeName(path)} must be ${withArticle(schema.type)}, not ${typeNameOf(value)}`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    // The permitted values are already in `tools/list`; repeating them here
    // discloses nothing and saves the caller a round trip.
    return `argument ${describeName(path)} must be one of: ${schema.enum.join(", ")}`;
  }

  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    return `argument ${describeName(path)} must be at least ${schema.minimum}`;
  }
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) {
    return `argument ${describeName(path)} must be at most ${schema.maximum}`;
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      budget.spent += 1;
      if (budget.spent > VALIDATION_NODE_BUDGET) return TOO_LARGE;
      const failure = checkValue(schema.items, value[i], `${path}[${i}]`, budget);
      if (failure) return failure;
    }
  }

  if (schema.type === "object" && schema.properties) {
    return checkObject(schema, value, path, budget);
  }

  return null;
}

/**
 * Check an object against an object schema: unknown out, required in, types.
 *
 * The order is deliberate. Unknown properties are refused first, because that
 * is the finding this file exists for and because a call carrying one should
 * never be told anything else about itself — an argument the schema does not
 * describe is not a nearly-right call, it is a different call.
 */
function checkObject(schema, value, path, budget) {
  const properties = schema.properties || {};
  const permitted = Object.keys(properties);
  const allowsExtra = schema.additionalProperties !== false;

  if (!allowsExtra) {
    for (const key of Object.keys(value)) {
      budget.spent += 1;
      if (budget.spent > VALIDATION_NODE_BUDGET) return TOO_LARGE;
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      const name = describeName(path ? `${path}.${key}` : key);
      return permitted.length
        ? `unknown argument ${name}; permitted here: ${permitted.join(", ")}`
        : `unknown argument ${name}; this takes no arguments`;
    }
  }

  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      return `missing required argument ${describeName(path ? `${path}.${key}` : key)}`;
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (value[key] === undefined) continue;
    const failure = checkValue(propertySchema, value[key], path ? `${path}.${key}` : key, budget);
    if (failure) return failure;
  }

  return null;
}

/**
 * Validate a tool call's arguments against that tool's advertised schema.
 *
 * `args` is what the client sent, before anything is stripped from it: the
 * addressing argument `context` is part of what was advertised (see
 * `CONTEXT_ARGUMENT` in `index.js`) and is checked like any other property, so
 * the two tools that deliberately do not advertise it — ChatGPT's `search` and
 * `fetch`, whose schema is somebody else's contract — refuse it like any other
 * property they do not take.
 *
 * Returns `null` when the call may proceed, or the sentence to refuse it with.
 * Absent arguments are an empty object: a client that omits `arguments`
 * entirely on a tool that requires nothing is a normal, correct client, and
 * every era of the MCP spec lets it.
 */
export function validateArguments(schema, args) {
  const supplied = args === undefined || args === null ? {} : args;
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    return `arguments must be a JSON object, not ${typeNameOf(supplied)}`;
  }
  if (!schema || typeof schema !== "object") return null;
  return checkObject(schema, supplied, "", { spent: 0 });
}
