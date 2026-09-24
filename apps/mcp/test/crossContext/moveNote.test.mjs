/**
 * `move_note` from one context to another: who may, what lands where, and
 * what is left behind when a step fails.
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
export async function runCrossContextMoveNoteChecks(check, harness) {
  const { hooks, mine, theirs, stranger, env } = harness;
  /* ------------------------ cross-context move_note ------------------------ */

  mine.set("2-areas/personal-to-shared.md", {
    body: "PRIVATE-PERSONAL-TO-SHARED",
    etag: "m-move-1",
  });
  const publishWithoutConfirm = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/personal-to-shared.md",
    destination: "1-projects/from-personal.md",
    source_context: "@mine",
    destination_context: "@theirs",
  });
  check(
    "cross-context move_note requires explicit confirmation before publishing private into team scope",
    /confirm_team_publish=true/.test(textOf(publishWithoutConfirm)) &&
      mine.has("2-areas/personal-to-shared.md") &&
      !theirs.has("1-projects/from-personal.md")
  );
  const publishPersonal = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/personal-to-shared.md",
    destination: "1-projects/from-personal.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-move-1",
    confirm_team_publish: true,
  });
  check(
    "cross-context move_note moves a personal note into a shared workspace when the caller owns the source and can write the destination",
    !/permission denied|confirm_team_publish|required/i.test(textOf(publishPersonal)) &&
      /not found/.test(textOf(await callTool(env, TOKEN_EDITOR, "read_note", {
        path: "2-areas/personal-to-shared.md",
        context: "@mine",
      }))) &&
      theirs.has("1-projects/from-personal.md")
  );
  check(
    "the published cross-context destination is team-readable in the shared workspace",
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/from-personal.md",
        context: "@theirs",
      })
    ).includes("PRIVATE-PERSONAL-TO-SHARED")
  );

  mine.set("2-areas/race-destination.md", {
    body: "RACE-DESTINATION-SOURCE",
    etag: "m-race-destination-1",
  });
  let racedDestination = false;
  hooks.push(async (url, init = {}) => {
    const parsed = new URL(url);
    if (
      !racedDestination &&
      (init.method || "GET").toUpperCase() === "PUT" &&
      parsed.pathname === "/cross-theirs/1-projects/race-destination.md"
    ) {
      racedDestination = true;
      theirs.set("1-projects/race-destination.md", {
        body: "RACED-DESTINATION-WRITE",
        etag: "t-race-destination-1",
      });
    }
  });
  const destinationRace = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/race-destination.md",
    destination: "1-projects/race-destination.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-race-destination-1",
    confirm_team_publish: true,
  });
  hooks.length = 0;
  check(
    "cross-context move_note does not overwrite a destination created after preflight",
    /destination already exists/.test(textOf(destinationRace)) &&
      mine.has("2-areas/race-destination.md") &&
      theirs.get("1-projects/race-destination.md")?.body === "RACED-DESTINATION-WRITE"
  );

  mine.set("2-areas/race-source.md", {
    body: "RACE-SOURCE-ORIGINAL",
    etag: "m-race-source-1",
  });
  let racedSource = false;
  let crossedDestinationEtag = null;
  hooks.push(async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const contentType = new Headers(init.headers).get("content-type");
    if (
      !racedSource &&
      method === "PUT" &&
      contentType === "application/x-context-logical-tombstone" &&
      parsed.pathname === "/cross-mine/2-areas/race-source.md"
    ) {
      racedSource = true;
      const writtenDestination = theirs.get("1-projects/race-source.md");
      crossedDestinationEtag = writtenDestination?.etag || null;
      mine.set("2-areas/race-source.md", {
        body: "RACED-SOURCE-WRITE",
        etag: "m-race-source-2",
      });
    }
  });
  const sourceRace = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/race-source.md",
    destination: "1-projects/race-source.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-race-source-1",
    confirm_team_publish: true,
  });
  hooks.length = 0;
  check(
    "cross-context move_note preserves a source edited after copy instead of deleting it",
      /move rolled back after source-delete failure: Markdown changed during deletion/.test(
      textOf(sourceRace),
    ) &&
      mine.get("2-areas/race-source.md")?.body === "RACED-SOURCE-WRITE" &&
      /not found/.test(textOf(await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/race-source.md",
        context: "@theirs",
      }))) &&
      crossedDestinationEtag !== null
  );

  mine.set("2-areas/race-rollback.md", {
    body: "RACE-ROLLBACK-ORIGINAL",
    etag: "m-race-rollback-1",
  });
  let racedRollbackSource = false;
  let racedRollbackDestination = false;
  hooks.push(async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const contentType = new Headers(init.headers).get("content-type");
    if (
      !racedRollbackSource &&
      method === "PUT" &&
      contentType === "application/x-context-logical-tombstone" &&
      parsed.pathname === "/cross-mine/2-areas/race-rollback.md"
    ) {
      racedRollbackSource = true;
      mine.set("2-areas/race-rollback.md", {
        body: "RACED-ROLLBACK-SOURCE",
        etag: "m-race-rollback-2",
      });
    } else if (
      racedRollbackSource &&
      !racedRollbackDestination &&
      method === "PUT" &&
      contentType === "application/x-context-logical-tombstone" &&
      parsed.pathname === "/cross-theirs/1-projects/race-rollback.md"
    ) {
      racedRollbackDestination = true;
      theirs.set("1-projects/race-rollback.md", {
        body: "RACED-ROLLBACK-DESTINATION",
        etag: "t-race-rollback-2",
      });
    }
  });
  const rollbackRace = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "2-areas/race-rollback.md",
    destination: "1-projects/race-rollback.md",
    source_context: "@mine",
    destination_context: "@theirs",
    expected_source_etag: "m-race-rollback-1",
    confirm_team_publish: true,
  });
  hooks.length = 0;
  check(
    "cross-context move_note rollback does not delete a destination edited after copy",
    /move rolled back after source-delete failure: Markdown changed during deletion/.test(
      textOf(rollbackRace),
    ) &&
      mine.get("2-areas/race-rollback.md")?.body === "RACED-ROLLBACK-SOURCE" &&
      theirs.get("1-projects/race-rollback.md")?.body === "RACED-ROLLBACK-DESTINATION"
  );

  theirs.set("1-projects/shared-to-personal.md", {
    body: "SHARED-TO-PERSONAL-MUST-NOT-MOVE",
    etag: "t-move-1",
  });
  const sharedToPersonal = await callTool(env, TOKEN_EDITOR, "move_note", {
    source: "1-projects/shared-to-personal.md",
    destination: "2-areas/from-shared.md",
    source_context: "@theirs",
    destination_context: "@mine",
  });
  check(
    "cross-context move_note refuses shared-to-personal when the caller is not owner of both contexts",
    /requires owner access to both/.test(textOf(sharedToPersonal)) &&
      theirs.has("1-projects/shared-to-personal.md") &&
      !mine.has("2-areas/from-shared.md")
  );

  stranger.set("1-projects/owned-both.md", {
    body: "OWNER-BOTH-MOVE",
    etag: "s-move-1",
  });
  const ownerBothMove = await callTool(env, TOKEN_OWNER_BOTH, "move_note", {
    source: "1-projects/owned-both.md",
    destination: "2-areas/from-owned-both.md",
    source_context: "@stranger",
    destination_context: "@mine",
    expected_source_etag: "s-move-1",
  });
  check(
    "cross-context move_note allows shared-to-personal when the caller owns both contexts",
    !/permission denied/i.test(textOf(ownerBothMove)) &&
      /not found/.test(textOf(await callTool(env, TOKEN_OWNER_BOTH, "read_note", {
        path: "1-projects/owned-both.md",
        context: "@stranger",
      }))) &&
      mine.has("2-areas/from-owned-both.md")
  );
  check(
    "the owner-both destination is private in the personal workspace",
    textOf(await callTool(env, TOKEN_GUEST, "read_note", {
      path: "2-areas/from-owned-both.md",
      context: "@mine",
    })) === textOf(await callTool(env, TOKEN_GUEST, "read_note", {
      path: "2-areas/does-not-exist.md",
      context: "@mine",
    }))
  );
}
