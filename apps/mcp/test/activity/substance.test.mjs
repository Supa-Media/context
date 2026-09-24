/**
 * Which actions become a line, and which never do. See activity.test.mjs for
 * the module overview and the sabotage-testing record.
 */

import { ACTIVITY_PATH, MIN_REVISION_BYTES, change, entryFor, mayBeReportable } from "./fixtures.mjs";

export async function runActivitySubstanceChecks(check) {
  check(
    "a created note is a line",
    entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true }))
      ?.kind === "added",
  );

  /*
    The cheap half, asked before anything is read. It has to agree with
    `entryFor` on the two things it can see — otherwise the optimisation is a
    filter, and a filter nobody tested is a way to lose changes silently.
  */
  check(
    "the pre-check refuses what entryFor refuses, without reading anything",
    !mayBeReportable("read_note", ["1-projects/alpha.md"]) &&
      !mayBeReportable("create_note", [".context/audit/x.json"]) &&
      !mayBeReportable("create_note", []) &&
      !mayBeReportable("propose_note", ["1-projects/alpha.md"]) &&
      mayBeReportable("create_note", ["1-projects/alpha.md"]),
  );
  check(
    "and it is looser rather than stricter: a trivial edit still gets looked at",
    mayBeReportable("update_note", ["1-projects/alpha.md"]) &&
      entryFor(
        change("update_note", ["1-projects/alpha.md"], {
          team_visible: true,
          previous_bytes: 100,
          content_bytes: 101,
        }),
      ) === null,
  );

  check(
    "a read is not an action this module has ever heard of",
    entryFor(change("read_note", ["1-projects/alpha.md"])) === null,
  );

  for (const quiet of [
    "propose_note",
    "reject_proposal",
    "materialize_move",
    "inbox_capture",
    "inbox_update",
    "calendar_sync",
    "rotate_encryption_keys",
    "export_encryption_keys",
    "encrypt_note",
    "file.delete",
    "folder.create",
    "vault.import",
  ]) {
    check(
      `${quiet} never becomes a line`,
      entryFor(change(quiet, ["1-projects/alpha.md"], { team_visible: true })) === null,
    );
  }

  check(
    "a revision under the threshold is not a line",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 + MIN_REVISION_BYTES - 1,
      }),
    ) === null,
  );

  check(
    "a revision at the threshold is a line",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 + MIN_REVISION_BYTES,
      }),
    )?.kind === "revised",
  );

  check(
    "a deletion of the same size counts, because a cut is a change",
    entryFor(
      change("update_note", ["1-projects/alpha.md"], {
        team_visible: true,
        previous_bytes: 4000,
        content_bytes: 4000 - MIN_REVISION_BYTES,
      }),
    )?.kind === "revised",
  );

  check(
    "a revision whose sizes are unknown is kept rather than silently dropped",
    entryFor(change("update_note", ["1-projects/alpha.md"], { team_visible: true }))
      ?.kind === "revised",
  );

  check(
    "a form response is a submission, not a line",
    entryFor(
      change("create_note", ["1-projects/poll.responses.md"], {
        team_visible: true,
        form_id: "f1",
      }),
    ) === null,
  );

  check(
    "the activity file's own writes cannot become lines",
    entryFor(change("update_note", [ACTIVITY_PATH], { team_visible: true })) === null,
  );

  check(
    "plumbing under a dot segment is never a line",
    entryFor(change("create_note", [".context/audit/x.json"], { team_visible: true })) ===
      null,
  );

  check(
    "a move is refused when either end is plumbing, not just the first",
    entryFor(
      change("move_note", ["1-projects/alpha.md", ".context/x.md"], { team_visible: true }),
    ) === null,
  );

  check(
    "taking a note back into private is never a line",
    entryFor(
      change("set_visibility", ["1-projects/alpha.md"], { from: "team", to: "private" }),
    ) === null,
  );

  check(
    "giving a note to the team is a line",
    entryFor(
      change("set_visibility", ["1-projects/alpha.md"], {
        from: "private",
        to: "team",
        team_visible: true,
      }),
    )?.kind === "published",
  );
}
