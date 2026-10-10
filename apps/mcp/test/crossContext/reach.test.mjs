/**
 * Reach, which is the feature — a call names another context and is served
 * from it — and permission, which did not widen with it.
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import {
  callTool,
  textOf,
  TOKEN_EDITOR,
  TOKEN_GUEST,
  TOKEN_OWNER,
  TOKEN_OWNER_BOTH,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextReachChecks(check, harness) {
  const { mine, theirs, stranger, env } = harness;
  /* ------------------------- reach, which is the feature ------------------- */

  const here = textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "1-projects/shared-name.md" }));
  check("with no context named, a call still acts on the connection's own", here.includes("MINE-MARKER"));

  const there = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@theirs",
    })
  );
  check("a note in a context shared with this person is readable by name", there.includes("THEIRS-MARKER"));
  check("and it is that context's file, not the identically named one here", !there.includes("MINE-MARKER"));

  const bare = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "theirs",
    })
  );
  check("the @ is decoration, as it is in the URL form", bare.includes("THEIRS-MARKER"));

  const listed = textOf(await callTool(env, TOKEN_OWNER, "list_notes", { context: "@theirs" }));
  check("a listing is the addressed context's", listed.includes("1-projects/shared-name.md"));

  /* ------------- the @name/path sugar: the same routing, from the path ------------- */

  const sugared = textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "@theirs/1-projects/shared-name.md" }));
  check("a path that opens with a context's name addresses that context", sugared.includes("THEIRS-MARKER"));
  check("and it is that context's file, not the identically named one here (sugar)", !sugared.includes("MINE-MARKER"));
  check(
    "the sugar clamps exactly as context does: a member still cannot read the private note by naming it in the path",
    !textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "@theirs/2-areas/kept-private.md" })).includes("THEIRS-PRIVATE-MARKER")
  );
  check(
    "a context this person is not in is refused through the path as through context",
    !textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "@stranger/1-projects/shared-name.md" })).includes("MARKER")
  );
  check(
    "a listing by a prefixed prefix is the addressed context's",
    textOf(await callTool(env, TOKEN_OWNER, "list_notes", { prefix: "@theirs/1-projects" })).includes("1-projects/shared-name.md")
  );

  /*
    AND A CALL MAY NAME ONE PLACE, NOT TWO.

    The sugar's rule is that two prefixed paths must agree. A *plain* path
    beside a prefixed one disagrees in the same way on a tool that routes the
    whole call rather than per side: `move_folder` has no
    `destination_context`, so a prefixed destination with a plain source used
    to route everything to the named workspace and reinterpret the source
    there — "move my folder into theirs" moving *their* identically named
    folder and leaving mine where it was, found by reading, 2026-10-10.
  */
  mine.set("5-here/thing.md", { body: "MINE-HERE-MARKER", etag: "m-here" });
  stranger.set("5-here/thing.md", { body: "STRANGER-HERE-MARKER", etag: "s-here" });
  stranger.set("5-there/thing.md", { body: "STRANGER-THERE-MARKER", etag: "s-there" });
  stranger.set("5-both/thing.md", { body: "STRANGER-BOTH-MARKER", etag: "s-both" });

  const twoPlaces = textOf(
    await callTool(env, TOKEN_OWNER_BOTH, "move_folder", {
      source: "5-here",
      destination: "@stranger/4-archive/5-here",
    })
  );
  check(
    "a move naming one place in the path and another in this context is refused, not run in the named one",
    /names more than one workspace/.test(twoPlaces) &&
      !stranger.has("4-archive/5-here/thing.md") &&
      stranger.has("5-here/thing.md") &&
      mine.has("5-here/thing.md")
  );

  const insideOne = textOf(
    await callTool(env, TOKEN_OWNER_BOTH, "move_folder", {
      source: "@stranger/5-there",
      destination: "4-archive/5-there",
    })
  );
  check(
    "a prefixed source with a plain destination still moves inside the named context",
    /moved folder/.test(insideOne) && stranger.has("4-archive/5-there/thing.md")
  );

  const bothNamed = textOf(
    await callTool(env, TOKEN_OWNER_BOTH, "move_folder", {
      source: "@stranger/5-both",
      destination: "@stranger/4-archive/5-both",
    })
  );
  check(
    "two paths naming the same context both lose the name, rather than one becoming a folder called @name",
    /moved folder/.test(bothNamed) &&
      stranger.has("4-archive/5-both/thing.md") &&
      ![...stranger.keys()].some((key) => key.startsWith("@"))
  );

  // The guard reads the *first* path argument; one of the wrong type names
  // nowhere, so the shape refusal has to come first rather than the move.
  stranger.set("5-shape/thing.md", { body: "STRANGER-SHAPE-MARKER", etag: "s-shape" });
  const badShape = textOf(
    await callTool(env, TOKEN_OWNER_BOTH, "move_folder", {
      source: 5,
      destination: "@stranger/4-archive/5-shape",
    })
  );
  check(
    "a path argument of the wrong type does not slip the guard by being the first one to speak",
    /must be a string/.test(badShape) && !stranger.has("4-archive/5-shape/thing.md")
  );

  // The harness is shared by every section below; this folder is this section's.
  for (const bucket of [mine, stranger]) {
    for (const key of [...bucket.keys()]) if (/5-here|5-there|5-both|5-shape/.test(key)) bucket.delete(key);
  }

  /* ------------------- permission, which did not widen with it ------------- */

  check(
    "a member does not see the other context's private notes",
    !textOf(await callTool(env, TOKEN_OWNER, "list_notes", { context: "@theirs" })).includes(
      "kept-private"
    )
  );
  check(
    "and cannot read one by naming it",
    !textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "2-areas/kept-private.md",
        context: "@theirs",
      })
    ).includes("THEIRS-PRIVATE-MARKER")
  );
  check(
    "while the same connection still reads its own private notes",
    !textOf(await callTool(env, TOKEN_OWNER, "list_notes")).includes("THEIRS")
  );

  const refusedWrite = textOf(
    await callTool(env, TOKEN_OWNER, "write_note", {
      path: "1-projects/intruder.md",
      content: "should never be written",
      context: "@theirs",
    })
  );
  check("a member's write into somebody else's workspace is refused", /permission denied/i.test(refusedWrite));
  check("and names the context it was refused in", refusedWrite.includes("@theirs"));
  check(
    "and nothing was written",
    !theirs.has("1-projects/intruder.md")
  );

  const allowedWrite = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "1-projects/from-an-editor.md",
    content: "an editor may write here",
    context: "@theirs",
  });
  check("an editor's write into the same context lands", theirs.has("1-projects/from-an-editor.md"));
  check("and it landed in that bucket rather than this one", !mine.has("1-projects/from-an-editor.md"));
  check("and the tool reported it rather than a refusal", !/permission denied/i.test(textOf(allowedWrite)));

  /*
    The clamp is against the *target's* role, from the grant's own scopes —
    never against what the connection's own context already narrowed them to.
    This person is a `member` where they connected and an `editor` where they
    are writing, so an implementation that re-clamps an already-clamped set
    intersects the two roles and refuses a write they genuinely have.
  */
  const guestWrite = await callTool(env, TOKEN_GUEST, "write_note", {
    path: "1-projects/from-a-guest.md",
    content: "an editor there, a member here",
    context: "@stranger",
  });
  check(
    "a member here who is an editor there may write there",
    stranger.has("1-projects/from-a-guest.md") && !/permission denied/i.test(textOf(guestWrite))
  );
  const guestRefusedHere = textOf(
    await callTool(env, TOKEN_GUEST, "write_note", {
      path: "1-projects/from-a-guest-here.md",
      content: "should never be written",
    })
  );
  check(
    "and is still refused a write in the context they connected from",
    /permission denied/i.test(guestRefusedHere) && !theirs.has("1-projects/from-a-guest-here.md")
  );
  check(
    "and that refusal names the role rather than telling them to reconnect",
    guestRefusedHere.includes("@theirs") && !/Reconnect the client/i.test(guestRefusedHere)
  );
}
