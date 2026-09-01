/**
 * THE THREE-POSITION VISIBILITY CONTROL.
 *
 * One lock beside Share, cycling private → team → anyone-with-the-link. Two of
 * those come from `privacy.md` and the third is a share row, so the interesting
 * properties are about composing two sources without letting them disagree —
 * and the direction any disagreement must fail is "the control says less is
 * published than actually is", never more.
 */

import { describe, expect, test } from "@jest/globals";
import {
  SCOPE_ICON,
  nextScope,
  scopeActionLabel,
  scopeOf,
  stepsTo,
  type NoteScope,
} from "../features/console/files/scope";

describe("what the control shows", () => {
  test("the manifest decides the first two", () => {
    expect(scopeOf("private", false)).toBe("private");
    expect(scopeOf("team", false)).toBe("team");
  });

  test("a live link over a team note is the third", () => {
    expect(scopeOf("team", true)).toBe("anyone");
  });

  /**
   * THE rule of this module. A link over a note that has since been made
   * private grants nothing — the server re-derives visibility from the live
   * `privacy.md` on every read — so drawing a globe would tell somebody they
   * had published something they had not. The stale row is inert; the icon
   * must not dignify it.
   */
  test("a private note is private however many links point at it", () => {
    expect(scopeOf("private", true)).toBe("private");
  });
});

describe("where a press goes", () => {
  test("the cycle widens one step at a time and closes in one", () => {
    expect(nextScope("private")).toBe("team");
    expect(nextScope("team")).toBe("anyone");
    expect(nextScope("private")).not.toBe("anyone");
    expect(nextScope("anyone")).toBe("private");
  });

  test("three presses return to where they started", () => {
    const scopes: NoteScope[] = ["private", "team", "anyone"];
    for (const start of scopes) {
      expect(nextScope(nextScope(nextScope(start)))).toBe(start);
    }
  });

  /**
   * The accident worth making impossible: one press from a private note to a
   * link anybody can open. The cycle passes through `team`, so publishing to
   * the internet is always at least two deliberate presses from a state the
   * icon has been showing.
   */
  test("no single press takes a private note to a public link", () => {
    expect(nextScope("private")).not.toBe("anyone");
  });

  /**
   * A folder keeps its two positions, and not as a policy choice made in the
   * console: `createLinkShare` is note-only, so a third position on a folder
   * would be a press that always fails.
   */
  test("a folder cycles between two positions", () => {
    expect(nextScope("private", false)).toBe("team");
    expect(nextScope("team", false)).toBe("private");
  });
});

describe("the icon draws the state a note is in", () => {
  test("shut for private, open for team, a globe for a link", () => {
    expect(SCOPE_ICON.private).toBe("lock");
    expect(SCOPE_ICON.team).toBe("lockOpen");
    expect(SCOPE_ICON.anyone).toBe("globe");
  });

  test("…while the label names where the press goes", () => {
    // Deliberately disagreeing: the icon is looked at, the label is read aloud
    // before the press. See `ICON_NAMES`.
    expect(scopeActionLabel(nextScope("private"))).toBe("Share this with your team");
    expect(scopeActionLabel(nextScope("team"))).toBe("Make a link anyone can open");
    expect(scopeActionLabel(nextScope("anyone"))).toBe("Make this private");
  });

  test("every position has both", () => {
    for (const scope of ["private", "team", "anyone"] as NoteScope[]) {
      expect(SCOPE_ICON[scope]).toBeTruthy();
      expect(scopeActionLabel(scope)).toBeTruthy();
    }
  });
});

describe("what a move actually does", () => {
  test("publishing to the team is one manifest write", () => {
    expect(stepsTo("private", "team")).toEqual([{ kind: "visibility", to: "team" }]);
  });

  test("minting a link touches no manifest, because the note is already team", () => {
    expect(stepsTo("team", "anyone")).toEqual([{ kind: "openLink", on: true }]);
  });

  /**
   * The order is the decision. Either order is safe once both land, and so is
   * either single failure — but a failed revoke *after* a narrowing leaves a
   * private note with a live link row beside it, which is the state this
   * control exists never to show. Revoking first fails the other way.
   */
  test("closing takes the link back before it narrows the manifest", () => {
    expect(stepsTo("anyone", "private")).toEqual([
      { kind: "openLink", on: false },
      { kind: "visibility", to: "private" },
    ]);
  });

  test("stepping back to team takes the link back and leaves the manifest alone", () => {
    expect(stepsTo("anyone", "team")).toEqual([{ kind: "openLink", on: false }]);
  });

  test("a move to where you already are does nothing", () => {
    for (const scope of ["private", "team", "anyone"] as NoteScope[]) {
      expect(stepsTo(scope, scope)).toEqual([]);
    }
  });

  /**
   * Not reachable through the cycle, and it still has to be right: a caller
   * that jumped straight there must publish before it mints, or the link would
   * be minted over a note the server refuses to serve through it.
   */
  test("a direct jump from private publishes before it mints", () => {
    expect(stepsTo("private", "anyone")).toEqual([
      { kind: "visibility", to: "team" },
      { kind: "openLink", on: true },
    ]);
  });

  test("every move ends somewhere consistent with what it asked for", () => {
    const scopes: NoteScope[] = ["private", "team", "anyone"];
    for (const from of scopes) {
      for (const to of scopes) {
        // Replay the steps over the two pieces of state they act on.
        let visibility: "private" | "team" = from === "private" ? "private" : "team";
        let link = from === "anyone";
        for (const step of stepsTo(from, to)) {
          if (step.kind === "visibility") visibility = step.to;
          else link = step.on;
        }
        expect(scopeOf(visibility, link)).toBe(to);
      }
    }
  });
});
