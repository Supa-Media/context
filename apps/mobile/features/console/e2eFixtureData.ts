import { useMemo } from "react";
import { installE2EEncryptionFixture } from "./e2eEncryptionFixture";
import { useDemoConsoleData } from "./useDemoConsoleData";
import type { ConsoleData } from "./types";

/**
 * The demo console, made editable in memory, for `app/e2e-fixture.tsx` alone.
 *
 * The landing page's `useDemoConsoleData` is deliberately read-only — a
 * visitor is never offered a control that would lie, see that file's header —
 * and one of the five WebKit cases this fixture exists for needs the opposite:
 * a checkbox only toggles when `EditorState.readOnly` is false, which
 * `editability()` sets from `canEdit`. So this flips the same three
 * capability flags `apps/mobile/scripts/design-shots.ts`'s `mockOwner` flips
 * for the same reason, in the same place — `files.canEdit`, `canShare`,
 * `canSetVisibility` — and touches nothing else. `save`, `share`, `destroy`
 * and every other mutating method on `files` stay the demo's no-ops: this
 * makes typing and the checkbox real, not persistence.
 *
 * Nothing here is reachable from the product. See `app/e2e-fixture.tsx` for
 * the gate.
 *
 * `encryptionWriters` is the one exception to "touches nothing else,
 * persistence included" — see `e2eEncryptionFixture.ts`'s own header for why
 * the passphrase flows need a write path that actually persists, and why that
 * does not weaken the rule for everything else here.
 */
export function useE2EFixtureConsoleData(): ConsoleData {
  const demo = useDemoConsoleData();
  // Once per mount — a real `page.reload()` is a fresh mount and re-seeds
  // from `localStorage`; nothing within one page load needs a second call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const encryptionWriters = useMemo(() => installE2EEncryptionFixture(), []);
  return {
    ...demo,
    files: { ...demo.files, canEdit: true, canShare: true, canSetVisibility: true },
    /*
      An activity view with something unread in it.

      The feature this holds on to is the one a green suite cannot see: the
      foot of the tree says how much is new, a row carries a dot, and the list
      opens over the column. `activityRender.test.ts` proves the component
      against a hand-made prop; this is the console, drawn, with the prop the
      console actually passes — which is the difference the visual fixture's
      own header is about ("a fixture that cannot show the thing under review
      is reporting on itself").

      Two entries rather than one, and one of them from a client, because the
      row that has to read well is "@seyi's Claude added 3 notes" and a fixture
      that only draws a person's own edit is not showing it.
    */
    activity: {
      entries: [
        {
          at: new Date(Date.now() - 4 * 60_000).toISOString(),
          kind: "added",
          // One folder, because the merge rule only ever groups within one —
          // a fixture drawing a group that spans two is drawing something the
          // product cannot produce.
          paths: ["2-areas/architecture-map.md", "2-areas/weekly-review.md"],
          n: 2,
          vis: "team",
          by: "@sayo",
          via: "Claude",
          note: "screenshots of the editor bugs from the call",
        },
        {
          at: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
          kind: "meeting",
          paths: ["0-inbox/meetings/2026-09-19-steering.md"],
          n: 1,
          vis: "team",
          by: null,
          via: null,
          note: null,
        },
      ],
      seenAt: Date.now() - 18 * 60 * 60_000,
      unseen: 1,
      /*
        Two, and deliberately on opposite sides of the rule.

        `1-projects` is open in this fixture, so its note carries the dot
        itself; `2-areas` is closed, so the folder carries one for what is
        under it. A fixture that only showed the first would be a fixture
        that cannot show the half of the rule most likely to be got wrong —
        and both are paths this demo tree actually has, which the first draft
        of this data got wrong: it named three notes in a folder the demo has
        never had, so the console drew no dot at all and the board reported
        on itself.
      */
      unseenPaths: new Set([
        "1-projects/dc-chapter.md",
        "2-areas/architecture-map.md",
      ]),
      loaded: true,
      refresh: () => {},
      markSeen: () => {},
    },
    /*
      One managed install, and the vault scan left where a real first visit
      leaves it: `idle`, nobody having pressed anything.

      That pair is the bug this fixture exists to hold on to. An install is in
      the bucket and no scan has run, which is every visit after the one that
      installed it — and the panel used to name nothing at all in that state, so
      people installed the same plugin again and reported that installs do not
      stick. `pluginsInstalled.spec.ts` opens this in a real browser and looks.
    */
    pluginInstalls: {
      state: "ready",
      truncated: false,
      read: async () => {},
      installs: [
        {
          id: "obsidian-bible-reference",
          version: "26.08.07",
          repository: "tim-hub/obsidian-bible-reference",
        },
      ],
    },
    plugins: { state: "idle" },
    encryptionWriters,
  };
}
