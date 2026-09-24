/**
 * A context this person does not have, answered like one that does not exist;
 * and orientation, which is per context and bounded in how many it opens.
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import {
  callTool,
  createWorkerCtx,
  textOf,
  TOKEN_GUEST,
  TOKEN_MANY,
  TOKEN_OWNER,
  TOKEN_OWNER_BOTH,
  TOKEN_READ_ONLY,
  TOKEN_READ_ONLY_EDITOR,
  worker,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextOrientationChecks(check, harness) {
  const { env } = harness;
  /* --------------------- a context this person does not have --------------- */

  const strangerRefusal = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@stranger",
    })
  );
  const inventedRefusal = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@no-such-context-anywhere",
    })
  );
  check("a context this person is not in is refused", !strangerRefusal.includes("STRANGER-MARKER"));
  check(
    "and refused identically to a name nobody has registered",
    strangerRefusal === inventedRefusal && strangerRefusal.length > 0
  );
  check(
    "a malformed name is the same refusal again, with no round trip to spend",
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: "@not a slug",
      })
    ) === inventedRefusal
  );
  check(
    "and so is a route name, which the URL form also refuses",
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: "@oauth",
      })
    ) === inventedRefusal
  );

  /*
    An argument that is present and unusable is refused rather than ignored. A
    client that sent `context: 123` meant somewhere else and failed to say
    where; serving the default is the quiet version of writing into the wrong
    workspace, which is the whole failure this feature is built around.
  */
  for (const nonsense of [123, "", "   ", { slug: "theirs" }, ["theirs"], true]) {
    const answer = textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: nonsense,
      })
    );
    check(
      `a context of ${JSON.stringify(nonsense)} is refused rather than falling through to here`,
      !answer.includes("MINE-MARKER") && answer === inventedRefusal
    );
  }

  /* ------------------------------ orientation ------------------------------ */

  const orientation = textOf(await callTool(env, TOKEN_OWNER, "orient"));
  check("orientation names the other contexts this connection reaches", orientation.includes("@theirs"));
  check("and says how to address them", orientation.includes("`context`"));
  check("and does not name a context this person is not in", !orientation.includes("@stranger"));
  check(
    "and does not list the context it is orienting in as somewhere else to go",
    !orientation.includes("### @mine")
  );

  /*
    WHAT THIS CONNECTION MAY DO THERE — NOT WHAT THE ROLE ALONE IMPLIES.

    The row describing each sibling was a function of the role and nothing else,
    and both of its answers were wrong in a way an agent acts on.

    Too mean, which is the one a user actually hit: an owner was told "yours,
    and you see private notes there" — three facts about *reading* and not one
    word about writing. Asked to file a note in a workspace it owns, a model
    reads that row, reads the closing "what you may do in another is decided by
    your role there", and concludes it has not established that it may write.
    It then says so instead of writing, which is what a connected ChatGPT did:
    it had `context` on `write_note` the whole time.

    Too generous, the other direction: an `editor` on a read-only grant was told
    "you can read and write team notes there". The grant ∩ role clamp refuses
    that write, so the row sends an agent into a refusal orientation could have
    saved it.

    The reach is `effectiveScopes(grantScopes, role)` — the same clamp
    `sessionForContext` applies when the call actually arrives — so the row and
    the gate cannot disagree.
  */
  const rowFor = (text, name) =>
    (text.split("\n").find((line) => line.startsWith(`### ${name} \u2014`)) ?? "");

  const ownerBothOrientation = textOf(await callTool(env, TOKEN_OWNER_BOTH, "orient"));
  check(
    "a context this connection owns and may write is described as writable",
    /\bwrite\b/.test(rowFor(ownerBothOrientation, "@stranger"))
  );
  check(
    "and still says the private tier is readable there",
    /private/.test(rowFor(ownerBothOrientation, "@stranger"))
  );

  const readOnlyEditorOrientation = textOf(
    await callTool(env, TOKEN_READ_ONLY_EDITOR, "orient")
  );
  check(
    "an editor role on a read-only grant is not described as writable",
    rowFor(readOnlyEditorOrientation, "@theirs") !== "" &&
      !/\bwrite\b/.test(rowFor(readOnlyEditorOrientation, "@theirs"))
  );
  check(
    "and the row says the connection is the reason, not the role",
    /read-only/.test(rowFor(readOnlyEditorOrientation, "@theirs"))
  );

  /*
    An owner on a grant that carries no `context:private` reads that context at
    `team`, exactly as `visibilityTierForGrant` says — so the row must not
    promise private notes it will not return.
  */
  const readOnlyOrientation = textOf(await callTool(env, TOKEN_READ_ONLY, "orient"));
  check(
    "a plain member is still described as reading only",
    !/\bwrite\b/.test(rowFor(readOnlyOrientation, "@theirs"))
  );

  /*
    THE ROW IS READ OFF THE GRANT'S OWN SCOPES, NOT THE CONNECTION'S CLAMPED SET.

    `sessionForContext` keeps this distinction and documents why; `reachForRole`
    describes what that call will do, so it has to make the same one or the
    description and the gate disagree. This person connected at a context they
    are a plain `member` of — so the live session carries no write at all — and
    is an `editor` somewhere else, where the grant's write survives the clamp.
    Re-clamping the already-clamped set intersects two roles and takes that
    away, which reads as a permission bug in the wrong place: an agent told it
    cannot write in a context where it can.
  */
  const guestOrientation = textOf(await callTool(env, TOKEN_GUEST, "orient"));
  check(
    "write held where the caller is an editor survives a connection clamped to member",
    /\bwrite\b/.test(rowFor(guestOrientation, "@stranger")) &&
      !/read-only/.test(rowFor(guestOrientation, "@stranger"))
  );

  /*
    And the same question about the context the connection is actually in,
    which is the paragraph deciding whether an agent tries at all. Asserted on
    the write-surface section rather than on the whole answer: the sibling rows
    say "read-only" too, so a check over the whole text passes with this notice
    deleted — measured, during the sabotage pass, as zero failures.
  */
  const writeSurfaceOf = (text) => text.split("## Write surface")[1] ?? "";
  check(
    "a read-only grant's write surface says so before it lists writable paths",
    /This connection is read-only/.test(writeSurfaceOf(readOnlyOrientation))
  );
  check(
    "a role that cannot write is named as the role, not as the connection",
    /You cannot write here/.test(writeSurfaceOf(guestOrientation)) &&
      !/This connection is read-only/.test(writeSurfaceOf(guestOrientation))
  );
  check(
    "a connection that can write here is told neither",
    writeSurfaceOf(orientation) !== "" &&
      !/read-only|cannot write here/i.test(writeSurfaceOf(orientation))
  );
  check(
    "and scope_info, the other caller, carries the same notice",
    /This connection is read-only/.test(
      textOf(await callTool(env, TOKEN_READ_ONLY, "scope_info"))
    ) && !/read-only/i.test(textOf(await callTool(env, TOKEN_OWNER, "scope_info")))
  );

  /*
    The front page of each of them, which is what makes the list worth having.
    A name an agent cannot judge is a name it never follows; `index.md` is the
    one file that says what a context is for.
  */
  check("orientation reads the other context's front page", orientation.includes("THEIRS-INDEX-MARKER"));
  check(
    "a front page its owner has not shared is absent, and said to be",
    !orientation.includes("QUIET-PRIVATE-INDEX-MARKER") &&
      orientation.includes("@quiet") &&
      orientation.includes("No front page visible to you there yet")
  );

  /*
    And the bound. Each context costs a control-plane round trip and two reads,
    so a person in a dozen would otherwise turn orientation into the subrequest
    failure it exists to answer. Past the cap they are still named — a name is
    free — and the sentence says the list is short rather than letting it read
    as complete.
  */
  const manyOrientation = textOf(await callTool(env, TOKEN_MANY, "orient"));
  const headingCount = manyOrientation.split("### @extra-").length - 1;
  check(
    `orientation opens at most six other contexts (opened ${headingCount})`,
    headingCount === 6
  );
  check(
    "and names the seventh rather than dropping it",
    manyOrientation.includes("Also reachable, not read here") &&
      /@extra-[1-7]/.test(manyOrientation.split("Also reachable, not read here")[1] || "")
  );

  /*
    THE TAIL NAMES WHAT WAS CAPPED, AND NOTHING ELSE.

    Its documented job is "past the cap they are still named". An orient that
    was itself addressed into another context gets no `openContext` — the
    no-chaining rule — so `readable` is empty, and `others.slice(0)` made the
    tail every sibling while the body was already listing every sibling as
    bullets. Both halves of the section, over the same names.

    Nothing was capped there, so the tail has nothing to add and should be
    absent. Measured before the fix: `@home`, `@broken-manifest` and
    `@no-storage` each appeared twice in one section.
  */
  const addressed = textOf(
    await callTool(env, TOKEN_OWNER, "orient", { context: "@theirs" })
  );
  check(
    "an addressed orient still names the siblings it cannot open",
    addressed.includes("@mine")
  );
  check(
    "and does not also list them under the capped tail",
    !addressed.includes("Also reachable, not read here")
  );

  /*
    Connect time, which is the surface that reaches a model before it has
    decided anything. An agent will not go looking for a second context, so the
    handshake says there is one — and says it without opening a bucket, since
    these are names the session already carried.
  */
  const { ctx: handshakeCtx, settle: settleHandshake } = createWorkerCtx();
  const handshake = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
    }),
    env,
    handshakeCtx
  );
  const instructions = JSON.parse(await handshake.text())?.result?.instructions || "";
  await settleHandshake();
  check("the handshake says another context is reachable", instructions.includes("@theirs"));
  check("and names the argument that reaches it", instructions.includes("`context`"));
  check("and still names no context this person is not in", !instructions.includes("@stranger"));

  const orientedThere = textOf(await callTool(env, TOKEN_OWNER, "orient", { context: "@theirs" }));
  check(
    "orienting into another context surveys that one",
    orientedThere.includes("1-projects") && !orientedThere.includes("MINE-MARKER")
  );
  check(
    "and names the rest without opening them — one call opens one context, never a chain",
    orientedThere.includes("@mine") && !orientedThere.includes("MINE-INDEX-MARKER")
  );
}
