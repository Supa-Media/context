/**
 * A three-way merge, written here rather than installed.
 *
 * ## Why this exists at all
 *
 * A conflict in this product is two people (or a person and an AI client)
 * editing the same note, which is the ordinary case rather than an accident —
 * the bucket is open in Obsidian and written by connected clients. Offering
 * only "keep theirs" or "keep mine" makes somebody throw away one of two edits
 * that, nine times out of ten, do not touch the same paragraph.
 *
 * A real merge needs a **common ancestor**, and this feature already has one:
 * the read cache holds the note's body at the etag the draft was typed against.
 * So `base` is not invented here, it is read back — and where it is genuinely
 * absent (evicted, or the draft outlived it) the answer is to **not offer a
 * merge at all**. A two-way diff dressed up as a merge would be a guess
 * presented as an informed proposal, which is the one thing this repo's copy
 * rules forbid. See `resolution.ts`, which is where that decision is made.
 *
 * ## Why no dependency
 *
 * `runtimeVersion` is pinned and a mobile package that grows a second React (or
 * a second anything, see CLAUDE.md) breaks native rendering in ways CI cannot
 * see. diff3 is a small, well-understood algorithm; the cost of writing it is
 * one file and a test, and the test is the point — an unverified merge is worse
 * than none, because it is confidently wrong.
 *
 * ## Line endings, and why lines are split from their terminators
 *
 * A `Line` is content plus the terminator that followed it. Two lines are
 * *equal* when their content matches, so a file synced through a Windows
 * Obsidian (CRLF) and one written by the gateway (LF) do not read as a
 * whole-file conflict — and the terminator each line actually carried is what
 * gets written back, so a merge does not silently re-line-ending somebody's
 * file. A final line with no terminator carries `eol: ""`, which is how a file
 * with no trailing newline survives the round trip.
 */

/** One line: its content, and the terminator that followed it (`""` at EOF). */
export interface Line {
  text: string;
  eol: string;
}

/**
 * The three markers a conflicted region is wrapped in.
 *
 * Git's shape, deliberately: it is the one convention a person editing markdown
 * has probably seen, and it is unambiguous in a plain file. The labels say
 * *where* each side is rather than naming a branch, because there are no
 * branches here — there is what is on this device and what is in the bucket.
 */
export const MERGE_MARKERS = {
  mine: "<<<<<<< Yours, on this device",
  split: "=======",
  theirs: ">>>>>>> Theirs, in your bucket",
} as const;

/**
 * The largest alignment table this will build, in cells.
 *
 * The merge aligns two pairs of line arrays with a dynamic-programming LCS,
 * which is O(n·m) in both time and memory. Common prefixes and suffixes are
 * trimmed first, so what remains is the part that actually differs and is tiny
 * for a real edit. This bound is what happens when it is not — two thousand
 * changed lines against two thousand others — and the answer there is to say
 * **no merge is available** rather than to spend eight seconds and 200MB
 * producing one. `MAX_NOTE_BYTES` is 2MB in the control plane, so a
 * pathological note can reach that shape.
 */
export const MAX_ALIGNMENT_CELLS = 4_000_000;

/** Split text into lines, keeping each line's own terminator. */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  while (i < text.length) {
    let end = i;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end += 1;
    const content = text.slice(i, end);
    let eol = "";
    if (end < text.length) {
      if (text[end] === "\r" && text[end + 1] === "\n") {
        eol = "\r\n";
        end += 2;
      } else {
        eol = text[end];
        end += 1;
      }
    }
    lines.push({ text: content, eol });
    i = end;
  }
  return lines;
}

/**
 * The terminator this file mostly uses, for the lines the merge has to invent.
 *
 * Only the marker lines are invented; every line that came from a file keeps
 * the terminator it arrived with. A file with no terminators at all (one line,
 * no trailing newline) answers `"\n"`, because the moment a marker is written
 * there *is* more than one line.
 */
export function dominantEol(...groups: readonly Line[][]): string {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (const lines of groups) {
    for (const line of lines) {
      if (line.eol === "\r\n") crlf += 1;
      else if (line.eol === "\n") lf += 1;
      else if (line.eol === "\r") cr += 1;
    }
  }
  if (crlf > lf && crlf > cr) return "\r\n";
  if (cr > lf && cr > crlf) return "\r";
  return "\n";
}

/**
 * Join lines back into text, giving any line that lost its terminator one.
 *
 * Only the final line may end without a terminator, and it keeps whatever it
 * had — so "no trailing newline" survives a merge that did not touch the end of
 * the file, and does not survive one that appended to it, which is correct
 * either way.
 */
export function joinLines(lines: readonly Line[], eol: string): string {
  return lines
    .map((line, index) =>
      index === lines.length - 1 ? line.text + line.eol : line.text + (line.eol || eol),
    )
    .join("");
}

/**
 * Matched line pairs between two sequences, longest-common-subsequence order.
 *
 * `null` when the two are too far apart to align inside `MAX_ALIGNMENT_CELLS`.
 * Common prefix and suffix are matched directly and excluded from the table,
 * which is what keeps an ordinary edit — a paragraph changed in a long note —
 * to a handful of cells.
 */
