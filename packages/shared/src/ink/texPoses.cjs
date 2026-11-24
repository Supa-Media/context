/**
 * Tex doing something: the scribble Tex (`texFigure.cjs` at full chaos) with
 * its arms placed for a pose and one prop in its hands, as an SVG string.
 *
 * Drawn for the picture a note link unfurls with (Dev, 2026-11-23: "see him
 * doing different things based on the title of the note or the type of the
 * note"; `docs/decisions/privacy-and-sharing/note-link-previews.md`), and kept
 * here beside the figure so the app can draw the same poses later.
 *
 * The body, eyes and legs are the figure's own; only the arms and the prop are
 * new. Nothing here draws text: the card renderer rasterises this with no
 * system fonts, so a number or a sign is drawn as strokes.
 */

const { figureParts, CX, CY } = require("./texFigure.cjs");

/** Room around the figure for a prop held out or over its head. */
const VIEW = "-60 -20 800 780";
const LIMB = 15.6;
const q = (x0, y0, x1, y1, x2, y2) => `M${x0} ${y0} Q${x1} ${y1} ${x2} ${y2}`;

const LEGS = [q(CX - 60, CY + 175, CX - 70, CY + 230, CX - 95, CY + 285), q(CX + 60, CY + 175, CX + 70, CY + 230, CX + 95, CY + 285)];
const WAVE = q(CX + 170, CY - 40, CX + 215, CY - 100, CX + 235, CY - 165);
const DOWN = q(CX - 175, CY + 10, CX - 230, CY + 60, CX - 245, CY + 110);
const WAVE_MARKS = [`M${CX + 250} ${CY - 215} l18 -30`, `M${CX + 272} ${CY - 180} l30 -16`, `M${CX + 280} ${CY - 145} l32 -2`];

/**
 * Every pose: its arms, where its eyes look, and its prop drawn in the ink,
 * the paper (the prop's fill) and the accent.
 */
