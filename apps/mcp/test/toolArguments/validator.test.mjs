/**
 * Sections 1 and 2 of the original file: the argument validator on its own —
 * what it refuses, names a reader cannot tell apart, shapes that cost CPU —
 * and what it costs per call.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import {
  describeName,
  validateArguments,
  VALIDATION_NODE_BUDGET,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentValidatorChecks(check) {
  /* ====================== 1. the validator on its own ==================== */

  const NOTE_SCHEMA = {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      visibility: { type: "string", enum: ["private", "team"] },
      limit: { type: "integer", minimum: 1, maximum: 25 },
      dry_run: { type: "boolean" },
      moves: {
        type: "array",
        items: {
          type: "object",
          properties: { source: { type: "string" }, destination: { type: "string" } },
          required: ["source", "destination"],
          additionalProperties: false,
        },
      },
    },
    required: ["path"],
    additionalProperties: false,
  };

  check(
    "a call that matches the schema is accepted",
    validateArguments(NOTE_SCHEMA, { path: "a.md", content: "x" }) === null
  );
  check(
    "an unknown property is refused, and the refusal names it",
    (validateArguments(NOTE_SCHEMA, { path: "a.md", workspaceId: "ws_x" }) || "").startsWith(
      'unknown argument "workspaceId"'
    )
  );
  check(
    "...and says what the tool does take, which is already public in tools/list",
    (validateArguments(NOTE_SCHEMA, { path: "a.md", workspaceId: "ws_x" }) || "").includes(
      "permitted here: path, content, visibility, limit, dry_run, moves"
    )
  );
  check(
    "...and never the value that was sent with it",
    !(validateArguments(NOTE_SCHEMA, { path: "a.md", passphrase: "hunter2" }) || "").includes(
      "hunter2"
    )
  );
  check(
    "a missing required property is refused",
    validateArguments(NOTE_SCHEMA, { content: "x" }) === 'missing required argument "path"'
  );
  check(
    "an unknown property is refused before a missing required one",
    (validateArguments(NOTE_SCHEMA, { workspaceId: "ws_x" }) || "").startsWith("unknown argument")
  );
  check(
    "a wrong type is refused, naming the property and what it should be",
    validateArguments(NOTE_SCHEMA, { path: 7 }) === 'argument "path" must be a string, not number'
  );
  check(
    "an object where a string belongs is refused without being walked into",
    validateArguments(NOTE_SCHEMA, { path: { $ne: null } }) ===
      'argument "path" must be a string, not object'
  );
  check(
    "an array where a string belongs is refused, and says array rather than object",
    validateArguments(NOTE_SCHEMA, { path: ["a.md"] }) ===
      'argument "path" must be a string, not array'
  );
  check(
    "null is refused for a typed property rather than read as absent",
    validateArguments(NOTE_SCHEMA, { path: null }) ===
      'argument "path" must be a string, not null'
  );
  check(
    "a value outside an enum is refused, and the permitted set is named",
    validateArguments(NOTE_SCHEMA, { path: "a.md", visibility: "public" }) ===
      'argument "visibility" must be one of: private, team'
  );
  check(
    "an integer bound is enforced in both directions",
    validateArguments(NOTE_SCHEMA, { path: "a.md", limit: 99 }) ===
      'argument "limit" must be at most 25' &&
      validateArguments(NOTE_SCHEMA, { path: "a.md", limit: 0 }) ===
        'argument "limit" must be at least 1'
  );
  check(
    "a non-integer number is not an integer",
    validateArguments(NOTE_SCHEMA, { path: "a.md", limit: 2.5 }) ===
      'argument "limit" must be an integer, not number'
  );
  check(
    "a boolean property does not accept the string 'true'",
    validateArguments(NOTE_SCHEMA, { path: "a.md", dry_run: "true" }) ===
      'argument "dry_run" must be a boolean, not string'
  );
  check(
    "an unknown property one level down is refused, addressed by its position",
    validateArguments(NOTE_SCHEMA, {
      path: "a.md",
      moves: [{ source: "a.md", destination: "b.md", workspaceId: "ws_x" }],
    }) === 'unknown argument "moves[0].workspaceId"; permitted here: source, destination'
  );
  check(
    "a required property missing one level down is refused the same way",
    validateArguments(NOTE_SCHEMA, { path: "a.md", moves: [{ source: "a.md" }] }) ===
      'missing required argument "moves[0].destination"'
  );
  check(
    "a wrong type inside an array element is refused",
    validateArguments(NOTE_SCHEMA, {
      path: "a.md",
      moves: [{ source: "a.md", destination: 7 }],
    }) === 'argument "moves[0].destination" must be a string, not number'
  );
  check(
    "arguments that are not an object at all are refused",
    validateArguments(NOTE_SCHEMA, ["path"]) === "arguments must be a JSON object, not array" &&
      validateArguments(NOTE_SCHEMA, "path") === "arguments must be a JSON object, not string"
  );
  check(
    "absent arguments are an empty object, not a refusal",
    validateArguments({ type: "object", properties: {}, additionalProperties: false }, undefined) ===
      null &&
      validateArguments({ type: "object", properties: {}, additionalProperties: false }, null) ===
        null
  );
  check(
    "a tool that takes nothing says so rather than listing an empty set",
    validateArguments({ type: "object", properties: {}, additionalProperties: false }, {
      workspaceId: "ws_x",
    }) === 'unknown argument "workspaceId"; this takes no arguments'
  );
  check(
    "a property inherited from Object.prototype is not a declared property",
    (validateArguments(NOTE_SCHEMA, { path: "a.md", constructor: "x" }) || "").startsWith(
      'unknown argument "constructor"'
    ) &&
      (validateArguments(NOTE_SCHEMA, { path: "a.md", __proto__: null, toString: "x" }) || "").startsWith(
        'unknown argument "toString"'
      )
  );

  /* --------- names that differ only in a way a reader cannot see --------- */

  check(
    "a property whose name differs only by case is a different property",
    (validateArguments(NOTE_SCHEMA, { Path: "a.md" }) || "").startsWith('unknown argument "Path"')
  );
  // Built from a code point rather than typed, for the reason
  // `docs/decisions/testing.md` gives about invisible characters in fixtures:
  // this is a Cyrillic small letter A standing in for the ASCII one.
  const CONFUSABLE_PATH = `p${String.fromCharCode(0x0430)}th`;
  const confusable = validateArguments(NOTE_SCHEMA, { [CONFUSABLE_PATH]: "a.md" }) || "";
  check(
    "a property whose name differs only by a Unicode confusable is a different property",
    confusable.startsWith("unknown argument")
  );
  check(
    "...and the refusal spells it out rather than echoing bytes that look correct",
    confusable.includes('"p\\u0430th"') && !confusable.includes(CONFUSABLE_PATH)
  );
  const ZERO_WIDTH_PATH = `path${String.fromCharCode(0x200b)}`;
  const zeroWidth = validateArguments(NOTE_SCHEMA, { [ZERO_WIDTH_PATH]: "a.md" }) || "";
  check(
    "a name with a trailing zero-width space is refused, and the refusal is readable",
    zeroWidth.startsWith("unknown argument") && zeroWidth.includes('"path\\u200b"')
  );
  check(
    "describeName escapes a bidi override rather than passing it into a message",
    describeName(`a${String.fromCharCode(0x202e)}b`) === '"a\\u202eb"' &&
      !describeName(`a${String.fromCharCode(0x202e)}b`).includes(String.fromCharCode(0x202e))
  );
  check(
    "...and clips a name long enough to be a payload rather than a mistake",
    describeName("z".repeat(5000)).length < 80
  );

  /* ------------------- shapes that cost CPU rather than look wrong -------- */

  const deep = (depth) => {
    let node = "bottom";
    for (let i = 0; i < depth; i += 1) node = { nested: node };
    return node;
  };
  const deepStart = Date.now();
  const deepRefusal = validateArguments(NOTE_SCHEMA, { path: deep(20000) });
  const deepMs = Date.now() - deepStart;
  check(
    "a deeply nested value under a string property is refused by its type, not by walking it",
    deepRefusal === 'argument "path" must be a string, not object' && deepMs < 100
  );

  /*
    A literal count, not one derived from the exported budget.

    The first version of these two checks sized their fixtures at
    `VALIDATION_NODE_BUDGET * 3`, which made them measure the constant against
    itself: sabotaging the budget to `Infinity` did not fail them, it made
    `Array.from({length: Infinity})` throw and took the whole suite down with a
    RangeError. A fixture that moves with the thing it is guarding is not a
    guard. 60,000 is a number; the check below pins the budget itself, so
    raising it past these fixtures is a visible change rather than a silent
    one.
  */
  const OVER_BUDGET = 60000;
  check(
    "the work budget is the one this file's fixtures are sized against",
    VALIDATION_NODE_BUDGET === 10000 && VALIDATION_NODE_BUDGET < OVER_BUDGET
  );
  const hugeArray = Array.from({ length: OVER_BUDGET }, () => ({
    source: "a.md",
    destination: "b.md",
  }));
  const hugeStart = Date.now();
  const hugeRefusal = validateArguments(NOTE_SCHEMA, { path: "a.md", moves: hugeArray });
  const hugeMs = Date.now() - hugeStart;
  check(
    "an array far past the work budget is refused rather than walked to the end",
    hugeRefusal === "arguments are too large to check" && hugeMs < 250
  );
  const wideObject = { path: "a.md" };
  for (let i = 0; i < OVER_BUDGET; i += 1) wideObject[`k${i}`] = i;
  const wideStart = Date.now();
  const wideRefusal = validateArguments(NOTE_SCHEMA, wideObject);
  check(
    // Refused at the first unknown key rather than after sixty thousand of
    // them, which is the property worth having: the budget is the backstop for
    // the case where the keys are all legal and the values are not.
    "an object with tens of thousands of keys is refused at the first one",
    typeof wideRefusal === "string" && Date.now() - wideStart < 100
  );
  const BOUNDED_ARRAY = {
    type: "object",
    properties: { moves: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } },
    required: ["moves"],
    additionalProperties: false,
  };
  check(
    "an advertised array bound is enforced, at both ends",
    validateArguments(BOUNDED_ARRAY, { moves: [] }) ===
      'argument "moves" must have at least 1 item' &&
      validateArguments(BOUNDED_ARRAY, { moves: Array.from({ length: 101 }, () => "a") }) ===
        'argument "moves" must have at most 100 items'
  );
  const boundedStart = Date.now();
  const boundedHuge = validateArguments(BOUNDED_ARRAY, {
    moves: Array.from({ length: 200000 }, () => "a"),
  });
  check(
    "...before its contents are walked, so an oversized batch costs one comparison",
    boundedHuge === 'argument "moves" must have at most 100 items' &&
      Date.now() - boundedStart < 100
  );
  check(
    "the largest batch the gateway actually permits is comfortably inside the budget",
    validateArguments(NOTE_SCHEMA, {
      path: "a.md",
      moves: Array.from({ length: 100 }, (_, n) => ({
        source: `${n}.md`,
        destination: `${n}-moved.md`,
      })),
    }) === null
  );

  /* ====================== 2. what it costs per call ====================== */

  const COST_ITERATIONS = 20000;
  const costArgs = { path: "1-projects/a.md", content: "# hello\n", visibility: "team" };
  const costStart = Date.now();
  for (let i = 0; i < COST_ITERATIONS; i += 1) validateArguments(NOTE_SCHEMA, costArgs);
  const costMs = Date.now() - costStart;
  check(
    `validating a typical write costs under 10 microseconds (${(
      (costMs * 1000) /
      COST_ITERATIONS
    ).toFixed(2)}us measured over ${COST_ITERATIONS})`,
    (costMs * 1000) / COST_ITERATIONS < 10
  );
}
