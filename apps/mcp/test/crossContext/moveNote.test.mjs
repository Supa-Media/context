/**
 * `move_note` from one context to another: who may, and what the gateway
 * does. Every such move is the control plane's engine
 * (`/gateway/moves/across`, the one the console's Move uses); the gateway
 * checks the caller and the version they read, asks once, and writes no bytes
 * of its own in either bucket. What the engine carries, and how it survives a
 * race, is proved with the engine (`apps/convex`); the stub here only checks
 * the route's roles and records the ask (`controlPlaneStub/moves.mjs`).
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import { callTool, textOf, TOKEN_EDITOR, TOKEN_OWNER_BOTH } from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextMoveNoteChecks(check, harness) {
  const { mine, theirs, stranger, env, controlPlane } = harness;
  const asks = controlPlane.moves.asks;
  /* ------------------------ cross-context move_note ------------------------ */

  mine.set("2-areas/personal-to-shared.md", {
    body: "PRIVATE-PERSONAL-TO-SHARED",
    etag: "m-move-1",
  });
  asks.length = 0;
  const publishPersonal = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/personal-to-shared.md",
    destination: "1-projects/from-personal.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-move-1",
  });
  check(
    "cross-context move_note moves a personal note into a shared workspace through the engine when the caller owns the source and can write the destination",
    /^moved: @mine\/2-areas\/personal-to-shared\.md → @theirs\/1-projects\/from-personal\.md/.test(textOf(publishPersonal)) &&
      asks.length === 1 &&
      asks[0].sourceWorkspaceId === "ws_own" &&
      asks[0].destinationWorkspaceId === "ws_shared" &&
      asks[0].from === "2-areas/personal-to-shared.md" &&
      asks[0].to === "1-projects/from-personal.md"
  );
  check(
    "...and the gateway writes neither bucket itself: the engine carries the note",
    mine.get("2-areas/personal-to-shared.md")?.body === "PRIVATE-PERSONAL-TO-SHARED" &&
      !theirs.has("1-projects/from-personal.md")
  );

  asks.length = 0;
  const stale = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/personal-to-shared.md",
    destination: "1-projects/from-personal.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-move-0",
  });
  check(
    "cross-context move_note with a version the caller read that is no longer current never asks the engine",
    /^conflict: source changed since you read it/.test(textOf(stale)) && asks.length === 0
  );

  asks.length = 0;
  controlPlane.moves.state.answer = {
    status: "failed",
    movedObjects: 0,
    skipped: [],
    error: "Something already exists at 1-projects/from-personal.md.",
  };
  const refusedByEngine = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/personal-to-shared.md",
    destination: "1-projects/from-personal.md",
    source_context: "@mine",
    destination_context: "@theirs",
  });
  controlPlane.moves.state.answer = { status: "complete", movedObjects: 1, skipped: [] };
  check(
    "cross-context move_note reports the engine's refusal as an error, never as a move",
    refusedByEngine?.isError === true &&
      /^not moved: Something already exists/.test(textOf(refusedByEngine)) &&
      asks.length === 1
  );

  theirs.set("1-projects/shared-to-personal.md", {
    body: "SHARED-TO-PERSONAL-MUST-NOT-MOVE",
    etag: "t-move-1",
  });
  asks.length = 0;
  const sharedToPersonal = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "1-projects/shared-to-personal.md",
    destination: "2-areas/from-shared.md",
    source_context: "@theirs",
    destination_context: "@mine",
  });
  check(
    "cross-context move_note refuses shared-to-personal when the caller is not owner of both contexts",
    /requires owner access to both/.test(textOf(sharedToPersonal)) &&
      asks.length === 0 &&
      theirs.has("1-projects/shared-to-personal.md") &&
      !mine.has("2-areas/from-shared.md")
  );

  stranger.set("1-projects/owned-both.md", {
    body: "OWNER-BOTH-MOVE",
    etag: "s-move-1",
  });
  asks.length = 0;
  const ownerBothMove = await callTool(env, TOKEN_OWNER_BOTH, "move_note", {
    source: "1-projects/owned-both.md",
    destination: "2-areas/from-owned-both.md",
    source_context: "@stranger",
    destination_context: "@mine",
    expected_source_etag: "s-move-1",
  });
  check(
    "cross-context move_note allows shared-to-personal when the caller owns both contexts",
    /^moved:/.test(textOf(ownerBothMove)) &&
      asks.length === 1 &&
      asks[0].sourceWorkspaceId === "ws_stranger" &&
      asks[0].destinationWorkspaceId === "ws_own"
  );
}
