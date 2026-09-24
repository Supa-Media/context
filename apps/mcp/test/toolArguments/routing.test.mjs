/**
 * The alias and the unlisted tool are dispatched and checked, the two schemas
 * that are somebody else's contract, the isolation this was always
 * protecting, and the scope gate still answering before the schema.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import {
  callTool,
  textOf,
  TOKEN_OWNER,
  WORKSPACE_MINE,
  WORKSPACE_OTHER,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentRoutingChecks(check, harness) {
  const { env, controlPlane } = harness;
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

  /* ------------ and the unlisted tool, which kept its own schema --------- */

  check(
    "an unlisted tool is validated against its OWN advertised schema",
    textOf(
      await callTool(env, TOKEN_OWNER, "create_form", {
        path: "1-projects/unlisted-probe.md",
        fields: [{ name: "who", type: "line", max: 20 }],
        responses_note: "1-projects/elsewhere.md",
      })
    ).startsWith('unknown argument "responses_note"')
  );
  check(
    "...and still works, so a client holding a cached list is not broken",
    !(await callTool(env, TOKEN_OWNER, "create_form", {
      path: "1-projects/unlisted-probe.md",
      title: "Probe",
      fields: [{ name: "who", type: "line", max: 20, required: true }],
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
}
