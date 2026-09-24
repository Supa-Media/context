/**
 * The tools advertise the argument, the listing follows the connection rather
 * than the context it is in, and `list_plugins` — the one door into
 * `.obsidian/` — is the owner's.
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import {
  callTool,
  createWorkerCtx,
  textOf,
  TOKEN_GUEST,
  TOKEN_OWNER,
  TOKEN_READ_ONLY,
  TOKEN_VISITOR,
  toolNamesFor,
  worker,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextAdvertisingChecks(check, harness) {
  const { env } = harness;
  /* -------------------------- the tools advertise it ----------------------- */

  const { ctx, settle } = createWorkerCtx();
  const listResponse = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }),
    env,
    ctx
  );
  const tools = JSON.parse(await listResponse.text())?.result?.tools || [];
  await settle();
  const addressable = tools.filter((tool) => tool.inputSchema?.properties?.context);
  check("every tool but the two foreign-contract ones advertises the argument", addressable.length === tools.length - 2);
  check(
    "and the two that do not are ChatGPT's search and fetch",
    tools
      .filter((tool) => !tool.inputSchema?.properties?.context)
      .map((tool) => tool.name)
      .sort()
      .join(",") === "fetch,search"
  );
  check(
    "orient advertises it too, since orientation is per context",
    Boolean(tools.find((tool) => tool.name === "orient")?.inputSchema?.properties?.context)
  );

  /*
    AND THE DESCRIPTION SAYS SO, BECAUSE THAT IS THE SURFACE EVERY CLIENT READS.

    A property blurb is not nothing, but it is the part of a tool a client is
    free to summarise, reorder or leave out of what the model sees — and a
    model that has decided a capability is absent does not go back and re-read
    the parameter list to check. A connected ChatGPT, holding this exact
    schema, told its user three times that "the write action exposed to me
    doesn't expose the workspace selector".

    So the sentence goes where the one description every client renders is,
    added in the same central map as the property so the two cannot drift and
    a tool added next year cannot quietly ship without it.
  */
  const unaddressed = tools
    .filter((tool) => tool.inputSchema?.properties?.context)
    .filter((tool) => !/context: "@name"/.test(tool.description || ""))
    .map((tool) => tool.name);
  check(
    `every addressable tool's description says how to address it (${unaddressed.join(", ") || "none missing"})`,
    unaddressed.length === 0
  );
  check(
    "and the two foreign-contract tools say nothing they cannot honour",
    tools
      .filter((tool) => !tool.inputSchema?.properties?.context)
      .every((tool) => !/context: "@name"/.test(tool.description || ""))
  );

  /*
    The listing follows the connection, not the context it happens to be in.

    This person is a `member` where they connected and an `editor` elsewhere. A
    listing filtered by the current context would show them no write tools at
    all — and an agent cannot ask for a tool it was never told about, so the
    capability would be gone rather than merely refused in one place. Compare
    with a grant that genuinely holds no write scope, where hiding them is
    right.
  */
  const guestTools = await toolNamesFor(env, TOKEN_GUEST);
  check("a connection that can write somewhere is offered the write tools", guestTools.includes("write_note"));
  const readOnlyTools = await toolNamesFor(env, TOKEN_READ_ONLY);
  check(
    "a connection whose grant holds no write scope is not",
    !readOnlyTools.includes("write_note") && readOnlyTools.includes("read_note")
  );

  /*
    `.obsidian/` IS THE OWNER'S, AND `list_plugins` WAS THE ONE DOOR WITHOUT A
    LOCK ON IT.

    `isPlumbing` hides every dot-segment from `read_note`, `list_notes` and
    search — for every role, including the owner's. So this prefix has exactly
    one read path, and it was offered to any grant holding `context:read`,
    because `toolListPlugins` took the store and not the scope.

    `TOKEN_READ_ONLY` is the owner of `@mine` and a plain `member` of `@theirs`.
    Addressing `@theirs`, the same call that returns `not found` from
    `read_note` on any `.obsidian/` key was returning that owner's whole plugin
    inventory: every plugin's id, name, version and author, which blocked
    internals each bundle names, and up to twelve hostnames pulled out of the
    bundle text — internal endpoints included.

    The repo decided this class once already and in the other direction: the
    note census is owner-only precisely because it is a count taken over what a
    member cannot see, and this both counts and then enumerates. #201 widened
    who can ask, by making one connection reach every context its person
    belongs to.
  */
  const memberPlugins = textOf(
    await callTool(env, TOKEN_READ_ONLY, "list_plugins", { context: "@theirs" })
  );
  check(
    "a member cannot read the plugin inventory of somebody else's context",
    !memberPlugins.includes("THEIRS-PLUGIN-MARKER")
  );
  check(
    "and is not offered the tool at all",
    !readOnlyTools.includes("list_plugins")
  );

  /*
    THE OWNER STILL READS THEIR OWN — asserted on the marker, not on the absence
    of two strings that the refusal never contains.

    This check used to read `!includes("no access") && !includes("unknown
    tool")`, and the refusal it exists to catch says "reading this context's
    Obsidian plugins is the context owner's." Measured: gating the tool against
    *everyone* left this passing.
  */
  const ownerPlugins = textOf(await callTool(env, TOKEN_OWNER, "list_plugins", {}));
  check(
    "while the owner of a context still reads its own",
    ownerPlugins.includes("MINE-PLUGIN-MARKER")
  );

  /*
    AND THE `Anywhere` HALF OF `readsPrivateAnywhere` IS THE PART THAT NEEDED
    PINNING.

    `writesAnywhere`'s cross-context arm is asserted; this one's was not —
    deleting the whole `workspaces` scan and leaving `hasScope` left the suite
    green, so the half that makes it `…Anywhere` was free.

    It is not dead code. `TOKEN_GUEST` is a `member` where it connected and an
    owner elsewhere, so only that arm can offer it the tool at all: without it,
    somebody connected at a colleague's context could never call `list_plugins`
    for their own workspace over that connection.
  */
  const visitorOffered = await toolNamesFor(env, TOKEN_VISITOR);
  check(
    "a connection that owns a context it did not connect at is still offered the tool",
    visitorOffered.includes("list_plugins")
  );
  check(
    "and is still refused in the context it only visits",
    !textOf(
      await callTool(env, TOKEN_VISITOR, "list_plugins", { context: "@theirs" })
    ).includes("THEIRS-PLUGIN-MARKER")
  );
  check(
    "while reading its own",
    textOf(
      await callTool(env, TOKEN_VISITOR, "list_plugins", { context: "@mine" })
    ).includes("MINE-PLUGIN-MARKER")
  );
}
