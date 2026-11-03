/**
 * Tex's geometry: the googly-eyed paper-ink scribble that untangles into the
 * app icon's # as a workspace calms down. Every Tex in the product, the app's
 * chaos score and the homepage's mascot alike, is drawn from here.
 *
 * The owner's pick (2026-10-10), ported faithfully from the board it was
 * chosen on (`texting-assistant-boards/mascots-v7-googly-dots/source/
 * paper3.html`, its `figure()`, `scribble`, `catmull` and `hashStrokes`): the
 * same seeded scribble, split into four strands that each ease onto one
 * stroke of the #, thickening as they go, with a dry second pass beside each.
 * Legs, a waving arm and motion marks fade out on the way.
 *
 * Drawn as Tex was approved on the homepage preview (Dev, 2026-10-11): a
 * heavier brush that thickens less on its way to the #, and googly eyes that
 * stay on even when everything is sorted. The app's chaos score first drew a
 * thinner variant that swapped its eyes for two dots at 0; Dev2 asked
 * (2026-10-12) for the app to use the real Tex, so there is one drawing now.
 *
 * Pure: points and path strings, no React. The app's `Tex.tsx` draws them
 * (through `apps/mobile/features/chaos/figureGeometry.ts`), and the gateway's
 * page drawings put the calm Tex in them (`./drawing.cjs`): one Tex.
 *
 * CommonJS like `../pages/`, so the gateway (plain JavaScript) and the app
 * read one copy.
 */

/** The figure's untangling, 0 the full scribble and 1 the calm # (the app's `chaosToT`, `chaosModel.ts`). */
const chaosToT = (chaos) => (Number.isFinite(chaos) ? 1 - Math.min(100, Math.max(0, chaos)) / 100 : 0);
/** Paper3's canvas: the figure is drawn about (CX, CY) in a 680 x 820 board. */
const N = 720;
const CX = 340;
const CY = 380;
/** At this size and under, the figure drops its speckles and motion marks and thickens its strokes. */
const SMALL_FIGURE = 28;
/** The part of paper3's board the figure occupies, square. Small drops the speckles' margin. */
const VIEW_BOX = { x: 30, y: 70, size: 640 };
const SMALL_VIEW_BOX = { x: 60, y: 140, size: 560 };
const rng = (seed) => {
  let s = seed;
  return () => (s = s * 16807 % 2147483647) / 2147483647;
};
const ease = (x) => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
function catmull(pts, n) {
  const out = [];
  const segs = pts.length - 3;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1) * segs;
    const s = Math.min(Math.floor(f), segs - 1);
    const u = f - s;
    const [p0, p1, p2, p3] = [pts[s], pts[s + 1], pts[s + 2], pts[s + 3]];
    const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * u + (2 * a - 5 * b + 4 * c2 - d) * u * u + (-a + 3 * b - 3 * c2 + d) * u * u * u);
    out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}
const scribbles = new Map();

/** The seeded tangle, computed once per seed and kept: every figure with that seed shares it. */
function scribble(seed, count = 64, radius = 190) {
  const cached = scribbles.get(seed);
  if (cached !== void 0) return cached;
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = radius * (0.55 + 0.45 * Math.sqrt(r()));
    pts.push([CX + d * Math.cos(a), CY + d * Math.sin(a) * 0.95]);
  }
  const line = catmull(pts, N);
  scribbles.set(seed, line);
  return line;
}
/** The app icon's # (viewBox 100), scaled up about the figure's centre. */
function hashStrokes() {
  const m = ([x, y]) => [
    CX + (x - 50) * 4.4,
    CY + (y - 50) * 4.4
  ];
  const strokes = [
    [
      [40, 7],
      [30, 93]
    ],
    [
      [70, 7],
      [60, 93]
    ],
    [
      [13, 36],
      [93, 36]
    ],
    [
      [7, 66],
      [87, 66]
    ]
  ];
  return strokes.map(([a, b]) => [m(a), m(b)]);
}
/** Where a tugging Tex has hold of its own yarn, and how far round it the tangle follows. */
const GRAB = [CX + 140, CY + 110];
const GRAB_REACH = 80;
/** Tex's brush: a stroke this wide at full chaos, `GROW` wider once it is the #. */
const TEX_WIDTH = 13;
const GROW = 16;
const LIMB_WIDTH = TEX_WIDTH * 1.2;
const EYE_OUTLINE = TEX_WIDTH * 0.9;
const pathOf = (pts) => "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L");
/**
 * Everything Tex draws at `chaos` (0 to 100).
 *
 * `small` drops the speckles and motion marks; `minStroke` (in the board's
 * units) is the thinnest any line may be, so a 20px Tex still reads.
 *
 * `tug` (0 to 1) is Tex stressed, pulling at its own yarn (Dev2, 2026-10-13,
 * for a crowded folder's page). Left out, Tex is exactly as it always was.
 */
