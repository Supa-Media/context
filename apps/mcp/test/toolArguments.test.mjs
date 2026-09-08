/**
 * The arguments of a tool call, against the schema the gateway advertised.
 *
 * This suite exists because of what an adversarial review of the encryption
 * key export found: the reviewer was checking whether `export_encryption_keys`
 * could be pointed at another workspace by supplying that workspace's
 * identifiers, and the only reason "this tool takes no arguments" was true is
 * that its two implementing functions do not declare an `args` parameter.
 * Nothing enforced the `inputSchema` the gateway publishes in `tools/list`.
 *
 * That is a property of the dispatch path, not of one tool, and the callers
 * are AI clients driven by text other people wrote. So there are three kinds
 * of check here and they answer three different questions:
 *
 *   - **The validator itself** — does it refuse what it claims to refuse, on
 *     the JSON Schema subset the tool definitions use, including the shapes
 *     that cost CPU rather than the ones that look wrong.
 *   - **The census** — is every tool in the dispatch table actually covered.
 *     Read out of the source, so a tool added next year cannot skip the
 *     validator by being added in the obvious place. `docs/decisions/testing.md`:
 *     a guard nobody has checked is not a guard, and one that checks a list
 *     somebody has to remember to update is checking the list.
 *   - **The attack** — another workspace's identifiers smuggled onto every
 *     tool the gateway offers, and the refusal that answers it disclosing
 *     nothing about whether that workspace exists.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured
 * rather than as expected:
 *
 * 1. **The validator call is deleted from `callToolForSession`** — 30 checks
 *    failed: 26 here, and 4 elsewhere that were written against the old
 *    behaviour and now depend on the new one, including both halves of the
 *    smuggled-argument attack in `encryptionGateway.test.mjs` and the
 *    passphrase a client volunteered.
 * 2. **`additionalProperties` is ignored** (the unknown-property loop is
 *    skipped) — 32 checks failed. The census still passed, and that is the
 *    point of having both: the census asks whether every tool is *reached*,
 *    never what the validator then does.
 * 3. **The `required` loop is removed** — 3 checks failed, including
 *    `read_image` called without a note over in `test.mjs`.
 * 4. **Type checking is removed** — 10 checks failed.
 * 5. **The node budget is raised a ten-thousandfold** — 2 checks failed: the
 *    oversized array, and the check that pins the budget itself. The first
 *    attempt at this sabotage set it to `Infinity` and failed *nothing*,
 *    because the fixtures were sized at `VALIDATION_NODE_BUDGET * 3` and threw
 *    a RangeError instead; that is recorded in the fixture below rather than
 *    quietly fixed, because it is the same lesson as rule 4 of
 *    `scripts/check-no-identifiers.mjs`.
 * 6. **The masked-tool skip is removed**, so a masked tool is validated like
 *    any other — 2 checks failed, both existence-oracle ones: a team-tier
 *    caller could tell `export_encryption_keys` from an invented name by the
 *    shape of the complaint.
 * 7. **The census's dispatch-table parser is pointed at a function that does
 *    not exist** — 1 check failed, the parser's own self-test, which is the
 *    only thing standing between a census and a regex that matches nothing.
 *
 * Re-measured by an adversarial review, which reproduced all seven counts
 * exactly and confirmed that sabotage 5 at `Infinity` now fails 2 checks
 * rather than throwing a RangeError. Five more, for the checks that review
 * added:
 *
 * 8. **A `case` is added to the dispatch table for a tool nothing advertises**
 *    — 1 check failed, "every tool in the dispatch table has an advertised
 *    inputSchema".
 * 9. **A second dispatch site is added**, the modern era calling `callTool`
 *    directly — 5 checks failed: "exactly one place a tool is dispatched
 *    from", the new modern-era argument check, and three pre-existing
 *    cross-era ones in `crossContext.test.mjs`.
 * 10. **A `case` label is made a constant rather than a literal** — 1 check
 *    failed, and it names the identifier. Without it the census silently stops
 *    counting that tool, which is the hole the change adding this file named.
 * 11. **`additionalProperties: false` is removed from `move_notes`' element
 *    schema** — 2 checks failed, and only one of them is behavioural: the
 *    census names the node (`move_notes.moves[]`), which is what a *new*
 *    array-of-objects tool with the same mistake would get, having no
 *    behavioural test of its own.
 * 12. **`hasOwnProperty.call` becomes a bare `key in properties`** — 2 checks
 *    failed, including `__proto__` sent as bytes over the wire.
 */

