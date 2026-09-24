/**
 * Every writing tool refuses a member; all of it again on the other protocol
 * era; the shapes a JavaScript object literal cannot express, sent raw; and
 * the most expensive call the gateway will actually take.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import {
  callTool,
  callToolModern,
  callToolRaw,
  rpc,
  textOf,
  TOKEN_OWNER,
  TOKEN_TEAM,
  validateArguments,
  WORKSPACE_OTHER,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentProtocolEraChecks(check, harness) {
  const { env, schemas } = harness;
  /* ------ every writing tool refuses a member, exemption list pinned ------ */

  /*
    The write gate exempts the form tools — `FORM_TOOLS.has(name) &&
    participatesInForms(target)`. That is an *exemption*, so an over-broad
    entry is a member writing notes in somebody else's context, silently.
    Measured before writing this: adding `move_note`, `set_visibility` or
    `archive_note` to `FORM_TOOLS` reddened **nothing**. Only `write_note`
    was held, and only by the checks above.

    **The four names below are deliberately NOT read from `FORM_TOOLS`.** A
    test that imports the set it is checking restates the source and asserts
    nothing. Where a predicate and a test must agree on one list, the fix is
    for both to read ONE exported constant — that is the case where they are
    checking the same thing. Here they must differ: this is the independent
    copy, so adding a fifth name to the gateway reddens this check and
    somebody has to say why.

    `TOKEN_OWNER` owns `WORKSPACE_MINE` and is a **member** of
    `WORKSPACE_SHARED`, so routing the call there is the case that matters:
    the grant asked for write, the role clamp took it away, and
    `participatesInForms` is therefore true. A connection that never asked
    for write cannot reach the exemption at all.

    No arguments, on purpose: the scope gate runs *before* argument
    validation, so an empty object still reaches it. That makes this a pin on
    the ordering too — were validation ever moved first, these would fail
    with an argument complaint instead of a denial.
  */
  const FORM_TOOL_NAMES = ["submit_form", "update_submission", "retract_submission", "vote_form"];
  const writingToolNames = ((await rpc(env, TOKEN_OWNER, "tools/list", {}))?.result?.tools || [])
    .filter((tool) => tool?.annotations?.readOnlyHint !== true)
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string" && !FORM_TOOL_NAMES.includes(name));
  const memberLeaks = [];
  for (const name of writingToolNames) {
    const refusal = await callTool(env, TOKEN_OWNER, name, { context: "@shared" });
    if (refusal?.isError !== true || textOf(refusal) !== "permission denied: you have read-only access to @shared.") {
      memberLeaks.push(`${name} -> ${textOf(refusal)}`);
    }
  }
  check(
    `a member is refused every writing tool the form exemption does not name (${writingToolNames.length})`,
    memberLeaks.length === 0
  );
  check(
    "...and the set really was enumerated rather than empty",
    writingToolNames.length >= 10
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
}