const POSES = {
  waving: { arms: [WAVE, DOWN], look: [10, 10], marks: WAVE_MARKS, prop: () => "" },
  reading: {
    arms: [q(CX - 170, CY + 60, CX - 200, CY + 150, CX - 120, CY + 190), q(CX + 170, CY + 60, CX + 200, CY + 150, CX + 120, CY + 190)],
    look: [0, 22],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX} ${CY + 200}) rotate(-4)">` +
      `<path d="M0 -10 C-60 -40 -130 -30 -165 -10 L-165 95 C-130 75 -60 70 0 100 Z" fill="${paper}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<path d="M0 -10 C60 -40 130 -30 165 -10 L165 95 C130 75 60 70 0 100 Z" fill="${paper}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<path d="M-135 15 q50 -14 100 4 M-135 42 q50 -14 100 4 M35 19 q50 -18 100 -4 M35 46 q50 -18 100 -4" stroke="${ink}" stroke-width="6" fill="none" stroke-linecap="round" opacity=".55"/>` +
      `<path d="M0 -6 L0 96" stroke="${ink}" stroke-width="8"/>` +
      `<path d="M60 -26 L60 40 L74 28 L88 40 L88 -30" fill="${accent}"/></g>`,
  },
  checklist: {
    arms: [q(CX + 170, CY + 20, CX + 220, CY + 70, CX + 255, CY + 60), DOWN],
    look: [22, 6],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX + 300} ${CY - 20}) rotate(8)">` +
      `<rect x="-70" y="-120" width="150" height="200" rx="14" fill="${paper}" stroke="${ink}" stroke-width="12"/>` +
      `<rect x="-28" y="-138" width="66" height="34" rx="8" fill="${ink}"/>` +
      `<path d="M-44 -62 l14 14 l24 -30 M-44 -8 l14 14 l24 -30" stroke="${accent}" stroke-width="11" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<rect x="-44" y="34" width="22" height="22" rx="4" fill="none" stroke="${ink}" stroke-width="7"/>` +
      `<path d="M4 -58 h50 M4 -4 h50 M4 46 h50" stroke="${ink}" stroke-width="8" stroke-linecap="round"/></g>`,
  },
  coffee: {
    arms: [q(CX + 170, CY + 30, CX + 230, CY + 60, CX + 250, CY + 10), DOWN],
    look: [16, 0],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX + 285} ${CY - 30}) scale(1.5)">` +
      `<path d="M-50 -50 L50 -50 L42 50 Q40 66 24 66 L-24 66 Q-40 66 -42 50 Z" fill="${paper}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<path d="M50 -30 q40 0 36 32 q-4 28 -40 26" fill="none" stroke="${ink}" stroke-width="12" stroke-linecap="round"/>` +
      `<rect x="-44" y="-12" width="88" height="26" fill="${accent}"/>` +
      `<path d="M-20 -78 q-14 -22 0 -44 q14 -22 0 -44 M14 -78 q-14 -22 0 -44 q14 -22 0 -44" stroke="${ink}" stroke-width="8" fill="none" stroke-linecap="round" opacity=".5"/></g>`,
  },
  idea: {
    arms: [q(CX + 170, CY - 40, CX + 205, CY - 120, CX + 190, CY - 205), DOWN],
    look: [12, -22],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX + 10} ${CY - 300})">` +
      `<path d="M0 -80 C55 -80 82 -40 78 0 C74 30 46 46 40 74 L-40 74 C-46 46 -74 30 -78 0 C-82 -40 -55 -80 0 -80 Z" fill="${accent}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<rect x="-36" y="74" width="72" height="34" rx="8" fill="${paper}" stroke="${ink}" stroke-width="10"/>` +
      `<path d="M-18 10 l18 28 l18 -28" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M-120 -40 l-34 -14 M120 -40 l34 -14 M-110 30 l-36 6 M110 30 l36 6 M0 -110 l0 -34" stroke="${ink}" stroke-width="10" stroke-linecap="round"/></g>`,
  },
  trip: {
    arms: [WAVE, q(CX - 175, CY + 10, CX - 225, CY + 80, CX - 230, CY + 150)],
    look: [10, 10],
    marks: WAVE_MARKS,
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX - 240} ${CY + 250})">` +
      `<path d="M-30 -98 L-30 -122 Q-30 -132 -20 -132 L20 -132 Q30 -132 30 -122 L30 -98" fill="none" stroke="${ink}" stroke-width="11"/>` +
      `<rect x="-95" y="-100" width="190" height="150" rx="20" fill="${accent}" stroke="${ink}" stroke-width="12"/>` +
      `<path d="M-50 -100 L-50 50 M50 -100 L50 50" stroke="${ink}" stroke-width="9"/>` +
      `<circle cx="-62" cy="64" r="12" fill="${ink}"/><circle cx="62" cy="64" r="12" fill="${ink}"/></g>`,
  },
  painting: {
    arms: [q(CX + 170, CY + 10, CX + 220, CY + 30, CX + 250, CY - 10), DOWN],
    look: [22, 0],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX + 300} ${CY - 30}) rotate(-14)">` +
      `<path d="M-110 0 C-110 -80 0 -110 70 -80 C130 -55 120 10 70 10 C30 10 40 60 0 70 C-60 85 -110 50 -110 0 Z" fill="${paper}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<circle cx="-60" cy="-30" r="20" fill="${accent}"/><circle cx="-5" cy="-60" r="20" fill="${ink}"/><circle cx="55" cy="-45" r="20" fill="${accent}" opacity=".55"/><circle cx="-60" cy="30" r="20" fill="${ink}" opacity=".55"/>` +
      `<circle cx="10" cy="15" r="18" fill="none" stroke="${ink}" stroke-width="9"/></g>`,
  },
  calendar: {
    arms: [q(CX + 170, CY + 10, CX + 240, CY - 20, CX + 250, CY - 90), DOWN],
    look: [20, -8],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX + 300} ${CY - 170}) rotate(10)">` +
      `<rect x="-85" y="-80" width="170" height="160" rx="16" fill="${paper}" stroke="${ink}" stroke-width="12"/>` +
      `<path d="M-85 -64 Q-85 -80 -69 -80 L69 -80 Q85 -80 85 -64 L85 -30 L-85 -30 Z" fill="${accent}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<path d="M-40 -100 L-40 -62 M40 -100 L40 -62" stroke="${ink}" stroke-width="12" stroke-linecap="round"/>` +
      // A month's days as dots, one of them ringed: the date.
      [-50, 0, 50].flatMap((x) => [5, 50].map((y) => `<circle cx="${x}" cy="${y}" r="9" fill="${ink}"/>`)).join("") +
      `<circle cx="0" cy="50" r="24" fill="none" stroke="${accent}" stroke-width="9"/></g>`,
  },
  money: {
    arms: [q(CX + 170, CY + 20, CX + 220, CY + 60, CX + 245, CY + 20), DOWN],
    look: [20, 4],
    prop: (ink, paper) =>
      `<g transform="translate(${CX + 300} ${CY - 30}) rotate(-12)">` +
      `<rect x="-120" y="-60" width="230" height="120" rx="14" fill="${paper}" stroke="${ink}" stroke-width="12" transform="rotate(-10) translate(10 -30)"/>` +
      `<rect x="-115" y="-60" width="230" height="120" rx="14" fill="${paper}" stroke="${ink}" stroke-width="12"/>` +
      `<circle r="38" fill="none" stroke="${ink}" stroke-width="10"/>` +
      // A dollar sign in strokes.
      `<path d="M14 -16 C10 -24 -14 -26 -16 -12 C-18 2 16 0 16 14 C14 28 -12 28 -16 18 M0 -30 L0 30" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round"/></g>`,
  },
  cooking: {
    arms: [q(CX + 170, CY + 20, CX + 230, CY + 20, CX + 250, CY - 60), DOWN],
    look: [10, 4],
    prop: (ink, paper, accent) =>
      `<g transform="translate(${CX - 5} ${CY - 215})">` +
      `<path d="M-80 0 C-140 -10 -140 -100 -70 -95 C-60 -150 30 -160 50 -110 C120 -140 160 -40 85 0 Z" fill="${paper}" stroke="${ink}" stroke-width="12" stroke-linejoin="round"/>` +
      `<rect x="-82" y="-6" width="166" height="44" rx="6" fill="${paper}" stroke="${ink}" stroke-width="12"/></g>` +
      `<g transform="translate(${CX + 262} ${CY - 90}) rotate(18)">` +
      `<rect x="-8" y="0" width="16" height="140" rx="8" fill="${ink}"/>` +
      `<ellipse cx="0" cy="-36" rx="30" ry="44" fill="${accent}" stroke="${ink}" stroke-width="10"/></g>`,
  },
};