import { readFile } from "node:fs/promises";

import worker from "../src/index.js";
import { META_PROTOCOL_VERSION, MODERN_PROTOCOLS } from "../src/protocol.js";
import {
  describeName,
  unsupportedKeywords,
  validateArguments,
  VALIDATION_NODE_BUDGET,
} from "../src/toolArguments.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-tool-arguments.test";

const TOKEN_OWNER = `cat_args_owner_${"0".repeat(26)}`;
const TOKEN_TEAM = `cat_args_team_${"0".repeat(27)}`;

/** The workspace this connection owns, and the one it has nothing to do with. */
const WORKSPACE_MINE = "ws_args_mine";
const WORKSPACE_OTHER = "ws_args_other";
const WORKSPACE_SHARED = "ws_args_shared";

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true },
    status: "active",
  };
}

async function rpc(env, tokenValue, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One tool call. `args` of `undefined` sends no `arguments` member at all,
 * which is what a client calling a tool that requires nothing actually does.
 */
async function callTool(env, tokenValue, name, args) {
  const params = args === undefined ? { name } : { name, arguments: args };
  return (await rpc(env, tokenValue, "tools/call", params))?.result;
}

/**
 * The same call on the modern transport, which is a different function.
 *
 * `docs/decisions/gateway-protocol.md`, "authority is decided once, never per
 * protocol era": both eras reach `callToolForSession`, and the reason that
 * matters is that a control implemented on one path only is a control an
 * attacker reaches by adding a header. Every check above rides the legacy
 * path — no `MCP-Protocol-Version`, so `handleLegacyMcp` answers it — so the
 * modern one needs asking too, and it is not a copy-paste of the legacy body:
 * it requires the version in a header *and* in `params._meta`, plus the
 * method and the tool name in headers of their own (`modernHeaderMismatch`).
 */
async function callToolModern(env, tokenValue, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOLS[0],
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          ...(args === undefined ? {} : { arguments: args }),
          _meta: { [META_PROTOCOL_VERSION]: MODERN_PROTOCOLS[0] },
        },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text)?.result;
  } catch {
    return null;
  }
}

/**
 * One tool call sent as raw bytes, for the shapes `JSON.stringify` cannot make.
 *
 * A JavaScript object literal cannot hold two properties of the same name, and
 * `JSON.stringify` turns a number too large for a double into `null` and a
 * lone surrogate into a replacement character. Those are exactly the shapes a
 * hostile client sends, so they have to be written as text.
 */
async function callToolRaw(env, tokenValue, name, argumentsJson) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
      body:
        `{"jsonrpc":"2.0","id":1,"method":"tools/call",` +
        `"params":{"name":"${name}","arguments":${argumentsJson}}}`,
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text)?.result;
  } catch {
    return null;
  }
}

const textOf = (result) => result?.content?.[0]?.text || "";

/* -------------------------------------------------------------------------- */
/*  Building a call that is valid apart from the thing under test              */
/* -------------------------------------------------------------------------- */

/** A value that satisfies one property schema, for probing. */
function sampleValue(name, schema) {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return /path|source|destination|note$|^note|image|id$/.test(name)
        ? "1-projects/probe.md"
        : "probe";
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return [sampleObject(schema.items || {})];
    case "object":
      return sampleObject(schema);
    default:
      return "probe";
  }
}

/** The required half of an object schema, filled in with sample values. */
function sampleObject(schema) {
  const out = {};
  for (const key of schema.required || []) {
    out[key] = sampleValue(key, (schema.properties || {})[key] || { type: "string" });
  }
  return out;
}

/**
 * Another workspace's identifiers, in every name these routes could grow.
 *
 * Deliberately the same shape `encryptionGateway.test.mjs` uses for the two
 * encryption tools, applied here to every tool the gateway offers — because
 * the finding was never about those two.
 */
