/**
 * THE BROWSER-REACHABLE CONSOLE SAYS THE TRUE THING ABOUT THE NOTE IT OPENS.
 *
 * `fixtureConsoleDensity.test.ts` states the rule this file applies to a field
 * rather than to a region: *"a fixture that quietly drops a region is a fixture
 * that reports a defect the product does not have, and hides one it does."*
 *
 * `E2EFixtureScreen` builds its `VoicePage` under a comment saying it is wired
 * "exactly as `(app)/console/_layout.tsx` wires it", and for a while it was —
 * until the layout learned to answer the sheet's audience line from the note's
 * own `visibility` and the fixture went on not mentioning it.
 *
 * What that cost is specific. The fixture opens on `1-projects/context-lc.md`,
 * which `placeholderData.ts` declares with `teamFile(...)`. With the field
 * dropped the sheet fell to the sentence for *a visibility this build was not
 * given*, so the one console anybody can open in a browser — and every
 * screenshot ever taken of the editor — showed it over a note the whole demo
 * workspace reads, and `e2e/webkit/voice.spec.ts` asserted the string it found.
 *
 * The check is against the fixture's own data rather than a sentence somebody
 * liked: change which note opens and this says so.
 *
 * SABOTAGE, and the second row is the interesting one:
 *
 * | edit | FAIL |
 * | --- | --- |
 * | drop `noteVisibility` from `fixtureVoicePage` | **1** — the field case only |
 * | point `defaultSelection` at a private note | **2** |
 *
 * Dropping the field does **not** move the sentence, and that is not a gap in
 * the fallback — it is the fallback working. A `team` note and a visibility
 * this build was not given are deliberately given the same words, because the
 * words have to be true in both cases. The consequence is worth stating
 * plainly: **the sentence a person reads cannot distinguish a surface that
 * knows the note is shared from one that failed to ask.** So the field is
 * asserted directly, and this file is the only thing standing between the
 * fixture and quietly going back to not asking.
 */

import { describe, expect, test } from "@jest/globals";
import { fixtureVoicePage } from "../features/console/E2EFixtureScreen";
import { demoTreeFor } from "../features/console/placeholderData";
import { offerDictation } from "../features/voice/audience";
import type { ConsoleData } from "../features/console/types";

/** The fixture's own files pane, as `useDemoConsoleData` hands it over. */
function fixtureFiles(): ConsoleData["files"] {
  const tree = demoTreeFor("seyi");
  return {
    selectedPath: tree.defaultSelection,
    listings: tree.listings,
    editor: undefined,
  } as unknown as ConsoleData["files"];
}

const PERSONAL = { slug: "seyi", kind: "personal" as const, role: "owner" as const };

describe("the fixture console's voice page", () => {
  test("carries the visibility of the note it is showing", () => {
    const tree = demoTreeFor("seyi");
    const entry = Object.values(tree.listings)
      .flatMap((listing) => listing.entries)
      .find((candidate) => candidate.path === tree.defaultSelection);

    // The premise, asserted rather than assumed: the note the fixture opens on
    // is a shared one. If this ever changes, the case below changes with it.
    expect(entry?.visibility).toBe("team");

    const page = fixtureVoicePage(fixtureFiles(), PERSONAL);
    expect(page.noteVisibility).toBe("team");
  });

  test("so the sheet does not say 'Only you.' over a note the workspace reads", () => {
    const tree = demoTreeFor("seyi");
    const page = fixtureVoicePage(fixtureFiles(), PERSONAL);

    const { audience } = offerDictation({
      engineAvailable: true,
      unavailable: "no engine here",
      noteOpen: page.notePath !== null,
      writable: page.writable,
      path: page.notePath ?? "",
      noteVisibility: page.noteVisibility,
      context: page.context,
    });

    /*
      Asserted before the sentence, because `audience` is `null` for every
      refusal this function can answer with — no engine, no note, read-only.
      Reading `.line` straight off it was a `tsc --noEmit` error, and the
      failure it would have hidden is the interesting one: a fixture that
      stopped offering dictation at all would then fail on a type error at
      runtime rather than on the claim this file is about.
    */
    expect(audience).not.toBeNull();
    expect(audience?.line).toBe(
      `Anyone you have shared ${tree.defaultSelection} with can read it.`,
    );
    expect(audience?.line).not.toContain("Only you");
  });
});
