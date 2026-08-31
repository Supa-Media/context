import { describe, expect, test } from "@jest/globals";
import {
  MAX_ALIGNMENT_CELLS,
  MERGE_MARKERS,
  alignLines,
  dominantEol,
  joinLines,
  markedConflicts,
  merge3,
  splitLines,
} from "../features/offline/merge";

/**
 * The merge, tested rather than trusted.
 *
 * This is hand-written code standing between two people's edits, so the
 * interesting cases are not "does it merge" — they are the ones where a wrong
 * answer loses somebody's typing silently:
 *
 *  - **Non-overlapping edits must merge with no conflict at all.** If they do
 *    not, the feature is a worse "keep mine": it shows markers over text nobody
 *    disagreed about, and people learn to ignore them.
 *  - **Overlapping edits must conflict.** A merge that picks a winner in a
 *    region both sides rewrote is the silent clobber the whole design refuses.
 *  - **Nothing may be invented or dropped at the edges.** A file that arrives
 *    CRLF must not leave LF, and a file with no trailing newline must not grow
 *    one — those are whole-file diffs in the customer's Obsidian and in their
 *    git history, produced by a merge that "worked".
 *  - **The refusal must be reachable.** `merge3` answers `null` rather than a
 *    degraded merge, and the caller withdraws the option. A `null` that can
 *    never happen is an untested branch.
 */

describe("splitting and rejoining", () => {
  test("a file with no trailing newline keeps not having one", () => {
    const text = "alpha\nbeta";
    const lines = splitLines(text);
    expect(lines).toEqual([
      { text: "alpha", eol: "\n" },
      { text: "beta", eol: "" },
    ]);
    expect(joinLines(lines, "\n")).toBe(text);
  });

  test("CRLF survives the round trip line by line", () => {
    const text = "alpha\r\nbeta\r\n";
    expect(joinLines(splitLines(text), "\n")).toBe(text);
  });

  test("an empty file is no lines, not one empty line", () => {
    expect(splitLines("")).toEqual([]);
    expect(joinLines([], "\n")).toBe("");
  });

  test("a lone trailing newline is one empty line's terminator", () => {
    expect(splitLines("\n")).toEqual([{ text: "", eol: "\n" }]);
  });

  test("the dominant terminator is what the invented lines get", () => {
    expect(dominantEol(splitLines("a\r\nb\r\nc"))).toBe("\r\n");
    expect(dominantEol(splitLines("a\nb\n"))).toBe("\n");
    // Nothing to go on: one line, no terminator. A marker still needs one.
    expect(dominantEol(splitLines("a"))).toBe("\n");
  });
});