export function alignLines(
  a: readonly string[],
  b: readonly string[],
  cellLimit = MAX_ALIGNMENT_CELLS,
): [number, number][] | null {
  const pairs: [number, number][] = [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    pairs.push([head, head]);
    head += 1;
  }

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const n = a.length - head - tail;
  const m = b.length - head - tail;

  if (n > 0 && m > 0) {
    if ((n + 1) * (m + 1) > cellLimit) return null;
    /*
      A plain LCS table. `Uint32Array` rather than nested arrays because the
      bound above is expressed in cells and a flat typed array is the only
      shape whose memory that number actually describes.
    */
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[head + i] === b[head + j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  for (let k = tail; k > 0; k -= 1) {
    pairs.push([a.length - k, b.length - k]);
  }

  return pairs;
}

/**
 * One side's edit, expressed as a range of `base` it replaces.
 *
 * Ranges rather than "lines both alignments matched" is the difference between
 * a merge that is useful and one that is not. The conservative form — treat any
 * base line either side touched as unstable — turns *a deletion here and an
 * edit three lines down* into a whole-file conflict, because the alignment has
 * no anchor between them. Two edits are only in each other's way when the base
 * text they replace actually overlaps, and that is what this expresses.
 */
interface Change {
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

/** The gaps between matched pairs: everything one side did to `base`. */
function changesFrom(
  pairs: readonly [number, number][],
  baseLength: number,
  sideLength: number,
): Change[] {
  const changes: Change[] = [];
  let b = 0;
  let s = 0;
  const push = (baseEnd: number, sideEnd: number) => {
    if (baseEnd > b || sideEnd > s) {
      changes.push({ baseStart: b, baseEnd, sideStart: s, sideEnd });
    }
  };
  for (const [bi, si] of pairs) {
    push(bi, si);
    b = bi + 1;
    s = si + 1;
  }
  push(baseLength, sideLength);
  return changes;
}

/** Do two base ranges get in each other's way? */
function collides(a: Change, b: Change): boolean {
  // Genuine overlap of the text each replaces.
  if (a.baseStart < b.baseEnd && b.baseStart < a.baseEnd) return true;
  // Two insertions at the same point. They replace nothing, so the test above
  // says no — and emitting both would silently duplicate the position rather
  // than asking whose text goes there.
  return a.baseStart === b.baseStart && a.baseStart === a.baseEnd && b.baseStart === b.baseEnd;
}

function sameLines(a: readonly Line[], b: readonly Line[]): boolean {
  return a.length === b.length && a.every((line, index) => line.text === b[index].text);
}

export interface Merge3Result {
  /** The proposed text. Shown for review and edited before it is ever saved. */
  text: string;
  /** How many regions the two sides genuinely disagree on. Often zero. */
  conflicts: number;
}

/**
 * Merge `mine` and `theirs` over their common ancestor `base`.
 *
 * Non-overlapping edits merge silently: a paragraph one side added and a
 * heading the other side fixed both survive, with nothing for a person to do.
 * A region both sides rewrote differently becomes a **marked conflict hunk** in
 * the result — both versions, in the open, labelled — because a merge that
 * picked a winner there would be exactly the silent clobber this whole feature
 * exists to prevent.
 *
 * `null` means the three files are too far apart to align inside
 * `MAX_ALIGNMENT_CELLS`. That is a refusal, not an empty merge: the caller must
 * withdraw the Merge option rather than offer a degraded one.
 */
export function merge3(base: string, mine: string, theirs: string): Merge3Result | null {
  const baseLines = splitLines(base);
  const mineLines = splitLines(mine);
  const theirsLines = splitLines(theirs);

  const minePairs = alignLines(
    baseLines.map((line) => line.text),
    mineLines.map((line) => line.text),
  );
  const theirsPairs = alignLines(
    baseLines.map((line) => line.text),
    theirsLines.map((line) => line.text),
  );
  if (minePairs === null || theirsPairs === null) return null;

  const mineChanges = changesFrom(minePairs, baseLines.length, mineLines.length);
  const theirsChanges = changesFrom(theirsPairs, baseLines.length, theirsLines.length);

  const eol = dominantEol(mineLines, theirsLines, baseLines);
  const out: Line[] = [];
  let conflicts = 0;

  /*
    `cursor` walks `base`; `mineDelta` and `theirsDelta` are how far each side
    has drifted from it. A side index is therefore always `baseIndex + delta`,
    which is exact at every cluster edge because the only thing that moves a
    delta is a change this loop has already consumed. An earlier draft looked
    the positions up in a precomputed table and got them wrong in one case: a
    pure insertion sitting exactly on a cluster's far edge was pulled into the
    cluster it was not part of, which duplicated a paragraph.
  */
  let cursor = 0;
  let m = 0;
  let t = 0;
  let mineDelta = 0;
  let theirsDelta = 0;
  const spanOf = (change: Change) =>
    change.sideEnd - change.sideStart - (change.baseEnd - change.baseStart);

  /*
    A run all three agree on, emitted line by line so each line keeps the
    terminator whoever touched it was looking at.

    The content is the same in all three by construction, so the only question
    is whose `eol` to write back — and getting it wrong is not cosmetic. A whole
    file re-terminated is a whole-file diff in the customer's Obsidian and in
    their git history, produced by a merge that "changed nothing". So a line the
    person typing did not re-type keeps the bucket's terminator, and one they
    did keeps theirs.
  */
  const agreed = (from: number, to: number): Line[] => {
    const run: Line[] = [];
    for (let b = from; b < to; b += 1) {
      const ours = mineLines[b + mineDelta];
      run.push(ours.eol === baseLines[b].eol ? theirsLines[b + theirsDelta] : ours);
    }
    return run;
  };

  while (m < mineChanges.length || t < theirsChanges.length) {
    /*
      The next cluster starts at whichever side's next edit comes first, and
      then grows: every edit from either side that collides with the range so
      far joins it, because a decision about one of them is a decision about
      all of them.
    */
    const first =
      t >= theirsChanges.length ||
      (m < mineChanges.length && mineChanges[m].baseStart <= theirsChanges[t].baseStart)
        ? mineChanges[m]
        : theirsChanges[t];

    let lo = first.baseStart;
    let hi = first.baseEnd;
    let nextM = m;
    let nextT = t;
    let grew = true;
    while (grew) {
      grew = false;
      const span = { baseStart: lo, baseEnd: hi, sideStart: 0, sideEnd: 0 };
      while (nextM < mineChanges.length && collides(mineChanges[nextM], span)) {
        lo = Math.min(lo, mineChanges[nextM].baseStart);
        hi = Math.max(hi, mineChanges[nextM].baseEnd);
        nextM += 1;
        grew = true;
      }
      while (nextT < theirsChanges.length && collides(theirsChanges[nextT], span)) {
        lo = Math.min(lo, theirsChanges[nextT].baseStart);
        hi = Math.max(hi, theirsChanges[nextT].baseEnd);
        nextT += 1;
        grew = true;
      }
    }

    let mineGrowth = 0;
    for (let i = m; i < nextM; i += 1) mineGrowth += spanOf(mineChanges[i]);
    let theirsGrowth = 0;
    for (let i = t; i < nextT; i += 1) theirsGrowth += spanOf(theirsChanges[i]);

    out.push(...agreed(cursor, lo));

    const baseSlice = baseLines.slice(lo, hi);
    const mineSlice = mineLines.slice(lo + mineDelta, hi + mineDelta + mineGrowth);
    const theirsSlice = theirsLines.slice(lo + theirsDelta, hi + theirsDelta + theirsGrowth);

    if (sameLines(mineSlice, baseSlice)) {
      out.push(...theirsSlice); // Only they changed it.
    } else if (sameLines(theirsSlice, baseSlice)) {
      out.push(...mineSlice); // Only I changed it.
    } else if (sameLines(mineSlice, theirsSlice)) {
      out.push(...mineSlice); // The same change, made twice. Agreement.
    } else {
      /*
        A genuine disagreement — but usually not across the whole cluster.
        Lines the two sides *do* agree on at either end are lifted out first, so
        the marked hunk is the part that actually differs rather than the whole
        paragraph around it. A hunk nobody can read is a hunk nobody resolves.
      */
      let lead = 0;
      while (
        lead < mineSlice.length &&
        lead < theirsSlice.length &&
        mineSlice[lead].text === theirsSlice[lead].text
      ) {
        lead += 1;
      }
      let trail = 0;
      while (
        trail < mineSlice.length - lead &&
        trail < theirsSlice.length - lead &&
        mineSlice[mineSlice.length - 1 - trail].text ===
          theirsSlice[theirsSlice.length - 1 - trail].text
      ) {
        trail += 1;
      }

      out.push(...mineSlice.slice(0, lead));
      conflicts += 1;
      out.push({ text: MERGE_MARKERS.mine, eol });
      out.push(...mineSlice.slice(lead, mineSlice.length - trail));
      out.push({ text: MERGE_MARKERS.split, eol });
      out.push(...theirsSlice.slice(lead, theirsSlice.length - trail));
      out.push({ text: MERGE_MARKERS.theirs, eol });
      out.push(...mineSlice.slice(mineSlice.length - trail));
    }

    cursor = hi;
    mineDelta += mineGrowth;
    theirsDelta += theirsGrowth;
    m = nextM;
    t = nextT;
  }

  out.push(...agreed(cursor, baseLines.length));

  return { text: joinLines(out, eol), conflicts };
}

/**
 * How many conflict hunks are still marked in a body.
 *
 * Read off the text rather than remembered from the merge, because the text is
 * editable: the whole point of showing a proposal is that somebody resolves the
 * hunks by hand before saving, and a count carried over from the merge would
 * still say "2 conflicts" over a body they have already cleaned up.
 */
export function markedConflicts(text: string): number {
  return splitLines(text).filter((line) => line.text === MERGE_MARKERS.mine).length;
}