const SMUGGLED = {
  workspaceId: WORKSPACE_OTHER,
  workspace_id: WORKSPACE_OTHER,
  workspace: "@other",
  slug: "other",
  bucket: "args-other",
  scope: "private",
  visibility_override: "team",
};

/** The same, naming a workspace that has never existed anywhere. */
const SMUGGLED_AT_NOBODY = {
  workspaceId: "ws_no_such_workspace_at_all",
  workspace_id: "ws_no_such_workspace_at_all",
  workspace: "@no-such-context-anywhere",
  slug: "no-such-context-anywhere",
  bucket: "args-no-such-bucket",
  scope: "private",
  visibility_override: "team",
};

/* -------------------------------------------------------------------------- */

export async function runToolArgumentChecks(check) {
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

  /* ================== 3. the census, read out of the source =============== */

  const SOURCE = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

  /** The body of one top-level function, by name. */
  function functionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) return "";
    const end = source.indexOf("\n}\n", start);
    return end === -1 ? "" : source.slice(start, end);
  }

  const dispatchBody = functionBody(SOURCE, "async function callTool(name, args, store, scope)");
  const dispatched = [...dispatchBody.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1]);
  // The parser's own self-test. A census built on a regex that silently
  // matched nothing would pass every check below by finding no tools at all,
  // which is the failure mode `docs/decisions/testing.md` was written about.
  check(
    "the dispatch-table parser finds the switch it is aimed at",
    dispatched.length >= 25 &&
      dispatched.includes("orient") &&
      dispatched.includes("export_encryption_keys") &&
      !dispatched.includes("no_such_tool_anywhere")
  );

  /*
    Every case in that switch is a literal name, which is what makes reading
    them off the source a census rather than a sample.

    This is the one hole the change that added this file named and left open:
    the parser above matches `case "some_name":`, so a case whose label is a
    variable or a template string dispatches a tool the census never sees, and
    every check below would pass while saying nothing about it. Nothing in the
    tree does that today, and the cheapest way to keep it that way is to
    require every label in the block to be a lowercase string literal rather
    than to hope. A `case name:` fails here, in the same run that would
    otherwise have silently stopped counting it.
  */
  const caseLabels = [...dispatchBody.matchAll(/^\s*case ([^\n]*):$/gm)].map((m) => m[1].trim());
  const computedCases = caseLabels.filter((label) => !/^"[a-z_]+"$/.test(label));
  check(
    `every case in the dispatch table is a literal name the census can read (${computedCases.join(", ")})`,
    caseLabels.length === dispatched.length && computedCases.length === 0
  );

  const aliasBlock = SOURCE.slice(
    SOURCE.indexOf("const TOOL_NAME_ALIASES"),
    SOURCE.indexOf("const TOOL_NAME_ALIASES") + 400
  );
  const aliases = new Map(
    [...aliasBlock.matchAll(/\["([a-z_]+)",\s*"([a-z_]+)"\]/g)].map((m) => [m[1], m[2]])
  );
  check(
    "the alias table is read, and holds the one unlisted name still dispatched",
    aliases.get("archive_chat") === "save_context"
  );

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  };

  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  try {
    controlPlane.addWorkspace(WORKSPACE_MINE, "mine", s3Binding("args-mine", "AA"));
    controlPlane.addWorkspace(WORKSPACE_OTHER, "other", s3Binding("args-other", "BB"));
    // A context this person really is a member of, so a cross-context call can
    // get past routing and reach the validator. Without one, every `context`
    // argument in this file would be answered by the routing refusal and the
    // schema would never be asked.
    controlPlane.addWorkspace(WORKSPACE_SHARED, "shared", s3Binding("args-shared", "CC"));
    await controlPlane.addGrant({
      accessToken: TOKEN_OWNER,
      workspaceId: WORKSPACE_MINE,
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_args_owner",
      userId: "user_args_owner",
      alsoMemberOf: [{ workspaceId: WORKSPACE_SHARED, role: "member" }],
    });
    // A connection at team tier that can still write: `editor`, not `member`.
    // A `member` holds no write anywhere, and the unknown-tool path treats an
    // unrecognised name as writing, so a member would be refused for its scope
    // before the masking question could be asked at all.
    await controlPlane.addGrant({
      accessToken: TOKEN_TEAM,
      workspaceId: WORKSPACE_MINE,
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_args_team",
      userId: "user_args_team",
    });

    const mine = s3.bucketFor("args-mine");
    const other = s3.bucketFor("args-other");
    mine.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "m0" });
    mine.set("index.md", { body: "MINE-INDEX-MARKER", etag: "mi" });
    mine.set("1-projects/probe.md", { body: "MINE-MARKER", etag: "m1" });
    other.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "o0" });
    other.set("index.md", { body: "OTHER-INDEX-MARKER", etag: "oi" });
    other.set("1-projects/probe.md", { body: "OTHER-MARKER", etag: "o1" });
    const shared = s3.bucketFor("args-shared");
    shared.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "c0" });
    shared.set("index.md", { body: "SHARED-INDEX-MARKER", etag: "ci" });
    shared.set("1-projects/probe.md", { body: "SHARED-MARKER", etag: "c1" });

    const advertised = (await rpc(env, TOKEN_OWNER, "tools/list", {}))?.result?.tools || [];
    check("the owner's connection is offered the whole tool list", advertised.length >= 25);

    const schemas = new Map(advertised.map((tool) => [tool.name, tool.inputSchema]));

    /* ---- every dispatch case is advertised, and every schema is closed ---- */

    const uncovered = dispatched.filter((name) => !schemas.has(aliases.get(name) ?? name));
    check(
      "every tool in the dispatch table has an advertised inputSchema",
      uncovered.length === 0
    );
    const open = advertised.filter(
      (tool) =>
        tool.inputSchema?.type !== "object" || tool.inputSchema?.additionalProperties !== false
    );
    check(
      "every advertised schema is a closed object, so there is something to enforce",
      open.length === 0
    );
    const unsupported = advertised.flatMap((tool) => unsupportedKeywords(tool.inputSchema));
    check(
      "no advertised schema uses a keyword the validator would silently ignore",
      unsupported.length === 0
    );

    /*
      Closedness is checked at every object node, not only at the root.

      The root check above is the one that would have caught the finding this
      file exists for, and it is not the whole of the property: this validator
      enforces exactly what a schema says and nothing more, so an object node
      *below* the root that forgets `additionalProperties: false`, or that says
      `type: "object"` and never says which properties, accepts anything at all
      at that position — silently, and with `tools/list` still reading as
      though it were closed. `move_notes` already has such a node one level
      down; a second array-of-objects tool is the obvious next one, and the
      root check would say nothing about it. The two checks under this comment
      pin that the hole is real, so that nobody deletes the walk as belt and
      braces.
    */
    const openNodes = [];
    const barePropertyNodes = [];
    function walkNodes(schema, where) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
      if (schema.type === "object") {
        if (schema.additionalProperties !== false) openNodes.push(where);
        if (!schema.properties) barePropertyNodes.push(where);
      }
      for (const [key, child] of Object.entries(schema.properties || {})) {
        walkNodes(child, `${where}.${key}`);
      }
      if (schema.items) walkNodes(schema.items, `${where}[]`);
    }
    for (const tool of advertised) walkNodes(tool.inputSchema, tool.name);
    check(
      `every object node in every advertised schema is closed, not only the root (${openNodes.join(", ")})`,
      openNodes.length === 0
    );
    check(
      `...and says which properties it takes, so there is something to close over (${barePropertyNodes.join(", ")})`,
      barePropertyNodes.length === 0
    );
    check(
      "an object node that forgot `additionalProperties: false` really would take anything",
      validateArguments(
        {
          type: "object",
          additionalProperties: false,
          properties: {
            moves: {
              type: "array",
              items: { type: "object", properties: { source: { type: "string" } } },
            },
          },
        },
        { moves: [{ source: "a.md", workspaceId: "ws_x" }] }
      ) === null
    );
    check(
      "...and one that never said which properties it takes is not walked into at all",
      validateArguments(
        { type: "object", additionalProperties: false, properties: { opts: { type: "object" } } },
        { opts: { workspaceId: "ws_x" } }
      ) === null
    );

    /* ------------ and the validator is on the one path to a tool ---------- */

    const sessionBody = functionBody(
      SOURCE,
      "async function callToolForSession(params, store, session)"
    );
    check(
      "there is exactly one place a tool is dispatched from",
      (SOURCE.match(/await callTool\(/g) || []).length === 1 &&
        /await callTool\(/.test(sessionBody)
    );
    check(
      "...and the validator runs before it, on that path",
      sessionBody.indexOf("toolArgumentRefusal(") > -1 &&
        sessionBody.indexOf("toolArgumentRefusal(") < sessionBody.indexOf("await callTool(")
    );
    check(
      "...refusing the call rather than annotating it",
      /const badArguments = toolArgumentRefusal\([^)]*\);\s*if \(badArguments\) return toolError\(badArguments\);/.test(
        sessionBody
      )
    );

    /* ============= 4. the attack, on every tool that is offered ============ */

    let smuggledRefused = 0;
    let smuggledIdentical = 0;
    let leaked = 0;
    for (const tool of advertised) {
      const base = sampleObject(tool.inputSchema || {});
      const withOther = await callTool(env, TOKEN_OWNER, tool.name, { ...SMUGGLED, ...base });
      const withNobody = await callTool(env, TOKEN_OWNER, tool.name, {
        ...SMUGGLED_AT_NOBODY,
        ...base,
      });
      const text = textOf(withOther);
      if (withOther?.isError === true && text.startsWith('unknown argument "workspaceId"')) {
        smuggledRefused += 1;
      }
      if (text === textOf(withNobody)) smuggledIdentical += 1;
      if (
        text.includes("OTHER-MARKER") ||
        text.includes("OTHER-INDEX-MARKER") ||
        text.includes(WORKSPACE_OTHER) ||
        text.includes(WORKSPACE_MINE)
      ) {
        leaked += 1;
      }
    }
    check(
      `every offered tool refuses another workspace's identifiers (${smuggledRefused}/${advertised.length})`,
      smuggledRefused === advertised.length
    );
    check(
      "...identically whether that workspace exists or not",
      smuggledIdentical === advertised.length
    );
    check(
      "...and no refusal names a workspace, an id, or a note in one",
      leaked === 0
    );
    check(
      "nothing reached the other context's bucket while all of that was asked",
      other.get("1-projects/probe.md")?.body === "OTHER-MARKER" &&
        [...other.keys()].every((key) => !key.startsWith(".audit/"))
    );

    /* ------------------- the same, one tool at a time ---------------------- */

    const extraAlongsideValid = await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/probe.md",
      workspaceId: WORKSPACE_OTHER,
    });
    check(
      "an extra property alongside entirely valid ones refuses the whole call",
      extraAlongsideValid?.isError === true &&
        !textOf(extraAlongsideValid).includes("MINE-MARKER")
    );
    check(
      "...and the same call without it still works, so the check is not vacuous",
      textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "1-projects/probe.md" })).includes(
        "MINE-MARKER"
      )
    );
    check(
      "a wrong type on a read is refused",
      textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: { $gt: "" } })).includes(
        'argument "path" must be a string'
      )
    );
    check(
      "a wrong type on a write is refused, and nothing is written",
      textOf(
        await callTool(env, TOKEN_OWNER, "write_note", {
          path: "1-projects/typed.md",
          content: { markdown: "x" },
        })
      ).includes('argument "content" must be a string') && !mine.get("1-projects/typed.md")
    );
    check(
      "an unknown property on a write is refused, and nothing is written",
      textOf(
        await callTool(env, TOKEN_OWNER, "write_note", {
          path: "1-projects/smuggled.md",
          content: "# no\n",
          workspaceId: WORKSPACE_OTHER,
        })
      ).startsWith('unknown argument "workspaceId"') && !mine.get("1-projects/smuggled.md")
    );
    check(
      "a value outside an enum on a write is refused",
      textOf(
        await callTool(env, TOKEN_OWNER, "write_note", {
          path: "1-projects/enum.md",
          content: "# no\n",
          visibility: "public",
        })
      ) === 'argument "visibility" must be one of: private, team'
    );
    check(
      "a batch move carrying an extra property in one element is refused whole",
      textOf(
        await callTool(env, TOKEN_OWNER, "move_notes", {
          moves: [
            { source: "1-projects/probe.md", destination: "1-projects/moved.md" },
            {
              source: "1-projects/probe.md",
              destination: "1-projects/other.md",
              workspaceId: WORKSPACE_OTHER,
            },
          ],
        })
      ) === 'unknown argument "moves[1].workspaceId"; permitted here: source, destination, expected_source_etag'
    );
    check(
      "a batch past the advertised maximum is refused by the schema, not by the handler",
      textOf(
        await callTool(env, TOKEN_OWNER, "move_notes", {
          moves: Array.from({ length: 101 }, (_, n) => ({
            source: `1-projects/${n}.md`,
            destination: `1-projects/${n}-moved.md`,
          })),
        })
      ) === 'argument "moves" must have at most 100 items'
    );
    check(
      "...and an empty one the same way",
      textOf(await callTool(env, TOKEN_OWNER, "move_notes", { moves: [] })) ===
        'argument "moves" must have at least 1 item'
    );
    check(
      "...and the note it named is exactly where it was",
      mine.get("1-projects/probe.md")?.body === "MINE-MARKER" && !mine.get("1-projects/moved.md")
    );

    /* --------------- the tools that take nothing at all -------------------- */

    for (const name of ["orient", "list_proposals", "list_plugins", "export_encryption_keys", "rotate_encryption_keys"]) {
      const refusal = await callTool(env, TOKEN_OWNER, name, { workspaceId: WORKSPACE_OTHER });
      check(
        `${name} takes no arguments, and now that is true of the door as well`,
        refusal?.isError === true &&
          textOf(refusal).startsWith('unknown argument "workspaceId"') &&
          !textOf(refusal).includes(WORKSPACE_OTHER)
      );
    }
    check(
      "a tool that requires nothing still works with no arguments member at all",
      !(await callTool(env, TOKEN_OWNER, "orient"))?.isError
    );

    /* ---------- the refusal must not become an existence oracle ------------ */

    /*
      A team-tier caller is answered `unknown tool` for the two encryption
      tools, byte-identical to an invented name — `docs/decisions/encryption.md`,
      "a team-tier caller does not even learn the tool exists". Validating a
      masked tool's arguments would undo that with one sentence: a complaint
      about a property is a statement that the tool is real.
    */
    const maskedWithJunk = await callTool(env, TOKEN_TEAM, "export_encryption_keys", {
      workspaceId: WORKSPACE_OTHER,
    });
    const inventedWithJunk = await callTool(env, TOKEN_TEAM, "no_such_tool_at_all", {
      workspaceId: WORKSPACE_OTHER,
    });
    check(
      "a masked tool called with bad arguments is still answered as an unknown tool",
      textOf(maskedWithJunk) === "unknown tool: export_encryption_keys"
    );
    check(
      "...which is what an invented name gets, argument for argument",
      textOf(maskedWithJunk).replace("export_encryption_keys", "«name»") ===
        textOf(inventedWithJunk).replace("no_such_tool_at_all", "«name»")
    );
    check(
      "an invented tool name is not validated into existence either",
      textOf(await callTool(env, TOKEN_OWNER, "no_such_tool_at_all", { path: 7 })) ===
        "unknown tool: no_such_tool_at_all"
    );

    /* -------------- and all of that on the other protocol era -------------- */

    /*
      Every check above rode the legacy transport. `docs/decisions/gateway-protocol.md`
      says why that is not enough on its own: a control implemented on one
      era's path is a control an attacker reaches by adding a header, and the
      two eras are different functions with different framing. They share
      `callToolForSession`, so this is a check that they still do.
    */
    check(
      "the modern transport refuses an unknown argument the same way",
      textOf(
        await callToolModern(env, TOKEN_OWNER, "read_note", {
          path: "1-projects/probe.md",
          workspaceId: WORKSPACE_OTHER,
        })
      ) === 'unknown argument "workspaceId"; permitted here: path, context'
    );
    check(
      "...and still serves the same call without it, so the era is really reached",
      textOf(
        await callToolModern(env, TOKEN_OWNER, "read_note", { path: "1-projects/probe.md" })
      ).includes("MINE-MARKER")
    );
    check(
      "...and masks the two encryption tools there identically to an invented name",
      textOf(
        await callToolModern(env, TOKEN_TEAM, "export_encryption_keys", { workspaceId: "ws_x" })
      ) === "unknown tool: export_encryption_keys" &&
        textOf(
          await callToolModern(env, TOKEN_TEAM, "no_such_tool_at_all", { workspaceId: "ws_x" })
        ) === "unknown tool: no_such_tool_at_all"
    );

    /* ------- the shapes a JavaScript object literal cannot express --------- */

    /*
      `__proto__` is the one property name that is a hazard rather than merely
      an unknown one: a client sends it, `JSON.parse` makes it an ordinary own
      property, and code that reaches for a schema's declared properties with a
      bare `in` or a plain lookup finds `Object.prototype`'s instead. The
      validator uses `Object.prototype.hasOwnProperty.call` for exactly that
      reason, and this is the check that says so from outside — sent as bytes,
      because a literal `{ __proto__: … }` in this file would set a prototype
      rather than a property and would test nothing.
    */
    const overTheWire = await callToolRaw(
      env,
      TOKEN_OWNER,
      "read_note",
      '{"path":"1-projects/probe.md","__proto__":{"pollutedByAToolCall":true}}'
    );
    check(
      "__proto__ arriving over the wire is an unknown argument, not a prototype",
      textOf(overTheWire) === 'unknown argument "__proto__"; permitted here: path, context'
    );
    check(
      "...and nothing in this isolate was polluted by asking",
      // eslint-disable-next-line no-prototype-builtins
      {}.pollutedByAToolCall === undefined && Object.prototype.pollutedByAToolCall === undefined
    );
    check(
      "a number no double can hold is not an integer",
      textOf(await callToolRaw(env, TOKEN_OWNER, "list_meetings", '{"limit":1e400}')) ===
        'argument "limit" must be an integer, not number'
    );
    check(
      "...and one that is merely enormous is refused by the advertised maximum",
      textOf(
        await callToolRaw(env, TOKEN_OWNER, "list_meetings", '{"limit":9007199254740993}')
      ) === "argument \"limit\" must be at most 25"
    );
    check(
      "a lone surrogate in a property name is escaped rather than passed through",
      textOf(await callToolRaw(env, TOKEN_OWNER, "read_note", '{"path\\ud800":"a.md"}')) ===
        'unknown argument "path\\ud800"; permitted here: path, context'
    );
    check(
      "a repeated property is validated as the value that actually reaches the handler",
      textOf(
        await callToolRaw(
          env,
          TOKEN_OWNER,
          "read_note",
          '{"path":"1-projects/probe.md","path":{"$ne":null}}'
        )
      ) === 'argument "path" must be a string, not object'
    );

    /* --------- the most expensive call the gateway will actually take ------ */

    /*
      The cost figure above is a typical write. This is the ceiling: the
      largest batch `move_notes` advertises, with every optional property on
      every element, which is the only call in the tool list that spends more
      than a handful of nodes. It is the number to compare a future schema
      against — an array whose `maxItems` is larger, or an element schema with
      more properties, moves this and not the typical-write figure.
    */
    const WORST_CASE_ITERATIONS = 2000;
    const worstCase = {
      moves: Array.from({ length: 100 }, (_, n) => ({
        source: `1-projects/${n}.md`,
        destination: `1-projects/${n}-moved.md`,
        expected_source_etag: `etag-${n}`,
      })),
      dry_run: true,
      context: "@shared",
    };
    const worstSchema = schemas.get("move_notes");
    check("the worst case is a legal call, not a refused one", validateArguments(worstSchema, worstCase) === null);
    const worstStart = Date.now();
    for (let i = 0; i < WORST_CASE_ITERATIONS; i += 1) validateArguments(worstSchema, worstCase);
    const worstUs = ((Date.now() - worstStart) * 1000) / WORST_CASE_ITERATIONS;
    check(
      `the largest call the tool list permits costs under 500 microseconds (${worstUs.toFixed(
        1
      )}us over ${WORST_CASE_ITERATIONS})`,
      worstUs < 500
    );

    /* ------------------- the alias is dispatched and checked --------------- */

    check(
      "the unlisted alias is validated against the schema of the tool it became",
      textOf(
        await callTool(env, TOKEN_OWNER, "archive_chat", {
          platform: "probe",
          workspaceId: WORKSPACE_OTHER,
        })
      ).startsWith('unknown argument "workspaceId"')
    );
    check(
      "...and still works, which is why it is still dispatched",
      !(await callTool(env, TOKEN_OWNER, "archive_chat", {
        platform: "probe",
        content: "# a session\n",
      }))?.isError
    );

    /* ------- the two whose schema is somebody else's contract ------------- */

    /*
      `search` and `fetch` are ChatGPT's deep-research shape and deliberately
      do not advertise the addressing argument, so a `context` on one of them
      is refused like any other property they do not take. That is a real
      behaviour change and it is the schema's answer rather than a widening of
      it: those chats send what the contract defines and nothing else, and a
      client that can see the ordinary tools can address a context with them.
    */
    check(
      "search refuses the addressing argument its schema does not carry",
      textOf(await callTool(env, TOKEN_OWNER, "search", { query: "probe", context: "@shared" })) ===
        'unknown argument "context"; permitted here: query'
    );
    check(
      "...and so does fetch",
      textOf(
        await callTool(env, TOKEN_OWNER, "fetch", {
          id: "1-projects/probe.md",
          context: "@shared",
        })
      ) === 'unknown argument "context"; permitted here: id'
    );
    check(
      "...while the ordinary tools still reach that same context with it",
      textOf(
        await callTool(env, TOKEN_OWNER, "read_note", {
          path: "1-projects/probe.md",
          context: "@shared",
        })
      ).includes("SHARED-MARKER")
    );
    check(
      "...and a context named on search that this connection cannot reach is refused by the routing, as before",
      textOf(await callTool(env, TOKEN_OWNER, "search", { query: "probe", context: "@other" })) ===
        "this connection has no access to that context"
    );

    /* --------------- the isolation this was always protecting -------------- */

    check(
      "a context this connection is not a member of is still unreachable, and says so the same way",
      textOf(
        await callTool(env, TOKEN_OWNER, "read_note", {
          path: "1-projects/probe.md",
          context: "@other",
        })
      ) ===
        textOf(
          await callTool(env, TOKEN_OWNER, "read_note", {
            path: "1-projects/probe.md",
            context: "@no-such-context-anywhere",
          })
        )
    );
    check(
      "...and nothing from it appears in any answer this connection got",
      !textOf(
        await callTool(env, TOKEN_OWNER, "read_note", {
          path: "1-projects/probe.md",
          context: "@other",
        })
      ).includes("OTHER-MARKER")
    );
    check(
      "a `context` that is not a usable name is still refused on its own terms, not as a type",
      textOf(
        await callTool(env, TOKEN_OWNER, "read_note", { path: "1-projects/probe.md", context: 123 })
      ) === "this connection has no access to that context"
    );

    /* ------------ the scope gate still answers before the schema ----------- */

    /*
      A connection that holds no write scope is told it holds no write scope,
      rather than being handed the argument shape of a tool its own
      `tools/list` does not show it. The ordering is deliberate; this is the
      check that fails if somebody moves the validator above the gate.
    */
    const readOnly = `cat_args_readonly_${"0".repeat(23)}`;
    await controlPlane.addGrant({
      accessToken: readOnly,
      workspaceId: WORKSPACE_MINE,
      role: "owner",
      scopes: ["context:read"],
      clientId: "mcp_client_args_readonly",
      userId: "user_args_owner",
    });
    check(
      "a read-only grant is refused for its scope before its arguments are examined",
      textOf(
        await callTool(env, readOnly, "write_note", {
          path: "1-projects/x.md",
          content: "x",
          workspaceId: WORKSPACE_OTHER,
        })
      ).startsWith("permission denied")
    );
  } finally {
    restoreControlPlane();
    restoreS3();
  }
}