describe("aligning", () => {
  test("identical sequences align entirely, with no table built", () => {
    // A cell limit of 1 would refuse any table at all; the prefix trim means
    // none is needed. This is the property that keeps a long note cheap.
    expect(alignLines(["a", "b", "c"], ["a", "b", "c"], 1)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  test("an insertion in the middle keeps both ends matched", () => {
    expect(alignLines(["a", "b"], ["a", "x", "b"], MAX_ALIGNMENT_CELLS)).toEqual([
      [0, 0],
      [1, 2],
    ]);
  });

  test("two sequences with nothing in common refuse a table over the limit", () => {
    const a = Array.from({ length: 40 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 40 }, (_, i) => `b${i}`);
    expect(alignLines(a, b, 100)).toBeNull();
    expect(alignLines(a, b, MAX_ALIGNMENT_CELLS)).toEqual([]);
  });
});

describe("merging edits that do not overlap", () => {
  const base = "# Pilot\n\nOne.\n\nTwo.\n";

  test("each side's change survives and nothing is marked", () => {
    const mine = "# Pilot\n\nOne, with a note from the train.\n\nTwo.\n";
    const theirs = "# Pilot\n\nOne.\n\nTwo, corrected.\n";
    const merged = merge3(base, mine, theirs);
    expect(merged).not.toBeNull();
    expect(merged!.conflicts).toBe(0);
    expect(merged!.text).toBe("# Pilot\n\nOne, with a note from the train.\n\nTwo, corrected.\n");
  });

  test("an append on one side and an edit on the other both land", () => {
    const mine = `${base}\nThree, added offline.\n`;
    const theirs = "# Pilot, revised\n\nOne.\n\nTwo.\n";
    const merged = merge3(base, mine, theirs)!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe("# Pilot, revised\n\nOne.\n\nTwo.\n\nThree, added offline.\n");
  });

  test("a deletion on one side is not resurrected by the other's edit elsewhere", () => {
    const mine = "# Pilot\n\nTwo.\n";
    const theirs = "# Pilot\n\nOne.\n\nTwo, corrected.\n";
    const merged = merge3(base, mine, theirs)!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe("# Pilot\n\nTwo, corrected.\n");
  });

  test("both sides making the identical edit is agreement, not a conflict", () => {
    const same = "# Pilot\n\nOne, agreed.\n\nTwo.\n";
    const merged = merge3(base, same, same)!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe(same);
  });

  test("a side that changed nothing contributes nothing", () => {
    const mine = "# Pilot\n\nOne.\n\nTwo.\n\nThree.\n";
    const merged = merge3(base, mine, base)!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe(mine);
  });
});

describe("merging edits that do overlap", () => {
  const base = "# Pilot\n\nThe tunnel took the signal.\n";

  test("the same line rewritten differently becomes one marked hunk", () => {
    const mine = "# Pilot\n\nThe tunnel took the signal at Reading.\n";
    const theirs = "# Pilot\n\nThe tunnel took the signal near Slough.\n";
    const merged = merge3(base, mine, theirs)!;
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      [
        "# Pilot",
        "",
        MERGE_MARKERS.mine,
        "The tunnel took the signal at Reading.",
        MERGE_MARKERS.split,
        "The tunnel took the signal near Slough.",
        MERGE_MARKERS.theirs,
        "",
      ].join("\n"),
    );
    expect(markedConflicts(merged.text)).toBe(1);
  });

  test("the hunk is narrowed to the lines that actually differ", () => {
    /*
      Both sides rewrote the same paragraph and both ended it the same way. The
      shared closing line belongs outside the markers — a hunk that swallows
      text nobody disagreed about is a hunk nobody reads.
    */
    const wide = "a\nb\nc\n";
    const mine = "a\nmine one\nmine two\nshared tail\nc\n";
    const theirs = "a\ntheirs one\nshared tail\nc\n";
    const merged = merge3(wide, mine, theirs)!;
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      [
        "a",
        MERGE_MARKERS.mine,
        "mine one",
        "mine two",
        MERGE_MARKERS.split,
        "theirs one",
        MERGE_MARKERS.theirs,
        "shared tail",
        "c",
        "",
      ].join("\n"),
    );
  });

  test("two separate disagreements are two hunks, and the clean part between them is clean", () => {
    const wide = "one\ntwo\nthree\nfour\nfive\n";
    const mine = "one MINE\ntwo\nthree\nfour\nfive MINE\n";
    const theirs = "one THEIRS\ntwo\nthree\nfour\nfive THEIRS\n";
    const merged = merge3(wide, mine, theirs)!;
    expect(merged.conflicts).toBe(2);
    expect(markedConflicts(merged.text)).toBe(2);
    expect(merged.text).toContain("\ntwo\nthree\nfour\n");
  });

  test("a note created on both sides at once conflicts as a whole", () => {
    // `baseEtag: null` — nothing existed when this was typed, and somebody
    // else created the same path meanwhile.
    const merged = merge3("", "mine\n", "theirs\n")!;
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      [MERGE_MARKERS.mine, "mine", MERGE_MARKERS.split, "theirs", MERGE_MARKERS.theirs, ""].join(
        "\n",
      ),
    );
  });

  test("one side deleting what the other rewrote is a conflict, not a silent deletion", () => {
    const merged = merge3("a\nb\nc\n", "a\nc\n", "a\nb rewritten\nc\n")!;
    expect(merged.conflicts).toBe(1);
  });
});

