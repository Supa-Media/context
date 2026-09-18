/**
 * The status strip's content, without a renderer.
 *
 * The rule this file exists for is the last one: a bucket that cannot do
 * conditional writes must *say so*, in a tone that is not the tone used for a
 * bucket that can. `CLAUDE.md` calls that "degrade honestly — never silently
 * drop conflict detection", and a UI that renders `read-compare` as calmly as
 * `conditional` has dropped it silently while looking fine.
 *
 * The other rule worth pinning is the negative one: no segment may contain note
 * text. Counts are derived from the draft; nothing is quoted out of it.
 */

import { describe, expect, test } from "@jest/globals";
import {
  countWords,
  relativeTime,
  saveChip,
  statusSegments,
  TRAILING_SEGMENTS,
  type StatusFacts,
  type StatusSegment,
} from "../features/console/files/status";
import { emptyEditor, type EditorState, type EditorStatus } from "../features/console/files/editor";

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const NOW = new Date(2026, 2, 12, 12, 0, 0).getTime();

function editorWith(status: EditorStatus, draft = "hello world", extra: Partial<EditorState> = {}): EditorState {
  return {
    ...emptyEditor,
    status,
    path: status === "empty" ? null : "1-projects/plan.md",
    baseline: draft,
    draft,
    etag: "etag-1",
    ...extra,
  };
}

function facts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return {
    editor: editorWith("clean"),
    storageLabel: "R2 · notes-bucket",
    now: NOW,
    ...overrides,
  };
}

function byId(segments: StatusSegment[], id: StatusSegment["id"]): StatusSegment | undefined {
  return segments.find((segment) => segment.id === id);
}

/** The top bar's save claim for one editor status. */
function chipFor(status: EditorStatus, draft = "hello world"): StatusSegment | null {
  return saveChip({ editor: editorWith(status, draft), now: NOW });
}

/* -------------------------------------------------------------------------- */
/*                                   counts                                   */
/* -------------------------------------------------------------------------- */

