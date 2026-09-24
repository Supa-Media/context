import { bar, chevron, dot, glyph, rect, type DrawFn } from "./primitives";

type EditorIconName =
  | "undo"
  | "redo"
  | "brackets"
  | "bulletList"
  | "heading"
  | "bold"
  | "italic"
  | "keyboardHide"
  | "eye"
  | "pencil";

/**
 * The eye's geometry, named rather than inlined, because `icons.test.ts`
 * checks the shape these produce and the arc radius is derived from the other
 * two. A literal there and a literal here is how the drawing and its guard
 * drift apart.
 *
 * 0.88 wide over 0.56 tall — a little over 11:7, which is the ratio an eye is
 * drawn at everywhere. Taller is a leaf, flatter is a lens. Not wider: the
 * stroke is centred on the outline, so half of it hangs past the canthus, and
 * `icons.test.ts` holds the whole drawing inside the box at every size.
 */
const EYE_HALF_WIDTH = 0.44;
/** How far each lid bows from the midline. Both lids share `y = 0.5`. */
const EYE_SAGITTA = 0.28;
/**
 * The iris, at 59% of the eye's height.
 *
 * Large enough to nearly fill the almond, which is what stops the mark reading
 * as a lens or a leaf at 17pt — the lids have to hold their weight out to the
 * canthi to contain something this size, which is the whole reason this icon
 * is a path.
 */
const EYE_IRIS = 0.165;
/**
 * The radius of the circle both lids are arcs of, from the chord and the
 * sagitta. Deriving it is what makes the two lids arcs of *one* circle, so
 * they meet at the same angle at both canthi.
 */
const EYE_ARC = (EYE_HALF_WIDTH * EYE_HALF_WIDTH + EYE_SAGITTA * EYE_SAGITTA) / (2 * EYE_SAGITTA);

/**
 * The pencil, as the five points of its outline plus the collar.
 *
 * Laid out along the box's leading diagonal from a point at the bottom left:
 * `along` walks up the barrel, `across` steps out to each side of it. Built
 * from the direction vectors rather than from five literal coordinates so the
 * barrel is the same width along its whole length by construction — by hand,
 * it is five numbers that have to agree and eventually will not.
 */
const PENCIL = (() => {
  const tip = { x: 0.17, y: 0.83 };
  const along = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  const across = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  /** Half the barrel's width: 0.23 across, which keeps it open at 17pt. */
  const half = 0.115;
  const at = (t: number) => ({ x: tip.x + t * along.x, y: tip.y + t * along.y });
  const offset = (from: { x: number; y: number }, side: number) => ({
    x: from.x + side * half * across.x,
    y: from.y + side * half * across.y,
  });
  // Where the lead stops and the barrel starts, and the blunt end.
  const collar = at(0.26);
  const end = at(0.82);
  return {
    tip,
    collarA: offset(collar, 1),
    collarB: offset(collar, -1),
    endA: offset(end, 1),
    endB: offset(end, -1),
  };
})();

const point = ({ x, y }: { x: number; y: number }) => `${x} ${y}`;