const POSE_NAMES = Object.freeze(Object.keys(POSES));

/** Tex in `pose`, as a standalone SVG document. An unknown pose throws: a caller picks from `POSE_NAMES`. */
function texPoseSvg(pose, { ink = "#2A45CF", eye = "#FBFAF6", paper = "#FBFAF6", accent = "#2F7BF5" } = {}) {
  const p = POSES[pose];
  if (p === undefined) throw new Error(`no Tex pose "${pose}"`);
  const parts = figureParts(100, { small: false });
  const g = parts.googly;
  const strands = parts.strands
    .map(
      (s) =>
        `<path d="${s.d}" stroke="${ink}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${s.dry}" stroke="${ink}" stroke-width="${s.width * 0.45}" fill="none" stroke-linecap="round" opacity=".7"/>`,
    )
    .join("");
  const limbs = [...LEGS, ...p.arms].map((d) => `<path d="${d}" stroke="${ink}" stroke-width="${LIMB}" fill="none" stroke-linecap="round"/>`).join("");
  const marks = (p.marks || []).map((d) => `<path d="${d}" stroke="${ink}" stroke-width="9" stroke-linecap="round" opacity=".9"/>`).join("");
  const [lx, ly] = p.look;
  const eyes =
    `<g transform="translate(${g.x} ${g.y}) scale(${g.scale})">` +
    g.whites.map((w) => `<ellipse cx="${w.cx}" cy="${w.cy}" rx="${w.rx}" ry="${w.ry}" fill="${eye}" stroke="${ink}" stroke-width="${g.outline}"/>`).join("") +
    `<circle cx="${-52 + lx}" cy="${ly}" r="17" fill="${ink}"/><circle cx="${50 + lx * 0.8}" cy="${4 + ly}" r="14" fill="${ink}"/></g>`;
  // The prop sits in front of the body and behind the arms that hold it.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}">${strands}${eyes}${p.prop(ink, paper, accent)}${limbs}${marks}</svg>`;
}

/**
 * The app icon's # on its rounded tile, as `apps/mobile/assets/source/tex-mark.mjs`
 * draws `favicon.svg` (Tex at rest, heavier strokes for reading small), in any
 * ground and ink, for a card that shows the # instead of Tex.
 */
function hashTileSvg({ ground = "#EDE4D3", ink = "#2A45CF" } = {}) {
  const px = 256;
  const half = 204;
  const pad = 0.12;
  const heavier = 16;
  const scale = px / ((half * 2) / (1 - 2 * pad));
  const at = (n) => +n.toFixed(2);
  const strokes = figureParts(0, { small: false })
    .strands.map((s) => `<path d="${s.d}" stroke-width="${at(s.width + heavier)}"/><path d="${s.dry}" stroke-width="${at((s.width + heavier) * 0.45)}" opacity="0.7"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<rect width="${px}" height="${px}" rx="${at(0.22 * px)}" fill="${ground}"/>` +
    `<g transform="translate(${at(px / 2 - CX * scale)} ${at(px / 2 - CY * scale)}) scale(${+scale.toFixed(5)})">` +
    `<g fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">${strokes}</g></g></svg>`
  );
}

module.exports = { texPoseSvg, hashTileSvg, POSE_NAMES };
