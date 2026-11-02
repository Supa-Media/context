/**
 * The landing pages' sheet (`features/landing`): the Paper card's colours
 * (the link preview, PR #1237), a warm page with ink type and one blue square
 * for a full stop. The brand-blue accent and the sign-up card stay the app's.
 */
export const lightLandingColors = {
  paper: "#EDE4D3",
  paper2: "#F6F0E4",
  hair: "#D9CFBC",
  ink: "#15171B",
  ink2: "#55534E",
  blue: "#2F7BF5",
} as const;

export type LandingColors = Readonly<
  Record<keyof typeof lightLandingColors, string>
>;

export const darkLandingColors: LandingColors = {
  paper: "#17181B",
  paper2: "#1E1F23",
  hair: "#2E2F33",
  ink: "#F1ECE3",
  ink2: "#B4ADA2",
  blue: "#4C8EF7",
};

/**
 * Tex, the mascot, wherever it is drawn: the homepage and every chaos score
 * in the app. Brand blue ink with paper-white googly eyes, as approved on the
 * homepage (Dev, 2026-10-11). Dark mode lifts the blue so it reads on a dark
 * surface; the eyes stay white, as googly eyes are.
 */
export const texColors = {
  light: { ink: "#2A45CF", eye: "#FBFAF6" },
  dark: { ink: "#8A9BF2", eye: "#FBFAF6" },
} as const;

/**
 * Page a's sheet (`NotesPage.web`), the notes page: the brand's warm Paper
 * for the page, a lighter sheet for the Tex band, and a near-white card for
 * the editor and the workspaces. Light only, as page a has been since
 * 2026-10-11 (Dev: the dark version read as a different page).
 */
export const notesLandingColors = {
  paper: "#EDE4D3",
  sheet: "#F6F0E4",
  card: "#FBF8F1",
  hair: "#D9CFBC",
  rule: "#E6DDCB",
  /** The outline of a quieter button and the empty "New workspace" slot. */
  line: "#B9AE97",
  ink: "#16181C",
  ink2: "#55534E",
  /** Small print, still over 4.5:1 on Paper. */
  ink3: "#625E57",
  blue: texColors.light.ink,
  /** Behind a blue word: someone editing, an AI's mark. */
  tint: "#E3E8FA",
  /** A sign-up problem: a number or code that did not work. */
  bad: "#9A2B1F",
  /** The example workspaces' badges, beside `tint`. */
  sage: "#CFE3D5",
  peach: "#F4D9C6",
  /** More grounds for the example people's drawn faces (`sketchFaces.web`). */
  butter: "#F3E6B8",
  lilac: "#E7D7E9",
  sky: "#D3E5EE",
} as const;

/**
 * tex.lc (`features/tex/launch`): the brand guide's colours
 * (docs/brand/README.md) on direction A's lighter page ground. Paper is the
 * guide's, behind Tex's avatar; the period blue is the one in "Context."
 */
export const texLaunchColors = {
  page: "#F2F0EA",
  paper: "#EDE4D3",
  ink: "#16181C",
  ink2: "#55534E",
  blue: texColors.light.ink,
  period: "#2F7BF5",
} as const;