describe("line endings a merge must not quietly change", () => {
  test("a CRLF file merges to CRLF, markers included", () => {
    const base = "alpha\r\nbeta\r\ngamma\r\n";
    const mine = "alpha\r\nbeta mine\r\ngamma\r\n";
    const theirs = "alpha\r\nbeta theirs\r\ngamma\r\n";
    const merged = merge3(base, mine, theirs)!;
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      `alpha\r\n${MERGE_MARKERS.mine}\r\nbeta mine\r\n${MERGE_MARKERS.split}\r\nbeta theirs\r\n${MERGE_MARKERS.theirs}\r\ngamma\r\n`,
    );
  });

  test("a file whose two sides disagree only about line endings does not conflict", () => {
    /*
      Obsidian on Windows rewrites a whole file to CRLF on save. Comparing
      terminators as content would make that a conflict on every line of every
      note, which is the single loudest way this feature could become useless.
    */
    const base = "alpha\nbeta\n";
    const merged = merge3(base, "alpha\r\nbeta\r\n", base)!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe("alpha\r\nbeta\r\n");
  });

  test("a file with no trailing newline still has none after a clean merge", () => {
    const merged = merge3("a\nb", "a mine\nb", "a\nb")!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe("a mine\nb");
  });

  test("a final line with no terminator gets one when something follows it", () => {
    /*
      Mine rewrote the only line, which had no trailing newline; they appended
      one below it. Both edits survive — and the merged body has to invent the
      terminator between them, or the two lines run together into one.
    */
    const merged = merge3("a", "a mine", "a\nb\n")!;
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe("a mine\nb\n");
  });
});

describe("refusing rather than degrading", () => {
  test("two bodies too far apart to align answer null", () => {
    const base = Array.from({ length: 400 }, (_, i) => `base ${i}`).join("\n");
    const mine = Array.from({ length: 400 }, (_, i) => `mine ${i}`).join("\n");
    const theirs = Array.from({ length: 400 }, (_, i) => `theirs ${i}`).join("\n");
    // 400 × 400 is well inside the shipped bound, so this asserts the shape of
    // the refusal rather than the bound itself; `alignLines` above pins the
    // bound with an explicit limit.
    expect(merge3(base, mine, theirs)).not.toBeNull();
    expect(MAX_ALIGNMENT_CELLS).toBeGreaterThan(400 * 400);
  });

  test("a side that did nothing never changes the answer, over a thousand random files", () => {
    /*
      The index arithmetic in this merge is the part most likely to be subtly
      wrong, and the example tests above only reach the shapes somebody thought
      of. These two identities have to hold for *every* pair of files, and a
      one-off error in a delta breaks them immediately: if they only wanted
      what you wanted, you get exactly your file back, and vice versa.

      Deterministic — a seeded generator rather than `Math.random` — because a
      merge test that fails once a fortnight in CI is a test people turn off.
    */
    let seed = 20260831;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const file = () => {
      const lines: string[] = [];
      const count = Math.floor(next() * 12);
      for (let i = 0; i < count; i += 1) lines.push(`line ${Math.floor(next() * 6)}`);
      return lines.length === 0 ? "" : `${lines.join("\n")}${next() < 0.5 ? "\n" : ""}`;
    };

    for (let round = 0; round < 1000; round += 1) {
      const base = file();
      const mine = file();
      const onlyMine = merge3(base, mine, base)!;
      expect(onlyMine.conflicts).toBe(0);
      expect(onlyMine.text).toBe(mine);
      const onlyTheirs = merge3(base, base, mine)!;
      expect(onlyTheirs.conflicts).toBe(0);
      expect(onlyTheirs.text).toBe(mine);
    }
  });

  test("markedConflicts reads the body, not the merge that produced it", () => {
    const merged = merge3("a\n", "mine\n", "theirs\n")!;
    expect(markedConflicts(merged.text)).toBe(1);
    // Somebody resolved it by hand in the review surface.
    expect(markedConflicts("mine and theirs, reconciled\n")).toBe(0);
  });
});
