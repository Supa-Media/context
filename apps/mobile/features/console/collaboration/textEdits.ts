import type * as Y from "yjs";

export type TextEdit = { kind: "insert"; at: number; text: string } | { kind: "delete"; at: number; count: number };

/**
 * Compute an edit script against the exact text represented by a Yjs
 * snapshot. A common-prefix/suffix replacement is tempting here, but repeated
 * text and a peer insertion in the middle make that replacement delete the
 * wrong Yjs items. Myers' shortest edit script keeps the operation anchored to
 * the snapshot's item IDs when its update is applied to the live document.
 */
export function textEdits(from: string, to: string): TextEdit[] {
  if (from === to) return [];
  // Y.Text indexes strings in UTF-16 code units, but diffing individual code
  // units can split a surrogate pair (😀 -> 😎 would preserve the high half
  // and replace only the low half). Diff by code point, then convert each
  // edit's coordinate/count back to UTF-16 for Yjs.
  const allFrom = Array.from(from);
  const allTo = Array.from(to);
  /*
    **The unchanged ends are set aside before the search, not instead of it.**

    The search costs the length times the size of the edit, and keeps one
    frontier per step, so a paste of a few thousand characters held the page
    for seconds (5 KB: ~1.7 s, 10 KB: ~12 s) inside the keystroke that made
    it. Every edit a person makes touches one place, so trimming what both
    sides share at the start and at the end leaves the search only the part
    that changed, and a paste becomes one insert. The shared start is exactly
    the diagonal the search would have walked first; the shared end only
    picks, among equally short scripts, the one that keeps the text after
    the edit. Whatever is left in the middle still goes through Myers, so the
    warning above about a wholesale replacement still holds.
  */
  let head = 0;
  while (head < allFrom.length && head < allTo.length && allFrom[head] === allTo[head]) head += 1;
  let tail = 0;
  while (
    tail < allFrom.length - head &&
    tail < allTo.length - head &&
    allFrom[allFrom.length - 1 - tail] === allTo[allTo.length - 1 - tail]
  ) tail += 1;
  const offset = allFrom.slice(0, head).join("").length;
  const fromPoints = allFrom.slice(head, allFrom.length - tail);
  const toPoints = allTo.slice(head, allTo.length - tail);
  const n = fromPoints.length;
  const m = toPoints.length;
  // Only one side left: a plain insert or delete, with nothing to search.
  if (n === 0) return [{ kind: "insert", at: offset, text: toPoints.join("") }];
  if (m === 0) return [{ kind: "delete", at: offset, count: fromPoints.join("").length }];
  const max = n + m;
  let vector = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let endDepth = max;
  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(new Map(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth || (diagonal !== depth && (vector.get(diagonal - 1) ?? -1) < (vector.get(diagonal + 1) ?? -1));
      let x = down ? (vector.get(diagonal + 1) ?? 0) : (vector.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && fromPoints[x] === toPoints[y]) {
        x += 1;
        y += 1;
      }
      vector.set(diagonal, x);
      if (x >= n && y >= m) {
        endDepth = depth;
        break;
      }
    }
    if (endDepth === depth) break;
  }

  const primitive: ({ kind: "equal"; text: string } | { kind: "insert"; text: string } | { kind: "delete"; text: string })[] = [];
  let x = n;
  let y = m;
  for (let depth = endDepth; depth > 0; depth -= 1) {
    // trace[depth] is the frontier before this depth was expanded. The
    // initial frontier is trace[0], and each later entry was captured at the
    // start of that depth's iteration.
    const previous = trace[depth];
    const diagonal = x - y;
    const down = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      primitive.push({ kind: "equal", text: fromPoints[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      primitive.push({ kind: "insert", text: toPoints[previousY] ?? "" });
    } else {
      primitive.push({ kind: "delete", text: fromPoints[previousX] ?? "" });
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    primitive.push({ kind: "equal", text: fromPoints[x - 1] });
    x -= 1;
    y -= 1;
  }
  primitive.reverse();

  const edits: TextEdit[] = [];
  let at = offset;
  for (const part of primitive) {
    if (part.kind === "equal") {
      at += part.text.length;
    } else if (part.kind === "delete") {
      const previous = edits[edits.length - 1];
      if (previous?.kind === "delete" && previous.at === at) previous.count += part.text.length;
      else edits.push({ kind: "delete", at, count: part.text.length });
    } else {
      const previous = edits[edits.length - 1];
      if (previous?.kind === "insert" && previous.at === at) previous.text += part.text;
      else edits.push({ kind: "insert", at, text: part.text });
      at += part.text.length;
    }
  }
  return edits;
}

export function applyTextDiff(target: Y.Text, from: string, to: string): void {
  const edits = textEdits(from, to);
  target.doc?.transact(() => {
    // Edits are expressed in the target text's current coordinate space. The
    // script walks from left to right, so earlier inserts/deletes are already
    // reflected in the later positions.
    for (const edit of edits) {
      if (edit.kind === "delete") target.delete(edit.at, edit.count);
      else target.insert(edit.at, edit.text);
    }
  });
}
