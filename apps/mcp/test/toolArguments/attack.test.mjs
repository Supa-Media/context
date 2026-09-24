/**
 * Section 4: the attack, on every tool that is offered — another workspace's
 * identifiers smuggled into the arguments — one tool at a time, the tools that
 * take nothing, and the refusal that must not become an existence oracle.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import {
  callTool,
  EXISTENCE_MASKED_TOOLS,
  sampleObject,
  SMUGGLED,
  SMUGGLED_AT_NOBODY,
  textOf,
  TOKEN_OWNER,
  TOKEN_TEAM,
  WORKSPACE_MINE,
  WORKSPACE_OTHER,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentAttackChecks(check, harness) {
  const { env, mine, other, advertised } = harness;
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
      [...other.keys()].every((key) => !key.startsWith(".context/audit/"))
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

  /*
    THE SAME TWO PROPERTIES, FOR EVERY MEMBER OF `EXISTENCE_MASKED_TOOLS`.

    The checks above prove it for `export_encryption_keys` alone, and the set
    has four members. Measured before widening this, the way the traversal
    matrix in `store.test.mjs` was: deleting `materialize_move` from
    `EXISTENCE_MASKED_TOOLS` reddened **nothing**, and deleting
    `migrate_storage_layout` reddened nothing either.

    Those two are not the same case, and pinning both is what showed the
    difference. **The mask has two readers, not one:** the refusal at the
    dispatch site, and `toolArgumentRefusal`, which returns `null` for a
    masked tool so its schema is never read back to a caller who is not
    supposed to know it exists.

    `materialize_move` has neither reader held: it re-checks the tier itself
    but answers `permission denied: move materialization requires owner
    access.`, so the mask is the only thing between a team-tier caller and a
    sentence confirming the tool is real — and, separately, its argument
    shape.

    `migrate_storage_layout` re-checks the tier and returns the
    *byte-identical* `unknown tool: …`, so the message reader really is
    redundant there. **Its argument reader is not**, which is why removing it
    from the set still reddens the first check below and not the second: the
    validator fires and answers "permitted here: …" to a caller the dispatch
    site would have told nothing. An assertion written only on the no-argument
    case would have called this tool covered and been wrong.
  */
  /*
    **Walked from the set itself, not from a copy of it.** This loop held a
    hand-written literal of the same four names, and the drift that allowed
    was measured rather than imagined: adding a fifth name to
    `EXISTENCE_MASKED_TOOLS` and wiring it nowhere else reddened **nothing**
    across the whole suite.

    That silence is the dangerous kind, because membership of that set does
    two opposite things. It *enables* the refusal at the dispatch site, and it
    *disables* `toolArgumentRefusal`. A name added to the set and not to the
    switch is therefore not an unguarded tool — it is a tool that is still
    callable AND no longer argument-checked, which is strictly worse than
    never having been listed. Deriving the loop is what makes the fifth name
    arrive with its own failing checks instead of with silence.
  */
  const maskedNames = [...EXISTENCE_MASKED_TOOLS];
  check(
    "the masked set still holds every name it held when this loop was derived",
    // Not `> 0`. A derived loop over an emptied set passes by running nothing,
    // which is the failure mode deriving it was supposed to remove — and this
    // set should only ever grow, so a shrink is a decision somebody has to
    // come here and make rather than one a green run can hide.
    maskedNames.length >= 4,
  );
  for (const masked of maskedNames) {
    const withJunk = await callTool(env, TOKEN_TEAM, masked, { workspaceId: WORKSPACE_OTHER });
    const inventedPeer = await callTool(env, TOKEN_TEAM, `${masked}_x`, {
      workspaceId: WORKSPACE_OTHER,
    });
    check(
      `${masked} is masked from a team tier, arguments and all`,
      textOf(withJunk) === `unknown tool: ${masked}` &&
        JSON.stringify(withJunk) === JSON.stringify(inventedPeer).replaceAll(`${masked}_x`, masked)
    );
    check(
      `...and with no arguments at all it is still an unknown tool, not a denial`,
      textOf(await callTool(env, TOKEN_TEAM, masked)) === `unknown tool: ${masked}` &&
        !/permission denied/i.test(textOf(await callTool(env, TOKEN_TEAM, masked)))
    );
  }
}