function figureParts(chaos, {
  small,
  minStroke = 0,
  seed = 7,
  tug
}) {
  const t = chaosToT(chaos);
  const k = ease(t);
  const src = scribble(seed);
  const pull = tug === void 0 ? null : Math.min(1, Math.max(0, tug));
  const hand = [CX + 225 + 70 * (pull ?? 0), CY + 30 + 20 * (pull ?? 0)];
  // The tangle near the grabbed strand follows the hand, fading with distance.
  const stretch = (p) => {
    if (pull === null || pull === 0) return p;
    const dx = p[0] - GRAB[0];
    const dy = p[1] - GRAB[1];
    const w = Math.exp(-(dx * dx + dy * dy) / (2 * GRAB_REACH * GRAB_REACH));
    const f = 0.32 * pull * w;
    return [p[0] + (hand[0] - GRAB[0]) * f, p[1] + (hand[1] - GRAB[1]) * f];
  };
  const n4 = N / 4;
  const r = rng(seed + 100);
  const strands = hashStrokes().map(([[x0, y0], [x1, y1]], s) => {
    const strand = src.slice(s * n4, (s + 1) * n4).map((p, i) => {
      const u = i / (n4 - 1);
      const wob = 4 * Math.sin(u * 11 + s * 2);
      const tx = x0 + (x1 - x0) * u + (y0 === y1 ? 0 : wob);
      const ty = y0 + (y1 - y0) * u + (y0 === y1 ? wob : 0);
      return stretch([p[0] + (tx - p[0]) * k, p[1] + (ty - p[1]) * k]);
    });
    const w = Math.max(TEX_WIDTH + GROW * k * k * k, minStroke);
    // A dry second pass slightly offset, like a brush going over twice.
    return {
      d: pathOf(strand),
      dry: pathOf(strand.map((p) => [p[0] + 3, p[1] - 2])),
      width: w
    };
  });
  // Legs and a waving arm fade out as it becomes a #; a tugging Tex keeps them.
  const limbOpacity = pull === null ? 1 - Math.min(1, t / 0.85) : Math.max(0.85, 1 - Math.min(1, t / 0.85));
  const limbWidth = Math.max(LIMB_WIDTH, minStroke);
  const limb = (x0, y0, x1, y1, x2, y2) => ({
    d: `M${x0} ${y0} Q${x1} ${y1} ${x2} ${y2}`,
    width: limbWidth
  });
  const limbs = pull === null ? [
    limb(CX - 60, CY + 175, CX - 70, CY + 230, CX - 95, CY + 285),
    limb(CX + 60, CY + 175, CX + 70, CY + 230, CX + 95, CY + 285),
    limb(CX + 170, CY - 40, CX + 215, CY - 100, CX + 235, CY - 165),
    limb(CX - 175, CY + 10, CX - 230, CY + 60, CX - 245, CY + 110)
  ] : [
    // Feet braced apart, leaning back from the pull.
    limb(CX - 60, CY + 175, CX - 85, CY + 230, CX - 125, CY + 280),
    limb(CX + 60, CY + 175, CX + 60, CY + 230, CX + 70, CY + 288),
    // One hand hauling the strand, the other clutching its head.
    limb(CX + 165, CY - 60, (CX + 165 + hand[0]) / 2 + 10, (CY - 60 + hand[1]) / 2 - 12, hand[0], hand[1]),
    limb(CX - 175, CY + 10, CX - 255, CY - 70, CX - 150, CY - 165)
  ];
  const yarn = pull === null ? null : (() => {
    const [gx, gy] = stretch(GRAB);
    const sag = 40 * (1 - pull);
    const mx = (gx + hand[0]) / 2;
    const my = (gy + hand[1]) / 2 + sag;
    return {
      d: `M${gx.toFixed(1)} ${gy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${hand[0].toFixed(1)} ${hand[1].toFixed(1)}`,
      width: Math.max(TEX_WIDTH * 0.8, minStroke)
    };
  })();
  // Speckles of ink around the figure, drawn from the same stream paper3 used.
  const speckles = [];
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const dd = 200 + r() * 90;
    const cy = CY + 290 + r() * 20 - (i < 12 ? 0 : 300 + dd * Math.sin(a));
    speckles.push({
      cx: CX + dd * Math.cos(a),
      cy,
      r: 1 + r() * 3,
      opacity: (i < 12 ? 0.8 : 0.35) * (1 - k * 0.7)
    });
  }
  // Motion marks by the waving side; a tugging Tex has stress marks over its head instead.
  const motionOpacity = (0.4 + 0.6 * limbOpacity) * (1 - k);
  const motion = pull !== null && !small ? {
    d: [
      `M${CX - 95} ${CY - 215} l-10 -34`,
      `M${CX - 50} ${CY - 228} l2 -36`,
      `M${CX - 5} ${CY - 218} l14 -30`
    ],
    width: 9,
    opacity: 0.55 + 0.45 * pull
  } : small || motionOpacity <= 0 ? null : {
    d: [
      `M${CX + 250} ${CY - 215} l18 -30`,
      `M${CX + 272} ${CY - 180} l30 -16`,
      `M${CX + 280} ${CY - 145} l32 -2`
    ],
    width: 9,
    opacity: motionOpacity
  };
  // Googly, the pupils drifting back to centre as it calms down.
  const j = 1 - k;
  const googly = {
    x: CX,
    y: CY - 10,
    scale: 1 - 0.25 * k,
    outline: Math.max(EYE_OUTLINE, minStroke * 0.6),
    whites: [
      { cx: -52, cy: 0, rx: 44, ry: 48 },
      { cx: 50, cy: 4, rx: 36, ry: 40 }
    ],
    pupils: pull === null ? [
      { cx: -52 + 10 * j, cy: 10 * j, r: 17 },
      { cx: 50 + 8 * j, cy: 4 + 10 * j, r: 14 }
    ] : (
      // Eyes on the strand, going wide (pupils shrinking) as it tightens.
      [
        { cx: -36, cy: 14 + 4 * pull, r: 17 - 4 * pull },
        { cx: 62, cy: 18 + 4 * pull, r: 14 - 3 * pull }
      ]
    )
  };
  const box = small ? SMALL_VIEW_BOX : VIEW_BOX;
  return {
    strands,
    limbs,
    limbOpacity,
    speckles: small ? [] : speckles,
    motion,
    yarn,
    googly,
    viewBox: `${box.x} ${box.y} ${box.size} ${box.size}`
  };
}

module.exports = { figureParts, scribble, SMALL_FIGURE, VIEW_BOX, SMALL_VIEW_BOX, TEX_WIDTH, CX, CY };
