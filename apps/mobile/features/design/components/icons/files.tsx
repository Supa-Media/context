import { bar, dot, rect, ring, type DrawFn } from "./primitives";

type FilesIconName =
  | "folder"
  | "file"
  | "copy"
  | "clock"
  | "attach"
  | "tag"
  | "link"
  | "book"
  | "drive"
  | "trash";

/** Files, folders, links and attachments — the vault's own objects. */
export const filesIcons: Record<FilesIconName, DrawFn> = {
  folder: (u, w, c) => [
    // The tab, drawn as a bar so the body's rounded top-left corner is not
    // fighting a second rounded corner two points above it.
    bar("tab", u, w, c, { cx: 0.28, cy: 0.24, length: 0.26 }),
    rect("body", u, w, c, { x0: 0.12, y0: 0.24, x1: 0.88, y1: 0.8, radius: 0.12 }),
  ],

  file: (u, w, c) => {
    /*
      Three rules of decreasing length, not two centred ones. Two lines
      centred in a tall rounded rectangle is a battery, which is what the
      first draft of this drew — a document is recognised by its *ragged*
      right edge, so the last rule is short and they sit above centre rather
      than around it.
    */
    return [
      rect("body", u, w, c, { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, radius: 0.11 }),
      bar("l1", u, w, c, { cx: 0.5, cy: 0.36, length: 0.3 }),
      bar("l2", u, w, c, { cx: 0.5, cy: 0.52, length: 0.3 }),
      bar("l3", u, w, c, { cx: 0.42, cy: 0.68, length: 0.14 }),
    ];
  },

  trash: (u, w, c) => [
    /*
      Added for the delete control on a row somebody typed and wants gone —
      a folder name, an invitee — which was a word ("Remove") where every
      platform draws a bin. A lid, its handle, and a body with two ribs: the
      ribs are what separate it from `file` at 16pt, where an empty rounded
      box is just a box.
    */
    bar("lid", u, w, c, { cx: 0.5, cy: 0.24, length: 0.64 }),
    bar("handle", u, w, c, { cx: 0.5, cy: 0.13, length: 0.2 }),
    rect("body", u, w, c, { x0: 0.24, y0: 0.32, x1: 0.76, y1: 0.9, radius: 0.1 }),
    bar("rib1", u, w, c, { cx: 0.42, cy: 0.61, length: 0.28, angle: 90 }),
    bar("rib2", u, w, c, { cx: 0.58, cy: 0.61, length: 0.28, angle: 90 }),
  ],

  copy: (u, w, c) => {
    /*
      Two full outlines rather than a front sheet and a partial back one. The
      partial version needs a path with a corner cut out of it, and this set
      draws from rounded rectangles and bars — see the header. Fully
      overlapped, the offset pair still reads as one sheet over another,
      which is the whole of what the mark has to say.
    */
    return [
      rect("back", u, w, c, { x0: 0.12, y0: 0.12, x1: 0.66, y1: 0.66, radius: 0.11 }),
      rect("front", u, w, c, { x0: 0.34, y0: 0.34, x1: 0.88, y1: 0.88, radius: 0.11 }),
    ];
  },

  clock: (u, w, c) => {
    /*
      Hands at 3:00 — the one setting where neither hand lies along the
      other, so both are readable at 20pt, and the one every platform's clock
      glyph settles on for the same reason. Each hand is a bar centred on its
      own midpoint (see `bar`), so the arithmetic is "half its length out from
      the middle of the face" rather than an endpoint.
    */
    return [
      ring("face", u, w, c, { cx: 0.5, cy: 0.5, r: 0.37 }),
      bar("minute", u, w, c, { cx: 0.5, cy: 0.39, length: 0.22, angle: 90 }),
      bar("hour", u, w, c, { cx: 0.58, cy: 0.5, length: 0.16 }),
    ];
  },

  attach: (u, w, c) => {
    /*
      Two nested capsules, not a clip's actual path, which doubles back on
      itself three times and is unreadable below about 28pt anyway. The
      outer one is wider than a paperclip really is because the gap between
      the two outlines has to survive a 2pt stroke at 20pt: any narrower and
      the inner capsule's hole closes up and the mark reads as a filled pill.
    */
    return [
      rect("outer", u, w, c, { x0: 0.16, y0: 0.06, x1: 0.84, y1: 0.94, radius: 0.34 }),
      rect("inner", u, w, c, { x0: 0.36, y0: 0.24, x1: 0.64, y1: 0.7, radius: 0.14 }),
    ];
  },

  tag: (u, w, c) => {
    /*
      A luggage tag rather than Obsidian's diamond: the same shape turned
      45°, which `rect` cannot do, so it is drawn upright from its five
      edges. The eyelet sits at the flat end, where a tag's hole is, and the
      point is the end that would carry the string.
    */
    return [
      bar("flat", u, w, c, { cx: 0.26, cy: 0.5, length: 0.48, angle: 90 }),
      bar("top", u, w, c, { cx: 0.48, cy: 0.26, length: 0.44 }),
      bar("bottom", u, w, c, { cx: 0.48, cy: 0.74, length: 0.44 }),
      bar("p1", u, w, c, { cx: 0.8, cy: 0.38, length: 0.31, angle: 50 }),
      bar("p2", u, w, c, { cx: 0.8, cy: 0.62, length: 0.31, angle: -50 }),
      dot("eyelet", u, c, { cx: 0.42, cy: 0.5, r: 0.075 }),
    ];
  },

  link: (u, w, c) => [
    // Two capsule rings, offset diagonally so they interlock — the
    // ordinary chain-link mark, and distinct from `attach`'s nested pair
    // (one ring *inside* the other) by overlapping instead.
    rect("a", u, w, c, { x0: 0.08, y0: 0.08, x1: 0.62, y1: 0.46, radius: 0.19 }),
    rect("b", u, w, c, { x0: 0.38, y0: 0.54, x1: 0.92, y1: 0.92, radius: 0.19 }),
  ],

  book: (u, w, c) => [
    rect("left", u, w, c, { x0: 0.08, y0: 0.2, x1: 0.48, y1: 0.82, radius: 0.1 }),
    rect("right", u, w, c, { x0: 0.52, y0: 0.2, x1: 0.92, y1: 0.82, radius: 0.1 }),
    bar("spine", u, w, c, { cx: 0.5, cy: 0.51, length: 0.62, angle: 90 }),
  ],

  drive: (u, w, c) => {
    /*
      Two separate bays, not one box with a rule through it.

      The first draft was exactly that, and beside `card` two rows down it
      was a credit card with a line on it — same outline, same radius, same
      proportions. Two stacked outlines is a rack, and a rack cannot be
      mistaken for a card at any size.
    */
    return [
      rect("bayTop", u, w, c, { x0: 0.1, y0: 0.18, x1: 0.9, y1: 0.46, radius: 0.09 }),
      dot("ledTop", u, c, { cx: 0.76, cy: 0.32, r: 0.055 }),
      rect("bayBottom", u, w, c, { x0: 0.1, y0: 0.54, x1: 0.9, y1: 0.82, radius: 0.09 }),
      dot("ledBottom", u, c, { cx: 0.76, cy: 0.68, r: 0.055 }),
    ];
  },
};
