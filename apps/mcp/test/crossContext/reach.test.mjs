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
