/**
 * `visibleEntries` filters a mixed history the way `canSee` would, and
 * `unseenCount`/`unseenPaths` read the same filtered history against a last
 * visit. See activity.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import { T0, change, claude, entryFor, iso, unseenCount, unseenPaths, visibleEntries } from "./fixtures.mjs";

export async function runActivityVisibilityAndUnreadChecks(check) {
  const mixed = [
    entryFor(change("create_note", ["1-projects/open.md"], { team_visible: true })),
    entryFor(change("create_note", ["3-teams/pay-bands.md"], { team_visible: false })),
    entryFor(
      change(
        "create_note",
        ["1-projects/taken-back.md"],
        { team_visible: true },
        claude,
        iso(60_000),
      ),
    ),
  ];
  const seesEverythingButOne = (path) => path !== "1-projects/taken-back.md";

  check(
    "the owner sees their own record whole",
    visibleEntries(mixed, { owner: true }).length === 3,
  );
  check(
    "a private change is absent for a member, not greyed out",
    visibleEntries(mixed, { owner: false, canSee: () => true }).length === 2,
  );
  check(
    "a note taken back into private drops out of lines written while it was shared",
    visibleEntries(mixed, { owner: false, canSee: seesEverythingButOne })
      .length === 1,
  );
  check(
    "a member with no privacy engine to ask is shown nothing",
    visibleEntries(mixed, { owner: false }).length === 0,
  );

  check(
    "a first visit has everything unread",
    unseenCount(mixed, 0) === 3,
  );
  check(
    "and a return visit counts only what came after it",
    unseenCount(mixed, T0 + 30_000) === 1,
  );
  check(
    "the tree is told which notes are new",
    unseenPaths(mixed, T0 + 30_000).has("1-projects/taken-back.md") &&
      !unseenPaths(mixed, T0 + 30_000).has("1-projects/open.md"),
  );
}