/** The accessory bar and the note toolbar's read/edit toggle. */
export const editorIcons: Record<EditorIconName, DrawFn> = {
  /*
    Undo and redo share an arch — three chords of one circle, which is as
    much of an arc as a set drawn from rectangles gets — and differ only in
    which end carries the head. That is deliberate rather than lazy: a pair
    of icons that differ in their *whole* shape read as two unrelated marks,
    and a pair that differ in one end read as a direction, which is what
    these two are. The head is a quarter of the box wide so the difference
    survives the 20pt the accessory bar draws them at.
  */
  undo: (u, w, c) => [
    bar("a1", u, w, c, { cx: 0.29, cy: 0.5, length: 0.28, angle: -60 }),
    bar("a2", u, w, c, { cx: 0.5, cy: 0.38, length: 0.28 }),
    bar("a3", u, w, c, { cx: 0.71, cy: 0.5, length: 0.28, angle: 60 }),
    chevron("head", u, w, c, { cx: 0.24, cy: 0.6, side: 0.28, angle: 180 }),
  ],
  redo: (u, w, c) => [
    bar("a1", u, w, c, { cx: 0.29, cy: 0.5, length: 0.28, angle: -60 }),
    bar("a2", u, w, c, { cx: 0.5, cy: 0.38, length: 0.28 }),
    bar("a3", u, w, c, { cx: 0.71, cy: 0.5, length: 0.28, angle: 60 }),
    chevron("head", u, w, c, { cx: 0.76, cy: 0.6, side: 0.28, angle: 90 }),
  ],

  brackets: (u, w, c) => {
    /*
      A stem plus two serifs each, rather than a `rect` with its middle
      hidden. The stems are 0.58 tall and not 0.7 because a bar is laid out
      horizontally and turned afterwards — its *declared* box is the
      horizontal one, so a vertical stroke at x is bounded by twice its
      distance from the nearer edge, and a taller pair would hang outside
      the box on paper even though it draws inside it.
    */
    return [
      bar("ls", u, w, c, { cx: 0.3, cy: 0.5, length: 0.58, angle: 90 }),
      bar("lt", u, w, c, { cx: 0.37, cy: 0.22, length: 0.14 }),
      bar("lb", u, w, c, { cx: 0.37, cy: 0.78, length: 0.14 }),
      bar("rs", u, w, c, { cx: 0.7, cy: 0.5, length: 0.58, angle: 90 }),
      bar("rt", u, w, c, { cx: 0.63, cy: 0.22, length: 0.14 }),
      bar("rb", u, w, c, { cx: 0.63, cy: 0.78, length: 0.14 }),
    ];
  },

  // Three dots and three rules at one length each — unlike `sort`'s
  // descending stack, a list's rows do not get shorter, and drawing them
  // that way here would say "sorted" rather than "list".
  bulletList: (u, w, c) => [
    dot("d1", u, c, { cx: 0.18, cy: 0.26, r: 0.055 }),
    bar("l1", u, w, c, { cx: 0.6, cy: 0.26, length: 0.56 }),
    dot("d2", u, c, { cx: 0.18, cy: 0.5, r: 0.055 }),
    bar("l2", u, w, c, { cx: 0.6, cy: 0.5, length: 0.56 }),
    dot("d3", u, c, { cx: 0.18, cy: 0.74, r: 0.055 }),
    bar("l3", u, w, c, { cx: 0.6, cy: 0.74, length: 0.56 }),
  ],

  heading: (u, w, c) => [
    bar("left", u, w, c, { cx: 0.3, cy: 0.5, length: 0.58, angle: 90 }),
    bar("right", u, w, c, { cx: 0.7, cy: 0.5, length: 0.58, angle: 90 }),
    bar("cross", u, w, c, { cx: 0.5, cy: 0.5, length: 0.4 }),
  ],

  bold: (u, w, c) => {
    /*
      The two bowls overlap by exactly one stroke at the waist — the upper
      one's bottom edge and the lower one's top edge are the same band —
      because two rectangles merely stacked draw their shared line twice and
      a "B" with a middle bar at double weight is a "B" that has been sat on.
    */
    return [
      bar("stem", u, w, c, { cx: 0.31, cy: 0.5, length: 0.58, angle: 90 }),
      rect("upper", u, w, c, { x0: 0.27, y0: 0.21, x1: 0.62, y1: 0.5 + w / u / 2, radius: 0.1 }),
      rect("lower", u, w, c, { x0: 0.27, y0: 0.5 - w / u / 2, x1: 0.7, y1: 0.79, radius: 0.1 }),
    ];
  },

  italic: (u, w, c) => [
    bar("slant", u, w, c, { cx: 0.5, cy: 0.5, length: 0.62, angle: -70 }),
    bar("top", u, w, c, { cx: 0.6, cy: 0.24, length: 0.26 }),
    bar("bottom", u, w, c, { cx: 0.4, cy: 0.76, length: 0.26 }),
  ],

  keyboardHide: (u, w, c) => {
    /*
      A keyboard with a chevron *under* it rather than a keyboard alone: the
      key it stands for dismisses the keyboard, and a bare keyboard is the
      mark for summoning one. The lower row is a bar rather than three more
      dots, which is the space bar and is what stops the interior reading as
      a die face.
    */
    return [
      rect("body", u, w, c, { x0: 0.08, y0: 0.14, x1: 0.92, y1: 0.6, radius: 0.12 }),
      dot("k1", u, c, { cx: 0.26, cy: 0.3, r: 0.05 }),
      dot("k2", u, c, { cx: 0.5, cy: 0.3, r: 0.05 }),
      dot("k3", u, c, { cx: 0.74, cy: 0.3, r: 0.05 }),
      bar("space", u, w, c, { cx: 0.5, cy: 0.46, length: 0.34 }),
      chevron("head", u, w, c, { cx: 0.5, cy: 0.78, side: 0.26, angle: 135 }),
    ];
  },

  eye: (u, w, c) => {
    /*
      An almond, and an iris inside it.

      One closed path: two arcs of the same circle, running left to right and
      back again. Both start and end at `y = 0.5`, so the outline closes in a
      point at each canthus — a gap of even a hundredth reads at 20pt as a
      broken outline rather than as a soft corner, and `Z` makes the gap
      impossible rather than merely small.

      `sweep = 1` on both: the first goes over the top, and the second, now
      travelling right to left, goes under the bottom. The same flag, because
      it is measured against the direction of travel and the direction has
      reversed.
    */
    const left = 0.5 - EYE_HALF_WIDTH;
    const right = 0.5 + EYE_HALF_WIDTH;
    const arc = `A ${EYE_ARC} ${EYE_ARC} 0 0 1`;
    return glyph("eye", u, w, c, {
      paths: [`M ${left} 0.5 ${arc} ${right} 0.5 ${arc} ${left} 0.5 Z`],
      circles: [{ cx: 0.5, cy: 0.5, r: EYE_IRIS }],
    });
  },

  pencil: (u, w, c) => {
    /*
      The barrel as one closed path, and the collar as a second.

      Two paths rather than one: the collar is a line *across* the barrel, and
      a single path would have to travel back along the shoulder to reach it,
      drawing that edge twice at double weight where they overlap.

      The outline runs tip → collar → blunt end → collar → back to the tip, so
      both lead edges are drawn by the same closed loop and meet at the point
      by construction.
    */
    return glyph("pencil", u, w, c, {
      paths: [
        `M ${point(PENCIL.tip)} L ${point(PENCIL.collarA)} L ${point(PENCIL.endA)}` +
          ` L ${point(PENCIL.endB)} L ${point(PENCIL.collarB)} Z`,
        `M ${point(PENCIL.collarA)} L ${point(PENCIL.collarB)}`,
      ],
    });
  },
};