describe("counting a draft", () => {
  test("words split on whitespace runs and ignore the edges", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("  hello   world  ")).toBe(2);
    expect(countWords("one\ntwo\tthree\r\nfour")).toBe(4);
  });

  test("nothing, or only whitespace, is zero words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("\n\t  \n")).toBe(0);
  });

  test("a hyphenated word is one word", () => {
    expect(countWords("read-compare")).toBe(1);
    expect(countWords("read-compare writes are best-effort")).toBe(4);
  });

  /**
   * NO CHARACTER COUNT, AND NO COUNTER EITHER.
   *
   * "61 words" and "390 characters" are the same fact told twice, and the
   * second needed a tooltip to explain that it was counting UTF-16 code units
   * rather than anything a reader can see. The canvas's bar is
   * `path … words · R2` — the save claim is `saveChip`'s, in the top bar.
   *
   * `countUnits` went with the segment rather than staying as a helper nobody
   * calls, so what is left to assert is the absence — and it is asserted
   * beside the count that stayed, so it cannot pass by rendering nothing.
   */
  test("the bar does not draw a character count", () => {
    const segments = statusSegments(facts({ editor: editorWith("clean", "abcde") }));
    expect(segments.map((segment) => segment.id)).not.toContain("characters");
    // Not passing because nothing rendered: the count that stayed is here.
    expect(byId(segments, "words")?.text).toBe("1 word");
  });

  test("singulars read as singulars, and big counts are grouped", () => {
    const one = statusSegments(facts({ editor: editorWith("clean", "solo") }));
    expect(byId(one, "words")?.text).toBe("1 word");

    const many = statusSegments(
      facts({ editor: editorWith("clean", "word ".repeat(1234).trim()) }),
    );
    expect(byId(many, "words")?.text).toBe("1,234 words");
  });

  test("with nothing open there are no counts about no file", () => {
    const segments = statusSegments(facts({ editor: emptyEditor }));
    expect(byId(segments, "words")).toBeUndefined();
    // And the path, which is the other thing that would be about no file.
    expect(byId(segments, "path")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                                    save                                    */
/* -------------------------------------------------------------------------- */

/**
 * THE SAVE CLAIM IS NOT IN THE STRIP ANY MORE, AND EVERY ARM OF IT SURVIVED.
 *
 * It is `saveChip`, drawn in the top bar beside the bucket chip — see that
 * function for the argument. What matters here is that moving it was a move
 * and not a rewrite: the words, the tones and the details below are the ones
 * this file has always asserted, re-pointed at the function that answers them.
 *
 * The first case is the guard on the move itself. Without it, a change that
 * put the segment back would leave the console saying "Saved" twice — once at
 * the top-right and once at the bottom-right, in two visual languages, which
 * is the duplication both surfaces have now been through once.
 */
describe("the save claim", () => {
  test("the strip does not carry it", () => {
    for (const status of ["clean", "dirty", "saving", "saved", "queued", "conflict", "error"] as EditorStatus[]) {
      expect(byId(statusSegments(facts({ editor: editorWith(status) })), "save")).toBeUndefined();
    }
    // Not passing because nothing rendered: the strip still says the rest.
    expect(byId(statusSegments(facts()), "words")?.text).toBe("2 words");
  });

  test("clean says when, or just says saved", () => {
    const withTime = saveChip({ editor: editorWith("clean"), now: NOW, savedAt: NOW - 10 * 60_000 });
    expect(withTime?.text).toBe("Saved 10 minutes ago");
    expect(withTime?.tone).toBe("quiet");

    expect(chipFor("clean")?.text).toBe("Saved");
  });

  test("a draft on its way to the bucket is not a warning", () => {
    /*
      This asserted "Unsaved changes", `warn`, which was true while the only
      route into the bucket was a button. Autosave writes it a couple of
      seconds after typing stops, so a standing warning over typing is the
      console asking to be looked after — and the tones that are left mean
      something again: `queued`, `error` and a cached body are the states that
      persist without the bucket hearing about them.
    */
    const dirty = chipFor("dirty", "typed more");
    expect(dirty?.text).toBe("Saving soon");
    expect(dirty?.tone).toBe("quiet");
    expect(dirty?.detail).toContain("written to your bucket");
    // The states that really are not in the bucket keep their tone.
    expect(chipFor("queued")?.tone).toBe("warn");
    expect(chipFor("error")?.tone).toBe("crit");
  });

  test("saving, and having just saved", () => {
    expect(chipFor("saving")?.text).toBe("Saving…");
    const saved = chipFor("saved");
    expect(saved?.text).toBe("Saved");
    expect(saved?.tone).toBe("ok");
  });

  test("a conflict and a failure are both critical", () => {
    expect(chipFor("conflict")?.tone).toBe("crit");
    expect(chipFor("error")?.tone).toBe("crit");
  });

  test("the editor's own message becomes the detail when it has one", () => {
    const editor = editorWith("error", "draft", { message: "The bucket refused the write." });
    expect(saveChip({ editor, now: NOW })?.detail).toBe("The bucket refused the write.");
  });

  test("nothing open means no chip at all", () => {
    expect(saveChip({ editor: emptyEditor, now: NOW })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                               conflict check                               */
/* -------------------------------------------------------------------------- */

describe("how the last save checked for conflicts", () => {
  test("nothing is claimed before anything has been saved", () => {
    expect(byId(statusSegments(facts()), "conflictCheck")).toBeUndefined();
  });

  test("conditional writes are quiet, and say the check is part of the write", () => {
    const segment = byId(statusSegments(facts({ conflictCheck: "conditional" })), "conflictCheck");
    expect(segment?.text).toBe("Conditional writes");
    expect(segment?.tone).toBe("quiet");
    expect(segment?.detail).toMatch(/refused/i);
  });

  test("read-compare is a warning, and says plainly what can still be missed", () => {
    const segment = byId(statusSegments(facts({ conflictCheck: "read-compare" })), "conflictCheck");
    expect(segment?.text).toBe("Read-compare writes");
    expect(segment?.tone).toBe("warn");
    expect(segment?.detail).toMatch(/cannot do conditional writes/i);
    expect(segment?.detail).toMatch(/re-reading/i);
    expect(segment?.detail).toMatch(/missed/i);
  });

  /**
   * "Degrade honestly" in test form. Both halves matter: a `read-compare`
   * segment that is quiet says the weaker guarantee is fine, and a missing one
   * says nothing at all — which is worse.
   */
  test("read-compare is never quiet, never absent, and never the same tone as conditional", () => {
    const conditional = byId(
      statusSegments(facts({ conflictCheck: "conditional" })),
      "conflictCheck",
    );
    const readCompare = byId(
      statusSegments(facts({ conflictCheck: "read-compare" })),
      "conflictCheck",
    );

    expect(readCompare).toBeDefined();
    expect(readCompare?.tone).not.toBe("quiet");
    expect(readCompare?.tone).not.toBe("ok");
    expect(readCompare?.tone).not.toBe(conditional?.tone);
  });

  test("the segment survives every editor status, including a failed save", () => {
    const statuses: EditorStatus[] = ["empty", "clean", "dirty", "saving", "saved", "conflict", "error"];
    for (const status of statuses) {
      const segments = statusSegments(
        facts({ editor: editorWith(status), conflictCheck: "read-compare" }),
      );
      expect(byId(segments, "conflictCheck")?.tone).toBe("warn");
    }
  });

  test("the editor's own record of the last save is used when the caller passes none", () => {
    const editor = editorWith("saved", "draft", { conflictCheck: "read-compare" });
    expect(byId(statusSegments(facts({ editor })), "conflictCheck")?.tone).toBe("warn");
  });
});

/* -------------------------------------------------------------------------- */
/*                                  storage                                   */
/* -------------------------------------------------------------------------- */

describe("the storage segment", () => {
  test("names the bucket, and is absent when none is bound", () => {
    expect(byId(statusSegments(facts()), "storage")?.text).toBe("R2 · notes-bucket");
    expect(byId(statusSegments(facts({ storageLabel: null })), "storage")).toBeUndefined();
  });

  test("the index, the conflict check and storage are the trailing group, in that order", () => {
    const segments = statusSegments(
      facts({
        conflictCheck: "conditional",
        index: { label: "62% indexed", detail: "…", tone: "quiet" },
      }),
    );
    const ids = segments.map((segment) => segment.id);
    expect(ids).toEqual([
      "path",
      "words",
      "index",
      "conflictCheck",
      "storage",
    ]);
    expect(ids.slice(-TRAILING_SEGMENTS.length)).toEqual([...TRAILING_SEGMENTS]);
  });

  test("the index does not sit next to the bucket", () => {
    /*
      They describe different objects: the bucket is the customer's own, and
      the fast-search index is a copy in a database Supa Media runs. Run
      together — "R2 · notes-bucket · 62% indexed" — the figure reads as 62% of the
      bucket, which is a claim about somebody's own storage that nothing has
      measured. That is the species of invention issue #25 was about, and the
      cheapest guard against it is the ordering.
    */
    const ids = statusSegments(
      facts({
        conflictCheck: "conditional",
        index: { label: "62% indexed", detail: "…", tone: "quiet" },
      }),
    ).map((segment) => segment.id);
    expect(Math.abs(ids.indexOf("index") - ids.indexOf("storage"))).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the index                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much of this context is in the hosted fast-search index.
 *
 * The strip is where a person sees this without opening settings, and the one
 * rule that is a security property rather than a presentation choice is that a
 * viewer who was told nothing is shown nothing: the backfill counters are
 * owner-only because the index counts private notes a member may not read, so
 * a percentage of that total is the size of what they are not being shown.
 * `describeIndexProgress` answers `null` for them, and this strip has to omit
 * the segment rather than substitute a placeholder — an em dash says a figure
 * exists and is being withheld, which is most of what the figure would say.
 */
describe("the index segment", () => {
  test("draws exactly the words it was handed", () => {
    const segment = byId(
      statusSegments(
        facts({ index: { label: "62% indexed", detail: "620 of 1,000.", tone: "quiet" } }),
      ),
      "index",
    );
    expect(segment?.text).toBe("62% indexed");
    expect(segment?.detail).toBe("620 of 1,000.");
    expect(segment?.tone).toBe("quiet");
  });

  test("a viewer who was told nothing is shown nothing — no placeholder", () => {
    // `null` is a member (owner-only census), a context with fast search off,
    // and a status that has not answered. All three draw no segment.
    for (const index of [null, undefined]) {
      const segments = statusSegments(facts({ index }));
      expect(byId(segments, "index")).toBeUndefined();
      const rendered = segments.map((s) => `${s.text} ${s.detail ?? ""}`).join(" ");
      expect(rendered).not.toMatch(/%/);
      expect(rendered).not.toMatch(/indexed/i);
      expect(rendered).not.toMatch(/—/);
    }
  });

  test("a stopped backfill keeps the tone it arrived with", () => {
    // Carried, never re-derived from the string. A strip that matched on
    // "Stopped" goes quiet the day the copy is reworded.
    expect(
      byId(
        statusSegments(
          facts({ index: { label: "Stopped at 62% indexed", detail: "…", tone: "warn" } }),
        ),
        "index",
      )?.tone,
    ).toBe("warn");
  });
});

/* -------------------------------------------------------------------------- */
/*                                relative time                               */
/* -------------------------------------------------------------------------- */

describe("relativeTime", () => {
  test("under 45 seconds is just now", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 44_000, NOW)).toBe("just now");
  });

  test("minutes, then hours", () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe("59 minutes ago");
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(relativeTime(NOW - 5 * 3_600_000, NOW)).toBe("5 hours ago");
    expect(relativeTime(NOW - 23 * 3_600_000, NOW)).toBe("23 hours ago");
  });

  test("yesterday, then a plain date", () => {
    expect(relativeTime(NOW - 25 * 3_600_000, NOW)).toBe("yesterday");
    expect(relativeTime(new Date(2026, 2, 2, 12, 0, 0).getTime(), NOW)).toBe("2 Mar");
    expect(relativeTime(new Date(2025, 10, 4, 12, 0, 0).getTime(), NOW)).toBe("4 Nov 2025");
  });

  /**
   * Clocks disagree — a bucket timestamp, another device, a machine being
   * corrected by NTP. "in -3 minutes" is a bug report, not information.
   */
  test("a future timestamp degrades to just now rather than counting down", () => {
    expect(relativeTime(NOW + 3 * 60_000, NOW)).toBe("just now");
    expect(relativeTime(NOW + 40 * 24 * 3_600_000, NOW)).toBe("just now");
  });
});

/* -------------------------------------------------------------------------- */
/*                                note content                                */
/* -------------------------------------------------------------------------- */

describe("the strip never carries note text", () => {
  /**
   * The same rule that keeps note content out of structured logs. A status bar
   * is derived from the draft — counts, states — and quotes none of it, so a
   * screen share, a screenshot in an issue, or a bug report cannot leak what
   * somebody was typing.
   */
  test("a draft that looks like a secret appears nowhere in the segments", () => {
    const secret = "sk-live-EXAMPLE-NOT-A-REAL-KEY-9f3a";
    const draft = `# notes\n\ntoken: ${secret}\nmore prose here\n`;

    for (const status of ["clean", "dirty", "saving", "saved", "conflict", "error"] as EditorStatus[]) {
      const segments = statusSegments(
        facts({
          editor: editorWith(status, draft, { message: "Saved." }),
          conflictCheck: "read-compare",
          savedAt: NOW - 60_000,
        }),
      );
      const rendered = segments.map((s) => `${s.text} ${s.detail ?? ""}`).join(" ");
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain("sk-live");
      expect(rendered).not.toContain("more prose here");
    }
  });

  /**
   * **This asserted the opposite, and the reversal is the point of keeping it.**
   *
   * It read "nor does it carry the note's path", under a rule that was really
   * about *note content* — the draft's text, which is what a screen share or a
   * screenshot in an issue can leak and which no segment may ever quote. That
   * rule is unchanged and is the case above.
   *
   * A path is not content. It is the note's address, and it was already on the
   * glass three times over: the file tree names it, the breadcrumb above the
   * note walks it, and the tab strip carries its stem. A bar that withheld it
   * was not protecting anything — it was the one surface that never moves and
   * never said which file you were looking at, which is exactly what a person
   * copies into another client or an agent's tool call.
   *
   * So the path is a segment, drawn in the mono face at the leading edge, and
   * what this holds now is that it is the *key* and nothing else: no draft
   * text rides along with it.
   */
  test("the path is the key, and carries none of the draft with it", () => {
    const secret = "sk-live-EXAMPLE-NOT-A-REAL-KEY-9f3a";
    const editor = editorWith("dirty", `# notes\n\ntoken: ${secret}\n`);
    const path = byId(statusSegments(facts({ editor })), "path");

    expect(path?.text).toBe("1-projects/plan.md");
    expect(path?.mono).toBe(true);
    expect(`${path?.text} ${path?.detail ?? ""}`).not.toContain(secret);
  });

  test("and there is no path segment with no note open", () => {
    // Counts and a key about no file are the same mistake; both are gated on
    // `editor.path`.
    const closed = statusSegments(facts({ editor: editorWith("empty", "") }));
    expect(byId(closed, "path")).toBeUndefined();
    expect(byId(closed, "words")).toBeUndefined();
  });
});
